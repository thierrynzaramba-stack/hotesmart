// lib/notifications/evenements-menages.js — LE DOMAINE MÉNAGES DU POINT
// D'ENVOI (PWA lot 2c-2, docs/kb/pwa.md §11.3).
//
// Quatre événements du catalogue, chacun appelé par SON émetteur :
//   h menage_sans_personne    — lib/cleaning/sync-menages-entite.js (trou de
//                               garde ; proposition expirée que plus personne
//                               ne porte)
//   i menage_pas_vu           — lib/cleaning/relance-validation.js (la relance
//                               de la veille : elle n'a pas touché « Vu »)
//   l menage_refuse           — lib/alert-notify.js `alertMenageRefuse`
//   m disponibilites_modifiees — lib/alert-notify.js, jours habituels et
//                               exceptions déclarés depuis son application
//
// ⚠ UNE NOTIFICATION PAR MÉNAGE : h, i et l portent le même sujet
// `menage:<bien>:<jour>` — la plus récente remplace l'autre et sonne, comme
// une conversation (décision de Thierry du 9 novembre 2026, §11.2).
// ⚠ AUCUN NE LÈVE : un émetteur du ménage ne s'arrête jamais pour une
// notification. Chaque fonction rend le bilan du notifier, ou { ok:false }.

const { bienDuCompte } = require('./bien')

function client () {
  return require('../cron-shared').supabase
}

const jourDe = (v) => (v ? String(v).slice(0, 10) : null)
// ⚠ LA CLÉ ET LE SUJET SE CONSTRUISENT SUR CE QUE L'ÉMETTEUR PASSE (la référence
// du bien des tables du ménage), jamais sur ce que la relecture du bien a
// trouvé : une lecture ratée changeait la clé (UUID → référence), donc deux h,
// sur deux sujets qui ne se remplaçaient pas (constat de review).
const sujetMenage = (propertyId, jour) => `menage:${propertyId}:${jour}`

// Rien n'est parti ni n'attend : un envoi qui n'a joint personne. ⚠ PAS
// `personne_joignable`, qui reste vrai sur une exception, ni `ok`, qui reste vrai
// quand tout a raté (constat de review) ; et pas non plus « faux » sur un envoi
// PARTIEL (une exception après un premier envoi rend `ok: false`) — sinon la
// personne déjà prévenue l'est de nouveau toutes les cinq minutes.
function rienNestParti (r) {
  if (!r) return true
  const parti = (r.push || 0) + (r.emails || 0) + (r.sms || 0) + (r.en_attente || 0) > 0
  if (parti) return false
  // Personne n'a de canal pour cet événement (choix des personnes) : ce n'est
  // pas un échec, et réessayer toutes les cinq minutes ne changerait rien.
  if (r.ok && (r.destinataires || 0) <= (r.sans_canal || 0)) return false
  return true
}

async function envoyer (o, etiquette, deps = {}) {
  try {
    const notifier = deps.notifier || require('./notifier').notifier
    const r = await notifier(o)
    if (!r || !r.ok) console.error(`[notifications] ${etiquette} : ${((r && r.erreurs) || []).join(',') || 'echec'}`)
    return r || { ok: false, erreurs: ['sans_bilan'] }
  } catch (e) {
    console.error(`[notifications] ${etiquette} : ${e.message}`)
    return { ok: false, erreurs: [e.message] }
  }
}

// Le ménage d'un jour : la date sert aussi de « séjour » à la décision — un
// ménage d'aujourd'hui ou de demain passe les heures calmes, comme toute
// alerte de séjour imminent.
function sejourDuMenage (jour) {
  return jour ? { arrivee: jour, depart: jour } : null
}

