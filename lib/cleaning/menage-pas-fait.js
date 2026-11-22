// lib/cleaning/menage-pas-fait.js — PWA lot 4 : L'HÔTE PRÉVENU D'UN MÉNAGE PAS
// FAIT AVANT L'ARRIVÉE.
// Spec : docs/specs/spec-pwa-lot4-menage-pas-fait.md · KB : docs/kb/menage-pas-fait.md.
//
// À chaque cycle du cron, pour chaque ARRIVÉE D'AUJOURD'HUI (jour de Paris) :
//   1. l'heure d'arrivée RÉGLÉE SUR LE LOGEMENT (`properties.checkin_time`),
//      jamais celle du voyageur (décision de Thierry du 19 novembre 2026) ;
//      vide ou illisible → pas d'alerte pour ce logement (Q49, 22 novembre) ;
//   2. dès que l'horloge de Paris atteint cette heure − 30 minutes, et jusqu'à
//      minuit (un cycle manqué rattrape ; jamais le lendemain) ;
//   3. le ménage concerné : le plus récent du logement AU PLUS TARD le jour de
//      l'arrivée, hors annulés — le départ du matin même, d'ordinaire ;
//   4. pas de ligne `menage_done` pour lui → l'alerte part, une fois.
//
// ⚠ L'HEURE SE COMPARE EN HEURE MURALE DE PARIS (minutes depuis minuit), pas en
// instants : « 30 minutes avant 16:00 » veut dire 15:30 à la pendule, été comme
// hiver, et les passages d'heure tombent la nuit.
// ⚠ AUCUN MÉNAGE DANS `menages` POUR CE LOGEMENT → RIEN. Un hôte qui ne suit pas
// ses ménages dans HôteSmart n'a pas à recevoir une alerte à chaque arrivée.
// ⚠ NE LÈVE JAMAIS : une panne se dit dans `results.errors` et le bilan ; le
// cycle suivant reprend (rien n'est mémorisé de ce qui n'a pas été tranché).

const { isActiveStatus } = require('../bookings-snapshot-status')

function client () {
  return require('../cron-shared').supabase
}

const DELAI_MINUTES = 30
// Au plus vingt arrivées TRANCHÉES par cycle : le reste attend cinq minutes
// (rien n'est mémorisé pour lui), dans un cron qui a ses 60 s à tenir.
const MAX_PAR_CYCLE = 20
const PAGE = 500
const PAQUET = 100

// Le jour (« 2026-11-22 ») et l'heure murale (minutes depuis minuit) à Paris.
function horlogeDeParis (t) {
  const v = {}
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(t))) if (p.type !== 'literal') v[p.type] = p.value
  const heure = Number(v.hour) === 24 ? 0 : Number(v.hour)
  return { jour: `${v.year}-${v.month}-${v.day}`, minutes: heure * 60 + Number(v.minute) }
}

// « 16:00 », « 16:00:00 », « 16h », « 16h30 », « 9:05 » → minutes depuis minuit.
// Rien d'exploitable → null (Q49 : pas d'alerte, jamais une heure supposée).
function minutesDeLHeure (texte) {
  const m = /^\s*(\d{1,2})\s*(?::|h|H)\s*(\d{2})?(?::\d{2})?\s*$/.exec(String(texte == null ? '' : texte))
  if (!m) return null
  const h = Number(m[1])
  const mn = m[2] == null ? 0 : Number(m[2])
  if (h > 23 || mn > 59) return null
  return h * 60 + mn
}

const enHeure = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

// Les arrivées du jour, PAR CURSEUR sur `id` : une lecture qui peut passer
// 1 000 lignes ne se laisse pas tronquer en silence (CLAUDE.md, point 6).
async function arriveesDuJour (db, jour) {
  const lignes = []
  let curseur = null
  for (;;) {
    let q = db.from('bookings_snapshot')
      .select('id, user_id, property_id, booking_id, snapshot')
      .gte('snapshot->>arrival', jour)
      .lte('snapshot->>arrival', jour)
    if (curseur) q = q.gt('id', curseur)
    const { data, error } = await q.order('id').limit(PAGE)
    if (error) throw new Error(`bookings_snapshot : ${error.message}`)
    const page = data || []
    lignes.push(...page)
    if (page.length < PAGE) return lignes
    curseur = page[page.length - 1].id
  }
}

