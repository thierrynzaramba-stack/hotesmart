// lib/notifications/evenements-avis.js — LE DOMAINE AVIS DU POINT D'ENVOI
// (PWA lot 2c-2, docs/kb/pwa.md §11.4).
//
// Deux événements du catalogue, chacun appelé par SON émetteur :
//   n avis                — lib/cron-channel-reviews.js `upsertAvis`, le writer
//                           unique de `ota_reviews` (poll Channex, webhook,
//                           import Beds24) : un avis NOUVEAU et récent, puis la
//                           RÉVÉLATION d'un avis qui était masqué
//   o evaluation_voyageur — lib/avis/notifications.js `noterEtEnvoyer` : la
//                           prestataire a rempli sa part, les relances J-5 et
//                           J-1, et les deux messages de la publication
//                           automatique (lib/avis/auto-validation.js)
//
// ⚠ AUCUN NE LÈVE : un writer d'avis ou un cycle de relances ne s'arrête jamais
// pour une notification.
//
// ⚠ NI LE TEXTE DE L'AVIS, NI LE NOM DU VOYAGEUR (constat S1 de la review du
// lot). Le domaine `avis` se délègue SANS le domaine `reservations` : un membre
// qui ne voit que les avis ne voit pas qui a séjourné, et une notification
// n'a pas le droit d'en dire plus que l'écran. Un avis se dit par son bien, sa
// note et son canal.

const { bienDuCompte } = require('./bien')
const { rienNestParti } = require('./evenements-menages')
const { noteSur5Des } = require('../avis/echelle')
const { instantUTC, voyageurAEcrit } = require('../avis/naissance')

function client () {
  return require('../cron-shared').supabase
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

const PARIS = 'Europe/Paris'
// Le jour de Paris d'un instant (une échéance à 0 h 30 UTC est le lendemain à Paris).
const jourParis = (v) => {
  const t = instantUTC(v)
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-CA', { timeZone: PARIS }).format(new Date(t)) : null
}
const heureParis = (v) => {
  const t = instantUTC(v)
  return Number.isFinite(t)
    ? new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t))
    : null
}

// ─── n. Nouvel avis, puis sa révélation ──────────────────────────────────────
// ⚠ UN AVIS ANCIEN N'EST PAS UN NOUVEL AVIS : le premier poll d'un compte, un
// import Beds24, un bien qu'on connecte écrivent des avis de l'an passé. Seul un
// avis reçu depuis moins de JOURS_AVIS_RECENT prévient.
const JOURS_AVIS_RECENT = 3
// ⚠ UN AVIS MASQUÉ NE PRÉVIENT PAS : SA RÉVÉLATION, SI (décision de Thierry du
// 9 novembre 2026). L'objet Channex d'Airbnb naît au DÉPART, masqué et vide,
// que le voyageur écrive ou non : tant qu'il est masqué, rien ne dit qu'un avis
// existe, et l'évaluation à faire est déjà annoncée par o. Il est révélé quand
// l'hôte a évalué le voyageur, ou à la fin de la fenêtre d'avis (14 jours) ; sa
// révélation prévient une fois, avec la vraie note — si le voyageur a écrit.
// Au-delà de trente jours après sa réception, ce n'est plus une révélation,
// c'est une reprise de données.
const JOURS_REVELATION = 30
// Au plus dix par COMPTE et par écriture, les plus récents d'abord : un lot ne
// devient pas une rafale, et un compte bavard ne fait pas taire les autres.
const PLAFOND_AVIS = 10
// La mémoire de « déjà prévenu », une par avis et par événement : l'index
// unique de `message_sent_log` (le geste de lib/notifications/evenements-menages.js).
// Le webhook et le poll écrivent le même avis à quelques secondes d'écart :
// lire « absent » des deux côtés ne suffit pas, l'INSERTION tranche.
// UUID fixes, jamais présents dans `message_templates`.
const SENTINELLE_AVIS = '00000000-0000-4000-8000-0000000000a3'
const SENTINELLE_AVIS_REVELE = '00000000-0000-4000-8000-0000000000a4'