// ─── h. Ménage sans personne ─────────────────────────────────────────────────
// ⚠ UNE FOIS PAR (COMPTE, BIEN, JOUR). L'émetteur réévalue les ménages non
// assignés à CHAQUE cycle (toutes les cinq minutes) dans la fenêtre de
// proposition : sans mémoire, h — urgent par défaut, donc qui passe la nuit —
// sonnerait toutes les cinq minutes. C'est exactement le bruit qui avait fait
// couper son SMS le 17 septembre. La mémoire est l'index unique de
// `message_sent_log` (le même geste que le relevé de réservation,
// lib/notif-hote-resa.js) : une ligne posée AVANT l'envoi ; un envoi dont RIEN
// n'est parti la retire, pour que le cycle suivant réessaie.
// `uneFois: false` : l'émetteur ne repasse pas (l'expiration d'une proposition
// n'arrive qu'une fois) — c'est un NOUVEL épisode, que la mémoire d'un épisode
// précédent ne doit pas faire taire (constat de review).
// UUID fixe, jamais présent dans `message_templates` : il occupe la colonne
// pour que l'index unique fasse la dédup.
const SENTINELLE_SANS_PERSONNE = '00000000-0000-4000-8000-0000000000a1'
const cleSansPersonne = (propertyId, jour) => `notif:${sujetMenage(propertyId, jour)}`
// Au plus vingt h par cycle : le reliquat part au cycle suivant (sa mémoire
// n'est pas posée), dans un cron qui a déjà ses 60 s à tenir.
const PLAFOND_SANS_PERSONNE = 20

async function envoyerSansPersonne ({ compte, propertyId, jour, motif = null, db, deps }) {
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'menage_sans_personne', bien: { id: b.id, ref: b.ref }, sejour: sejourDuMenage(jour),
    donnees: { bien: b.nom, jour, motif },
    chemin: '/menages', sujet: sujetMenage(propertyId, jour), rappel: true, db
  }, `menage_sans_personne ${propertyId} ${jour}`, deps)
}

async function notifierMenageSansPersonne ({ compte, propertyId, jour, motif = null, uneFois = true, db = client(), deps = {} }) {
  const j = jourDe(jour)
  if (!uneFois) return envoyerSansPersonne({ compte, propertyId, jour: j, motif, db, deps })
  const cle = cleSansPersonne(propertyId, j)
  const { error } = await db.from('message_sent_log').insert({
    user_id: compte, booking_id: cle, template_id: SENTINELLE_SANS_PERSONNE
  })
  if (error) {
    if (error.code === '23505') return { ok: true, deja: true }
    // ⚠ SANS MÉMOIRE, ON NE PRÉVIENT PAS : prévenir quand même, c'est prévenir
    // toutes les cinq minutes tant que la base refuse. L'incident fondateur de
    // l'émetteur, lui, part toujours.
    console.error(`[notifications] menage_sans_personne ${cle} : memoire illisible (${error.message})`)
    return { ok: false, erreurs: ['memoire_illisible'] }
  }
  const r = await envoyerSansPersonne({ compte, propertyId, jour: j, motif, db, deps })
  if (rienNestParti(r)) {
    try {
      await db.from('message_sent_log').delete()
        .eq('user_id', compte).eq('booking_id', cle).eq('template_id', SENTINELLE_SANS_PERSONNE)
    } catch (_) { /* le cycle suivant ne réessaiera pas : c'est dit au journal */ }
  }
  return r
}

// Le lot d'un cycle de l'émetteur : UNE lecture des mémoires déjà posées, puis
// seulement les nouveaux, au plus PLAFOND_SANS_PERSONNE (constat de review :
// deux requêtes par ménage déjà prévenu, à chaque cycle, sans plafond).
async function notifierMenagesSansPersonne ({ liste, db = client(), deps = {}, plafond = PLAFOND_SANS_PERSONNE }) {
  const bilan = { envoyes: 0, deja: 0, reportes: 0, erreurs: 0 }
  const vus = new Set()
  const uniques = []
  for (const a of (liste || [])) {
    const j = jourDe(a.jour)
    const k = `${a.compte}|${cleSansPersonne(a.propertyId, j)}`
    if (!a.compte || !j || vus.has(k)) continue
    vus.add(k)
    uniques.push({ ...a, jour: j, cle: cleSansPersonne(a.propertyId, j) })
  }
  if (!uniques.length) return bilan
  let deja = new Set()
  try {
    const { data, error } = await db.from('message_sent_log').select('user_id, booking_id')
      .eq('template_id', SENTINELLE_SANS_PERSONNE).in('booking_id', [...new Set(uniques.map(u => u.cle))])
    if (error) throw new Error(error.message)
    deja = new Set((data || []).map(l => `${l.user_id}|${l.booking_id}`))
  } catch (e) {
    // Sans la liste, chaque ménage passe par son insertion : l'index unique tranche.
    console.error('[notifications] menage_sans_personne : memoires illisibles', e.message)
  }
  for (const u of uniques) {
    if (deja.has(`${u.compte}|${u.cle}`)) { bilan.deja++; continue }
    if (bilan.envoyes + bilan.erreurs >= plafond) { bilan.reportes++; continue }
    const r = await notifierMenageSansPersonne({ compte: u.compte, propertyId: u.propertyId, jour: u.jour, motif: u.motif || null, db, deps })
    if (r && r.deja) bilan.deja++
    else if (r && r.ok) bilan.envoyes++
    else bilan.erreurs++
  }
  return bilan
}

