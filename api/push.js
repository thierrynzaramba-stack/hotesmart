// api/push.js — les notifications push de l'appli hôte (PWA lots 2a et 2b).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §9.2 et §15.5 · KB : docs/kb/pwa.md §8-9
//
//   GET    /api/push                              → { pret, cle_publique, appareils,
//                                                     groupes, evenements, plages, langue }
//   POST   /api/push { action: 'abonner', abonnement, appareil }
//   POST   /api/push { action: 'essai' }          → une notification sur MES appareils
//   POST   /api/push { action: 'reglages', evenements, plages }   (lot 2b)
//   POST   /api/push { action: 'langue', langue }                 (lot 2b)
//   POST   /api/push { action: 'essai_evenement', code }          (lot 2c-1)
//   POST   /api/push { action: 'vider_ma_file' }                  (lot 2c-1)
//   POST   /api/push { action: 'contact_creer', contact }        (lot 2c-3, §16.8)
//   POST   /api/push { action: 'contact_modifier', id, contact }
//   POST   /api/push { action: 'contact_retirer' | 'contact_reinscrire' | 'contact_essai', id }
//   DELETE /api/push { endpoint } | { id }        → retirer un de MES appareils
//
// ⚠ C'EST L'ENDPOINT D'ÉCRAN DE L'ONGLET NOTIFICATIONS de `/settings` : un seul
// GET à l'ouverture, ses lectures (appareils, réglages, contacts prévenus) en
// parallèle.
//
// ⚠ LES CONTACTS PRÉVENUS (lot 2c-3) SONT CEUX DU COMPTE DE L'APPELANT, et de
// lui seul : le compte est la session, aucun identifiant de compte n'est lu
// dans la requête. Un contact d'un autre compte rend « introuvable »
// (lib/notifications/contacts.js filtre chaque lecture et chaque écriture sur
// le compte) ; chaque bien est relu sur le compte ; le jeton de désinscription
// ne sort jamais vers l'écran.
//
// ⚠ LA GARDE EST LA PERSONNE CONNECTÉE, SUR SES PROPRES APPAREILS. Aucun compte,
// aucun bien n'entre ici : un abonnement appartient à une personne, et chaque
// lecture comme chaque écriture est restreinte à `user_id = appelant`. Le
// sélecteur de compte n'y change rien (pas d'`x-compte`).
//
// ⚠ `private, no-store` AVANT LE PREMIER REFUS, 405 compris (dette 90). La clé
// publique n'est pas secrète, mais elle n'est demandée qu'au moment d'un geste,
// par quelqu'un de connecté : pas de raison d'en faire un endpoint public.
const { verifierSession, posterEnTetesPrives } = require('../lib/require-permission')
const abonnements = require('../lib/push/abonnements')
const { clesVapid, messageDeclaratif, envoyerAPersonne } = require('../lib/push/envoyer')
const reglages = require('../lib/notifications/reglages')
const catalogue = require('../lib/notifications/catalogue')
const textes = require('../lib/notifications/textes')