async function parPaquets (valeurs, lire) {
  const out = []
  for (let i = 0; i < valeurs.length; i += PAQUET) out.push(...await lire(valeurs.slice(i, i + PAQUET)))
  return out
}

async function prevenirMenagesPasFaits (results = {}, { maintenant = new Date(), db = client(), deps = {} } = {}) {
  const bilan = { arrivees: 0, dues: 0, sans_heure: 0, deja: 0, sans_menage: 0, faits: 0,
                  prevenus: 0, injoignables: 0, reportes: 0, erreurs: 0 }
  const signaler = (quoi) => {
    console.error(`[menage-pas-fait] ${quoi}`)
    if (results && Array.isArray(results.errors)) results.errors.push({ context: 'menage_pas_fait', error: quoi })
    bilan.erreurs++
  }
  const notif = deps.notifications || require('../notifications/evenements-menages')
  const { jour, minutes } = horlogeDeParis(maintenant)

  // 1. Les arrivées du jour, actives, une par (compte, logement).
  let lignes
  try { lignes = await arriveesDuJour(db, jour) } catch (e) { signaler(e.message); return bilan }
  const parBien = new Map()
  for (const r of lignes) {
    const s = r.snapshot || {}
    if (!r.user_id || r.property_id == null) continue
    if (String(s.arrival || '').slice(0, 10) !== jour || !isActiveStatus(s)) continue
    const k = `${r.user_id}|${String(r.property_id)}`
    if (!parBien.has(k)) parBien.set(k, { compte: r.user_id, ref: String(r.property_id) })
  }
  bilan.arrivees = parBien.size
  if (!parBien.size) return bilan

  // 2. Leurs logements : l'heure d'arrivée, et l'archivage.
  let biens
  try {
    biens = await parPaquets([...new Set([...parBien.values()].map(a => a.ref))], async (refs) => {
      const { data, error } = await db.from('properties')
        .select('id, user_id, provider_property_id, checkin_time, archive_le').in('provider_property_id', refs)
      if (error) throw new Error(`properties : ${error.message}`)
      return data || []
    })
  } catch (e) { signaler(e.message); return bilan }
  // Un logement archivé puis recréé sous la même référence : on garde l'ACTIF.
  const bienDe = new Map()
  for (const b of biens) {
    const k = `${b.user_id}|${String(b.provider_property_id)}`
    const deja = bienDe.get(k)
    if (!deja || (deja.archive_le && !b.archive_le)) bienDe.set(k, b)
  }
  const dues = []
  for (const [k, a] of parBien) {
    const b = bienDe.get(k)
    if (!b || b.archive_le) continue
    const heure = minutesDeLHeure(b.checkin_time)
    if (heure == null) { bilan.sans_heure++; continue }
    if (minutes < Math.max(0, heure - DELAI_MINUTES)) continue
    dues.push({ ...a, heure })
  }
  bilan.dues = dues.length
  if (!dues.length) return bilan

  // 3. Celles déjà tranchées aujourd'hui (alerte partie, ou ménage trouvé fait).
  let tranchees = new Set()
  try {
    const cles = [...new Set(dues.map(d => notif.clePasFait(d.ref, jour)))]
    const lues = await parPaquets(cles, async (paquet) => {
      const { data, error } = await db.from('message_sent_log').select('user_id, booking_id')
        .eq('template_id', notif.SENTINELLE_PAS_FAIT).in('booking_id', paquet)
      if (error) throw new Error(error.message)
      return data || []
    })
    tranchees = new Set(lues.map(l => `${l.user_id}|${l.booking_id}`))
  } catch (e) {
    // Sans la liste, chaque envoi passe par son insertion : l'index unique tranche.
    console.error('[menage-pas-fait] memoires illisibles', e.message)
  }
  const aTrancher = []
  for (const d of dues) {
    if (tranchees.has(`${d.compte}|${notif.clePasFait(d.ref, jour)}`)) bilan.deja++
    else aTrancher.push(d)
  }
  // Les arrivées les plus proches d'abord.
  aTrancher.sort((x, y) => x.heure - y.heure)
  const lot = aTrancher.slice(0, MAX_PAR_CYCLE)
  bilan.reportes = aTrancher.length - lot.length
  if (!lot.length) return bilan

  // 4. Le ménage de chacune : le plus récent au plus tard aujourd'hui, hors annulés.
  const menageDe = new Map()
  await Promise.all(lot.map(async (d) => {
    try {
      const { data, error } = await db.from('menages')
        .select('id, user_id, property_id, booking_id, departure_date, status, provider_id')
        .eq('user_id', d.compte).eq('property_id', d.ref)
        .lte('departure_date', jour).neq('status', 'cancelled')
        .order('departure_date', { ascending: false }).limit(1)
      if (error) throw new Error(error.message)
      menageDe.set(d, (data || [])[0] || null)
    } catch (e) {
      signaler(`menages ${d.ref} : ${e.message}`)
      menageDe.set(d, undefined)
    }
  }))
  const avecMenage = []
  for (const d of lot) {
    const m = menageDe.get(d)
    if (m === undefined) continue // illisible : le cycle suivant reprend
    if (m === null) {
      bilan.sans_menage++
      await notif.memoriserPasFait({ compte: d.compte, propertyId: d.ref, jourArrivee: jour, db })
      continue
    }
    avecMenage.push({ ...d, menage: m })
  }
  if (!avecMenage.length) return finir()

  // 5. Fait ? ⚠ DANS LE DOUTE, ON NE PRÉVIENT PAS : une alerte « pas fait » sur un
  // ménage fait est celle qui apprend à l'hôte à ne plus les lire. Le cycle
  // suivant relit.
  let faits
  try {
    const lus = await parPaquets([...new Set(avecMenage.map(d => String(d.menage.booking_id)))], async (ids) => {
      const { data, error } = await db.from('menage_done')
        .select('user_id, property_id, booking_id, departure_date').in('booking_id', ids)
      if (error) throw new Error(error.message)
      return data || []
    })
    faits = new Set(lus.map(f =>
      `${f.user_id}|${String(f.property_id)}|${String(f.booking_id)}|${String(f.departure_date).slice(0, 10)}`))
  } catch (e) { signaler(`menage_done : ${e.message}`); return finir() }
  const pasFaits = []
  for (const d of avecMenage) {
    const m = d.menage
    const cle = `${m.user_id}|${String(m.property_id)}|${String(m.booking_id)}|${String(m.departure_date).slice(0, 10)}`
    if (faits.has(cle)) {
      bilan.faits++
      await notif.memoriserPasFait({ compte: d.compte, propertyId: d.ref, jourArrivee: jour, db })
    } else pasFaits.push(d)
  }
  if (!pasFaits.length) return finir()

  // 6. Le prénom de qui le porte. Illisible : l'alerte part quand même, sans lui.
  const prenomDe = new Map()
  const porteuses = [...new Set(pasFaits.map(d => d.menage.provider_id).filter(Boolean).map(String))]
  if (porteuses.length) {
    try {
      const { data, error } = await db.from('profiles').select('id, first_name').in('id', porteuses)
      if (error) throw new Error(error.message)
      for (const p of (data || [])) prenomDe.set(String(p.id), p.first_name || null)
    } catch (e) { console.error('[menage-pas-fait] prenoms illisibles', e.message) }
  }

  // 7. L'envoi, une fois (mémoire posée avant, retirée si rien n'est parti).
  for (const d of pasFaits) {
    const m = d.menage
    let r
    try {
      r = await notif.notifierMenagePasFait({
        compte: d.compte, propertyId: d.ref, jourMenage: String(m.departure_date).slice(0, 10), jourArrivee: jour,
        heure: enHeure(d.heure), prestataire: m.provider_id ? (prenomDe.get(String(m.provider_id)) || null) : null,
        sansPersonne: !m.provider_id, db, deps: deps.envoi || {}
      })
    } catch (e) { r = { ok: false, erreurs: [e.message] } }
    if (r && r.deja) bilan.deja++
    else if (r && r.ok && !notif.partiOuAttend(r)) bilan.injoignables++
    else if (r && r.ok) bilan.prevenus++
    else bilan.erreurs++
  }
  return finir()

  function finir () {
    console.log(`[menage-pas-fait] arrivees=${bilan.arrivees} dues=${bilan.dues} sans_heure=${bilan.sans_heure} deja=${bilan.deja} sans_menage=${bilan.sans_menage} faits=${bilan.faits} prevenus=${bilan.prevenus} injoignables=${bilan.injoignables} reportes=${bilan.reportes} erreurs=${bilan.erreurs}`)
    return bilan
  }
}

module.exports = { prevenirMenagesPasFaits, minutesDeLHeure, horlogeDeParis, DELAI_MINUTES, MAX_PAR_CYCLE }