const cleAvis = (l) => `${l.user_id}|${l.provider}|${l.external_review_id}`
const masque = (l) => !!l && l.is_hidden === true
const recuDepuis = (l, maintenant) => {
  const t = instantUTC(l && l.received_at)
  return Number.isFinite(t) ? maintenant - t : NaN
}
// Un avis que l'écriture pourrait annoncer : reçu depuis moins de
// JOURS_REVELATION. Le writer ne lit l'existant QUE pour ceux-là.
const aExaminer = (l, maintenant = Date.now()) => {
  const age = recuDepuis(l, maintenant)
  return Number.isFinite(age) && age <= JOURS_REVELATION * 86400000
}

// La note sur 5, par LA conversion de l'écran (lib/avis/echelle.js : échelle
// par canal, un seul arrondi au dixième). `null` si l'avis est masqué ou si sa
// note n'est pas exploitable — jamais une note devinée.
function noteDe (l) {
  if (masque(l)) return null
  return noteSur5Des([{ ota: l.ota, overall_score: l.overall_score }]).note_sur_5
}

async function notifierAvis ({ compte, propertyRef, provider, externalId, note = null, canal = null,
  revele = false, db = client(), deps = {} }) {
  const cle = `notif:avis${revele ? '-revele' : ''}:${provider}:${externalId}`
  const sentinelle = revele ? SENTINELLE_AVIS_REVELE : SENTINELLE_AVIS
  const { error } = await db.from('message_sent_log').insert({ user_id: compte, booking_id: cle, template_id: sentinelle })
  if (error) {
    if (error.code === '23505') return { ok: true, deja: true }
    // ⚠ SANS MÉMOIRE, ON NE PRÉVIENT PAS : un avis réécrit à chaque poll
    // préviendrait à chaque poll tant que la base refuse.
    console.error(`[notifications] avis ${cle} : memoire illisible (${error.message})`)
    return { ok: false, erreurs: ['memoire_illisible'] }
  }
  const b = await bienDuCompte(compte, propertyRef, db)
  const r = await envoyer({
    compte, code: 'avis', bien: { id: b.id, ref: b.ref },
    donnees: { bien: b.nom, note, canal, revele: !!revele },
    chemin: '/avis', sujet: `avis:${provider}:${externalId}`, rappel: true, db
  }, `avis ${externalId}`, deps)
  // ⚠ RIEN N'EST PARTI : LA NOTIFICATION EST PERDUE, et on le DIT (constat 2 de
  // la re-review). La mémoire est retirée, mais l'émetteur ne repassera pas :
  // au poll suivant, l'avis est en base (ou n'est plus masqué), il n'est plus
  // « nouveau ». Une vraie reprise jugerait « nouveau » sur l'absence de la
  // mémoire plutôt que sur l'absence en base — un autre comportement, donc un
  // autre lot.
  if (rienNestParti(r)) {
    console.error(`[notifications] avis ${cle} : rien n'est parti, notification perdue (${((r && r.erreurs) || []).join(',') || 'sans destinataire joignable'})`)
    try {
      const { error: eSup } = await db.from('message_sent_log').delete().eq('user_id', compte).eq('booking_id', cle).eq('template_id', sentinelle)
      if (eSup) console.error(`[notifications] avis ${cle} : memoire non retiree (${eSup.message})`)
    } catch (e) { console.error(`[notifications] avis ${cle} : memoire non retiree (${e.message})`) }
  }
  return r
}