const MESSAGES_REFUS = {
  abonnement_absent: 'Abonnement manquant.',
  adresse_refusee: 'Ce navigateur utilise un service de notifications inconnu.',
  cle_p256dh_invalide: 'Abonnement illisible.',
  cle_auth_invalide: 'Abonnement illisible.',
  plafond_atteint: `Vous avez déjà ${abonnements.PLAFOND_APPAREILS} appareils abonnés : retirez-en un d'abord.`,
  cible_absente: 'Appareil non précisé.',
  // Lot 2b — les réglages. Les refus que seul un appel fait à la main peut
  // produire (l'écran envoie toujours un tableau complet) restent génériques.
  evenements_illisibles: 'Réglages illisibles.',
  evenement_inconnu: 'Réglages illisibles.',
  reglage_illisible: 'Réglages illisibles.',
  canal_inconnu: 'Réglages illisibles.',
  valeur_illisible: 'Réglages illisibles.',
  plages_illisibles: 'Heures calmes illisibles.',
  plage_illisible: 'Heures calmes illisibles.',
  heure_illisible: 'Une heure est mal écrite (attendu : 22:00).',
  plage_vide: 'Une plage commence et finit à la même heure.',
  jours_absents: 'Choisissez au moins un jour pour chaque plage.',
  jour_illisible: 'Un jour est illisible.',
  trop_de_plages: 'Six plages au plus.',
  aucun_moment_libre: 'Vos heures calmes couvrent toute la semaine : ce qui n’est pas urgent n’arriverait jamais. Laissez au moins un moment libre.',
  langue_inconnue: 'Langue inconnue.',
  // Lot 2c-3 — les contacts prévenus.
  contact_illisible: 'Contact illisible.',
  adresse_absente: 'Donnez un e-mail ou un numéro.',
  email_illisible: 'Cet e-mail est mal écrit.',
  telephone_illisible: 'Ce numéro est mal écrit (7 à 15 chiffres, « + » permis devant).',
  alertes_illisibles: 'Choisissez au moins une alerte.',
  biens_absents: 'Choisissez au moins un logement.',
  bien_hors_compte: 'Un logement choisi n’est pas l’un des vôtres.',
  biens_illisibles: 'Lecture impossible, réessayez.',
  plafond_contacts: 'Vous avez déjà 100 contacts : retirez-en un d’abord.',
  contact_introuvable: 'Ce contact n’existe plus. Rechargez la page.',
  contact_desinscrit: 'Ce contact s’est désinscrit : réinscrivez-le avant de lui envoyer un essai.',
  essai_deja_fait: 'Un essai est déjà parti vers cette adresse aujourd’hui. Vous pourrez recommencer demain.',
  plafond_essais: 'Dix adresses ont déjà reçu un essai aujourd’hui (un contact avec un e-mail et un numéro en compte deux). Vous pourrez recommencer demain.',
  contact_modifie_entre_temps: 'Ce contact vient d’être modifié ailleurs : rechargez la page, puis recommencez.',
  adresse_desinscrite: 'Cette adresse s’est désinscrite de vos alertes.',
  essai_non_parti: 'L’essai n’est pas parti. Vérifiez l’adresse, et pour un SMS votre compte Brevo.',
  lecture_impossible: 'Lecture impossible, réessayez.'
}

// ─── Les contacts prévenus (lot 2c-3, spec §16.8) ──────────────────────────
const contactsMod = require('../lib/notifications/contacts')
const PLAFOND_BIENS = 1000

function client () {
  return require('../lib/cron-shared').supabase
}

// Ce que l'écran montre d'un contact : jamais son jeton. `essais` : les
// adresses essayées aujourd'hui par le compte (Q37).
function contactEcran (c, essais) {
  return {
    id: c.id, nom: c.nom || null, email: c.email || null, telephone: c.telephone || null,
    biens: c.biens || [], alertes: c.alertes || [], desinscrit_le: c.desinscrit_le || null,
    essai_possible: contactsMod.essaiPossible(c, essais), cree_le: c.cree_le || null
  }
}

// Le bloc de l'écran : `null` quand l'appelant n'a aucun bien (un membre sans
// compte à lui ne le voit pas). Ses lectures en parallèle.
async function contactsDeLEcran ({ userId, db = client() }) {
  // Une panne ici ne fait tomber ni les appareils ni les réglages de l'onglet.
  try { return await lireContactsDeLEcran({ userId, db }) } catch (e) { return { ok: false } }
}