// ─── i. Ménage pas vu ────────────────────────────────────────────────────────
// L'émetteur pose son marqueur de relance AVANT : une fois par ménage.
async function notifierMenagePasVu ({ compte, propertyId, jour, prestataire = null, db = client(), deps = {} }) {
  const j = jourDe(jour)
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'menage_pas_vu', bien: { id: b.id, ref: b.ref }, sejour: sejourDuMenage(j),
    donnees: { bien: b.nom, jour: j, prestataire },
    chemin: '/menages', sujet: sujetMenage(propertyId, j), rappel: true, db
  }, `menage_pas_vu ${propertyId} ${j}`, deps)
}

// ─── l. Ménage refusé ────────────────────────────────────────────────────────
// Deux émetteurs : le refus d'une proposition (`alertMenageRefuse`, une fois par
// refus, sa tâche marquée) et le RETRAIT d'un ménage déjà accepté depuis son
// application (api/menages-public.js — décision de Thierry du 9 novembre 2026 :
// le logement n'a plus personne, l'hôte doit le savoir ; une fois, le retrait
// n'arrive qu'une fois).
async function notifierMenageRefuse ({ compte, propertyId, jour, prestataire = null, db = client(), deps = {} }) {
  const j = jourDe(jour)
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'menage_refuse', bien: { id: b.id, ref: b.ref }, sejour: sejourDuMenage(j),
    donnees: { bien: b.nom, jour: j, prestataire },
    chemin: '/menages', sujet: sujetMenage(propertyId, j), rappel: true, db
  }, `menage_refuse ${propertyId} ${j}`, deps)
}

// ─── m. Disponibilités modifiées ─────────────────────────────────────────────
// Le bien est celui que l'émetteur choisit pour router l'envoi (un des siens) :
// un membre limité à un AUTRE de ses biens ne l'apprend pas (dit au KB). Un
// sujet par prestataire : le changement suivant remplace le précédent.
// ⚠ LA PREMIÈRE DU JOUR SONNE, LES SUIVANTES REMPLACENT SANS SONNER (décision
// de Thierry du 9 novembre 2026) : cinq cases cochées d'affilée ne font plus cinq
// sonneries chez chaque membre de l'équipe. Le jour se compte à Paris, par
// prestataire ; la mémoire est l'index unique de `message_sent_log`. Une mémoire
// illisible sonne (mieux vaut une sonnerie de trop qu'un changement manqué).
const SENTINELLE_DISPOS = '00000000-0000-4000-8000-0000000000a2'
const jourParis = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(t))

async function premiereDuJour ({ compte, providerId, maintenant, db }) {
  try {
    const { error } = await db.from('message_sent_log').insert({
      user_id: compte, booking_id: `notif:dispos:${providerId}:${jourParis(maintenant)}`, template_id: SENTINELLE_DISPOS
    })
    if (!error) return true
    if (error.code === '23505') return false
    console.error('[notifications] disponibilites_modifiees : memoire illisible', error.message)
  } catch (e) { console.error('[notifications] disponibilites_modifiees : memoire illisible', e.message) }
  return true
}

async function notifierDisponibilites ({ compte, propertyId, providerId, prestataire = null, maintenant = Date.now(), db = client(), deps = {} }) {
  if (propertyId == null) return { ok: true, ignore: true, raison: 'sans_bien' }
  const b = await bienDuCompte(compte, propertyId, db)
  const rappel = await premiereDuJour({ compte, providerId, maintenant, db })
  return envoyer({
    compte, code: 'disponibilites_modifiees', bien: { id: b.id, ref: b.ref },
    donnees: { prestataire },
    chemin: `/menages?presta=${encodeURIComponent(String(providerId))}`,
    sujet: `dispos:${providerId}`, rappel, maintenant, db
  }, `disponibilites_modifiees ${providerId}`, deps)
}

module.exports = {
  notifierMenageSansPersonne, notifierMenagesSansPersonne, notifierMenagePasVu, notifierMenageRefuse,
  notifierDisponibilites, rienNestParti, SENTINELLE_SANS_PERSONNE, SENTINELLE_DISPOS, PLAFOND_SANS_PERSONNE
}