// Les avis à annoncer d'une écriture : `existants` est la Map des avis lus
// AVANT l'écriture, clé (user_id|provider|external_review_id) → { cache }.
// Un avis absent, récent et visible est NOUVEAU ; un avis qui était masqué et
// ne l'est plus est RÉVÉLÉ. Un avis masqué, ou visible mais vide, se tait.
async function notifierNouveauxAvis ({ lignes, existants, maintenant = Date.now(), db = client(), deps = {} }) {
  const bilan = { envoyes: 0, reveles: 0, deja: 0, anciens: 0, masques: 0, vides: 0, plafond: 0 }
  const parCompte = new Map()
  for (const l of (lignes || [])) {
    if (!l || !l.user_id || !l.provider || l.external_review_id == null) continue
    const avant = existants.get(cleAvis(l))
    const age = recuDepuis(l, maintenant)
    let revele = false
    if (avant) {
      if (!(avant.cache && !masque(l))) continue
      if (!(age <= JOURS_REVELATION * 86400000)) { bilan.anciens++; continue }
      revele = true
    } else if (!(age <= JOURS_AVIS_RECENT * 86400000)) { bilan.anciens++; continue }
    if (masque(l)) { bilan.masques++; continue }
    // ⚠ UN AVIS VISIBLE MAIS VIDE N'EST PAS UN AVIS (constat 1 de la re-review).
    // L'objet Channex naît au départ, caché et vide, et Airbnb le révèle au bout
    // de 14 jours même si le voyageur n'a rien écrit : sans cette garde, chaque
    // séjour Airbnb sans avis aurait annoncé « Avis révélé ». La règle est celle
    // de l'écran (lib/avis/naissance.js).
    if (!voyageurAEcrit({ is_hidden: false, overall_score: l.overall_score, content: l.content || l.content_public })) {
      bilan.vides++
      continue
    }
    if (!parCompte.has(l.user_id)) parCompte.set(l.user_id, [])
    parCompte.get(l.user_id).push({ l, age, revele })
  }
  for (const liste of parCompte.values()) {
    liste.sort((a, b) => a.age - b.age)
    for (const [i, { l, revele }] of liste.entries()) {
      if (i >= PLAFOND_AVIS) { bilan.plafond++; continue }
      const r = await notifierAvis({
        compte: l.user_id, propertyRef: l.property_id_ref || l.property_id, provider: l.provider,
        externalId: l.external_review_id, note: noteDe(l), canal: l.ota || null, revele, db, deps
      })
      if (r && r.deja) bilan.deja++
      else if (revele) bilan.reveles++
      else bilan.envoyes++
    }
  }
  if (bilan.plafond) console.warn(`[notifications] avis : ${bilan.plafond} avis au-dela du plafond par compte, sans notification`)
  return bilan
}

// ─── o. Évaluation du voyageur à faire ───────────────────────────────────────
// Un sujet par séjour : la relance remplace l'annonce, et sonne.
// `auto` : 'rappel' (publication automatique prévue à `publication`) ou
// 'echec' (elle n'a pas abouti) — lib/avis/auto-validation.js.
// L'échéance n'est dite que si elle est à venir : « à publier avant » un jour
// passé serait un ordre impossible.
async function notifierEvaluation ({ compte, propertyRef, bookingUid, rempli = false, prestataire = null, echeance = null,
  derniere = false, auto = null, publication = null, maintenant = Date.now(), db = client(), deps = {} }) {
  const b = await bienDuCompte(compte, propertyRef, db)
  const fin = instantUTC(echeance)
  return envoyer({
    compte, code: 'evaluation_voyageur', bien: { id: b.id, ref: b.ref },
    donnees: {
      bien: b.nom, rempli: !!rempli, prestataire, derniere: !!derniere,
      echeance: Number.isFinite(fin) && fin > maintenant ? jourParis(echeance) : null,
      auto: auto === 'rappel' || auto === 'echec' ? auto : null,
      publication_jour: auto === 'rappel' ? jourParis(publication) : null,
      publication_heure: auto === 'rappel' ? heureParis(publication) : null
    },
    chemin: `/avis?evaluer=${encodeURIComponent(String(bookingUid))}`,
    sujet: `eval:${bookingUid}`, rappel: true, db
  }, `evaluation_voyageur ${bookingUid}`, deps)
}

module.exports = {
  notifierAvis, notifierNouveauxAvis, notifierEvaluation, aExaminer, noteDe,
  JOURS_AVIS_RECENT, JOURS_REVELATION, PLAFOND_AVIS, SENTINELLE_AVIS, SENTINELLE_AVIS_REVELE
}