async function lireContactsDeLEcran ({ userId, db }) {
  // Chaque lecture tombe seule : une panne des contacts ne cache pas l'absence
  // de logement (constat D7).
  const enPanne = (p) => Promise.resolve().then(p).catch(() => ({ ok: false, error: true }))
  const [b, l, k, e] = await Promise.all([
    db.from('properties').select('id, name, archive_le').eq('user_id', userId).order('name').limit(PLAFOND_BIENS + 1),
    enPanne(() => contactsMod.listerContacts({ compte: userId, db })),
    // La porte Brevo, comme l'envoi la juge (api/sms.js) : une clé, et le SMS
    // pas désactivé. La clé elle-même n'est jamais lue.
    enPanne(() => db.from('api_keys').select('brevo_enabled').eq('user_id', userId).not('brevo_api_key', 'is', null).maybeSingle()),
    enPanne(() => contactsMod.essaisDuJour({ compte: userId, db }))
  ])
  if (b.error) return { ok: false }
  // ⚠ SANS LOGEMENT, PAS DE BLOC — même si les contacts sont illisibles : un
  // membre sans compte à lui ne doit pas lire une panne d'un bloc qu'il ne voit
  // jamais (constat D7 de review).
  if (!(b.data || []).length) return { ok: true, contacts: null }
  // Plus de logements que le plafond : on ne montre pas une liste coupée en
  // silence (règle 6 de la case performance).
  if (b.data.length > PLAFOND_BIENS || !l.ok) return { ok: false }
  const biens = b.data.map(p => ({ id: p.id, nom: p.name || null, archive: !!p.archive_le }))
  // Des essais illisibles : aucun essai proposé (le serveur jugerait de toute façon).
  const essais = e.ok ? e : null
  return {
    ok: true,
    contacts: {
      biens,
      liste: l.contacts.map(c => contactEcran(c, essais)),
      tronque: l.tronque,
      plafond: contactsMod.PLAFOND_CONTACTS,
      // Une lecture en panne de la porte ne ferme rien : l'écran ne fait que
      // prévenir, et l'envoi juge seul.
      brevo: k.error ? null : !!(k.data && k.data.brevo_enabled !== false)
    }
  }
}

// ⚠ LA LISTE À JOUR REVIENT AVEC CHAQUE RÉPONSE, REFUS COMPRIS (constat D5 de
// review) : après « déjà essayé », « introuvable » ou une désinscription, l'écran
// se remet d'accord avec le serveur sans recharger. Une relecture impossible le
// dit (`contacts_indisponibles`) : l'écran relit alors tout l'onglet.
async function repondreContacts (res, userId, r) {
  const lu = await contactsDeLEcran({ userId })
  const liste = lu.ok ? { contacts: lu.contacts } : { contacts_indisponibles: true }
  if (!r.ok) {
    const code = ['ecriture_impossible', 'lecture_impossible', 'biens_illisibles'].includes(r.motif) ? 503
      : r.motif === 'contact_introuvable' ? 404
        : r.motif === 'essai_non_parti' ? 502
          : ['essai_deja_fait', 'plafond_contacts', 'plafond_essais', 'adresse_desinscrite', 'contact_modifie_entre_temps'].includes(r.motif) ? 409 : 400
    return res.status(code).json({
      error: MESSAGES_REFUS[r.motif] || 'Écriture impossible, réessayez.', motif: r.motif,
      ...(r.desinscrit_le ? { desinscrit_le: r.desinscrit_le } : {}), ...liste
    })
  }
  return res.status(200).json({ ok: true, ...(r.bilan ? { bilan: r.bilan } : {}), ...liste })
}

// L'ESSAI D'UN CONTACT (Q32, Q37) : réservé d'abord, une ligne par adresse
// (une fois par jour et par adresse, dix par compte, même si le contact est
// retiré puis recréé), envoyé par le point d'envoi des contacts — e-mail avec
// son lien de désinscription, SMS par la clé Brevo du compte —, dans la langue
// du titulaire, aux SEULES adresses réservées. Rien n'est parti, ou une
// exception en route : la réservation est rendue.
async function essaiContact ({ userId, id }) {
  const r = await contactsMod.reserverEssai({ compte: userId, id })
  if (!r.ok) return r
  const c = r.contact
  let parti = { email: false, sms: false }
  try {
    const lu = await reglages.lire({ userId })
    const langue = lu.ok ? lu.reglages.langue : 'fr'
    const t = textes.essaiContact(langue)
    const { envoyerMaintenant } = require('../lib/notifications/envoi')
    const bilan = await envoyerMaintenant({
      personne: { contact: { contactId: c.id, jeton: c.jeton }, email: c.email, telephone: c.telephone },
      canaux: r.canaux, compte: userId,
      contenu: { titre: t.titre, corps: t.corps, chemin: null, sujet: `essai_contact:${c.id}`, langue }
    })
    parti = { email: !!bilan.email, sms: !!bilan.sms }
  } catch (e) { console.error('push: essai contact:', e && e.message) }
  // ⚠ CE QUI N'EST PAS PARTI EST RENDU, canal par canal (re-review, R10) : un
  // e-mail parti et un SMS refusé faute de Brevo ne consomment que l'e-mail —
  // l'hôte connecte Brevo, et réessaie le SMS le jour même.
  const nonParties = r.reserve.cles.filter(k => (k.startsWith('e:') && !parti.email) || (k.startsWith('t:') && !parti.sms))
  if (nonParties.length) {
    const rendu = await contactsMod.rendreEssai({ compte: userId, reserve: { ...r.reserve, cles: nonParties } })
    if (!rendu.ok) console.error('push: essai contact non rendu')
  }
  if (!parti.email && !parti.sms) return { ok: false, motif: 'essai_non_parti' }
  return { ok: true, bilan: parti }
}

