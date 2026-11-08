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
//   DELETE /api/push { endpoint } | { id }        → retirer un de MES appareils
//
// ⚠ C'EST L'ENDPOINT D'ÉCRAN DE L'ONGLET NOTIFICATIONS de `/settings` : un seul
// GET à l'ouverture, ses deux lectures (appareils, réglages) en parallèle.
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
  langue_inconnue: 'Langue inconnue.'
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
      const [r, g] = await Promise.all([abonnements.lister({ userId }), reglages.lire({ userId })])
      if (!r.ok) return res.status(503).json({ error: 'Lecture impossible, réessayez.' })
      const corps = { pret: !!cles, cle_publique: cles ? cles.publique : null, appareils: r.appareils }
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