// Le catalogue fusionné avec les réglages de la personne, dans l'ordre de l'écran.
function tableauDe (eff) {
  return catalogue.EVENEMENTS.map(e => ({
    code: e.code, libelle: e.libelle, groupe: e.groupe, ...eff.evenements[e.code]
  }))
}

function refusReglages (res, r) {
  const code = r.motif === 'ecriture_impossible' ? 503 : 400
  const corps = { error: MESSAGES_REFUS[r.motif] || 'Écriture impossible, réessayez.', motif: r.motif }
  if (Number.isInteger(r.rang)) corps.rang = r.rang
  return res.status(code).json(corps)
}

function corpsDe (req) {
  const b = req.body
  if (b && typeof b === 'object') return b
  if (typeof b === 'string' && b) { try { return JSON.parse(b) } catch { return {} } }
  return {}
}

module.exports = async function handler (req, res) {
  posterEnTetesPrives(res)
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE')
    return res.status(405).json({ error: 'methode non autorisee' })
  }
  const userId = await verifierSession(req, res)
  if (!userId) return

  const cles = clesVapid()

  try {
    if (req.method === 'GET') {
      const [r, g, k] = await Promise.all([abonnements.lister({ userId }), reglages.lire({ userId }), contactsDeLEcran({ userId })])
      if (!r.ok) return res.status(503).json({ error: 'Lecture impossible, réessayez.' })
      const corps = {
        pret: !!cles, cle_publique: cles ? cles.publique : null, appareils: r.appareils,
        // Des contacts illisibles ne font tomber ni les appareils ni les réglages.
        ...(k.ok ? { contacts: k.contacts } : { contacts_indisponibles: true })
      }
      // ⚠ DES RÉGLAGES ILLISIBLES NE FONT PAS TOMBER LES APPAREILS (constat de
      // review) : la gestion des appareils du lot 2a reste servie, et l'écran dit
      // que les réglages sont indisponibles.
      if (!g.ok) return res.status(200).json({ ...corps, reglages_indisponibles: true })
      return res.status(200).json({
        ...corps,
        groupes: catalogue.GROUPES,
        evenements: tableauDe(g.reglages),
        plages: g.reglages.plages,
        langue: g.reglages.langue
      })
    }

    const corps = corpsDe(req)

    if (req.method === 'DELETE') {
      const r = await abonnements.retirer({ userId, endpoint: corps.endpoint || null, id: corps.id || null })
      if (!r.ok) return res.status(r.motif === 'cible_absente' ? 400 : 503).json({ error: MESSAGES_REFUS[r.motif] || 'Écriture impossible, réessayez.' })
      return res.status(200).json({ ok: true })
    }

    // POST — les réglages d'abord : ils ne dépendent pas des clés d'envoi (une
    // personne règle ses heures même si les notifications ne sont pas prêtes).
    if (corps.action === 'reglages') {
      const r = await reglages.enregistrer({ userId, evenements: corps.evenements, plages: corps.plages })
      if (!r.ok) return refusReglages(res, r)
      return res.status(200).json({ ok: true, evenements: tableauDe(r.reglages), plages: r.reglages.plages })
    }

    if (corps.action === 'langue') {
      const r = await reglages.enregistrerLangue({ userId, langue: corps.langue })
      if (!r.ok) return refusReglages(res, r)
      return res.status(200).json({ ok: true, langue: r.langue })
    }

    // LOT 2c-1 — ÉPROUVER LA CHAÎNE SUR SOI-MÊME : un événement d'essai (logement
    // fictif, titre « Essai — ») passe par le point d'envoi unique, AVEC les
    // réglages et les heures calmes de l'appelant, et ne va qu'à LUI — jamais à
    // un autre membre de son compte (`seulement`).
    if (corps.action === 'essai_evenement') {
      const donnees = textes.exemple(corps.code)
      if (!donnees) return res.status(400).json({ error: 'Pas d’essai pour cet événement.', motif: 'essai_inconnu' })
      const { notifier } = require('../lib/notifications/notifier')
      // ⚠ LA NOTIFICATION SEULE : ni e-mail plateforme ni SMS. L'e-mail du
      // profil se réécrit librement (policy `profiles_write`) : un essai par
      // e-mail répété serait un relais illimité vers n'importe quelle adresse
      // (constat de SÉCURITÉ de review ; même classe que api/alert-test.js).
      const bilan = await notifier({
        compte: userId, code: corps.code, donnees, seulement: userId, canauxPermis: ['push'],
        chemin: '/settings?onglet=notifications', sujet: `essai:${corps.code}`
      })
      if (!bilan.ok) return res.status(503).json({ error: 'Essai impossible, réessayez.', bilan })
      return res.status(200).json({ ok: true, bilan })
    }

    // LOT 2c-3 — LES CONTACTS PRÉVENUS. Le compte est TOUJOURS l'appelant.
    // `confirme` : le titulaire a vu « cette adresse s'est désinscrite » et
    // choisi de lui renvoyer ses alertes (Q36).
    if (corps.action === 'contact_creer') {
      return repondreContacts(res, userId, await contactsMod.ajouterContact({ compte: userId, contact: corps.contact, confirme: corps.confirme === true }))
    }
    if (corps.action === 'contact_modifier') {
      return repondreContacts(res, userId, await contactsMod.modifierContact({ compte: userId, id: corps.id, contact: corps.contact, confirme: corps.confirme === true }))
    }
    if (corps.action === 'contact_retirer') {
      return repondreContacts(res, userId, await contactsMod.retirerContact({ compte: userId, id: corps.id }))
    }
    if (corps.action === 'contact_reinscrire') {
      return repondreContacts(res, userId, await contactsMod.reinscrireContact({ compte: userId, id: corps.id }))
    }
    if (corps.action === 'contact_essai') {
      return repondreContacts(res, userId, await essaiContact({ userId, id: corps.id }))
    }

    // Ce qui attend la fin de MES heures calmes part tout de suite (la recette
    // sur staging, qui n'a pas de cron). Jamais les lignes d'un autre.
    if (corps.action === 'vider_ma_file') {
      const { viderFile } = require('../lib/notifications/file')
      const bilan = await viderFile({ seulement: userId })
      return res.status(200).json({ ok: true, bilan })
    }

    if (!cles) return res.status(503).json({ error: 'Les notifications ne sont pas encore configurées.', motif: 'cles_absentes' })

    if (corps.action === 'abonner') {
      const r = await abonnements.enregistrer({ userId, abonnement: corps.abonnement, appareil: corps.appareil })
      if (!r.ok) {
        const code = r.motif === 'plafond_atteint' ? 409 : (r.motif.endsWith('_impossible') ? 503 : 400)
        return res.status(code).json({ error: MESSAGES_REFUS[r.motif] || 'Écriture impossible, réessayez.', motif: r.motif })
      }
      return res.status(200).json({ ok: true, empreinte: r.empreinte })
    }

    if (corps.action === 'essai') {
      const message = messageDeclaratif({
        titre: 'HôteSmart',
        corps: 'Les notifications arrivent bien sur cet appareil.',
        chemin: '/settings?onglet=notifications',
        sujet: 'essai'
      })
      const bilan = await envoyerAPersonne({ userId, message, cles })
      if (!bilan.ok) return res.status(503).json({ error: 'Lecture impossible, réessayez.' })
      return res.status(200).json(bilan)
    }

    return res.status(400).json({ error: 'action inconnue' })
  } catch (e) {
    console.error('push:', e && e.message)
    return res.status(500).json({ error: 'Erreur interne.' })
  }
}
