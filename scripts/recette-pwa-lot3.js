#!/usr/bin/env node
// scripts/recette-pwa-lot3.js
// LE DÉCOR ET LE MOTEUR DE LA RECETTE DU LOT 3 PWA (notifications de la
// prestataire), SUR STAGING SEULEMENT.
// Spec : docs/specs/spec-pwa-lot3-prestataires.md §11 (branche pwa-lot-3-spec)
// KB : docs/kb/pwa.md §13.16 et §13.17
//
//   node --env-file=.env.staging scripts/recette-pwa-lot3.js               (état)
//   node --env-file=.env.staging scripts/recette-pwa-lot3.js --sejour=3    (un séjour qui part dans 3 jours)
//   node --env-file=.env.staging scripts/recette-pwa-lot3.js --cron        (un passage du cron de staging)
//   node --env-file=.env.staging scripts/recette-pwa-lot3.js --annuler     (annule le dernier séjour de recette)
//   node --env-file=.env.staging scripts/recette-pwa-lot3.js --retablir    (le rétablit : le ménage revient)
//   node --env-file=.env.staging scripts/recette-pwa-lot3.js --nettoyer    (retire séjours et ménages de recette)
// Une action à la fois. `--annuler=<id>` / `--retablir=<id>` visent un séjour
// précis ; sans valeur, le plus récent dans l'état voulu.
//
// ⚠ POURQUOI LE MOTEUR PASSE PAR LE CRON DE STAGING, ET PAS PAR UN APPEL LOCAL
// DES TÂCHES. Les clés de notification (PUSH_VAPID_*) n'existent QUE dans
// Vercel : `scripts/pwa-cles-push.js` les y a écrites sans fichier ni écran.
// Une tâche lancée d'ici n'aurait donc aucun moyen d'envoyer la notification,
// et la recette ne verrait rien arriver. `--cron` déclenche un passage COMPLET
// du cron de staging, comme le prescrit docs/STAGING.md §7 : c'est le serveur
// qui envoie, avec ses clés. ⚠ Pour TOUS les comptes de staging : leurs
// notifications et les alarmes au fondateur partent aussi.
//
// ⚠ LE SÉJOUR EST ÉCRIT DANS LE CŒUR PAR CE SCRIPT, comme le décor de
// `scripts/recette-avis-staging.js` : le bien de la prestataire de recette n'a
// pas de clé provider, donc aucun séjour ne peut y arriver par le canal. C'est
// le cron qui en fait un ménage, par la garde du jour — c'est ce qu'on recette.
//
// ⚠ AUCUN SECRET N'EST AFFICHÉ. `CRON_SECRET` se dit par son nom et sa
// longueur ; le lien de la prestataire n'est ni lu ni écrit ici.
const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { isActiveStatus } = require('../lib/bookings-snapshot-status')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1) }
if (nomDeLaBase(URL) !== 'STAGING') {
  console.error(`ECHEC : ce script ECRIT. Il ne tourne que sur STAGING, et SUPABASE_URL pointe sur « ${refDuProjet(URL)} » (${nomDeLaBase(URL)}).`)
  process.exit(1)
}

// Le domaine du projet Vercel staging (docs/STAGING.md §2) : jamais lu de
// l'environnement, pour qu'un `--cron` ne puisse viser que lui.
const CRON_STAGING = 'https://hotesmart-staging.vercel.app/api/cron'
const MARQUE = 'RECETTE-PWA3'
const PRENOM = 'Berthe'
const NOM = 'Recette'
// Au-delà, une proposition n'est posée qu'à l'approche du départ
// (lib/cleaning/sync-menages-entite.js, fenêtre de proposition).
const JOURS_PROPOSITION = 7
// ⚠ TOUTE LECTURE DE bookings_snapshot EST BORNÉE (PostgREST tronque à 1000
// lignes sans erreur). Une recette en pose une poignée : au-delà, on nettoie.
const MAX_SEJOURS = 50

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const args = process.argv.slice(2)
const a = (n) => args.find(x => x === `--${n}` || x.startsWith(`--${n}=`))
const val = (n) => { const x = a(n); return x && x.includes('=') ? x.split('=').slice(1).join('=') : null }

const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
function plusJours (iso, n) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// Même lecture que `proposeesDe` (lib/cleaning/assign.js) : la proposition vit
// dans `proposee_a`, `offered_to` n'est qu'un repli d'avant.
function proposees (m) {
  if (Array.isArray(m.proposee_a) && m.proposee_a.length) return m.proposee_a.map(String)
  return m.offered_to ? [String(m.offered_to)] : []
}

function echec (m) { console.error(`ECHEC : ${m}`); process.exit(1) }

// La prestataire de recette, seule : ce qu'il faut au nettoyage.
async function profilBerthe () {
  const { data: profils, error } = await sb.from('profiles')
    .select('id, account_user_id, first_name, last_name, active, access_mode')
    .eq('first_name', PRENOM).eq('last_name', NOM)
  if (error) echec(`lecture des profils : ${error.message}`)
  if ((profils || []).length !== 1) echec(`${(profils || []).length} profil(s) « ${PRENOM} ${NOM} » : il en faut exactement un.`)
  return profils[0]
}

// Et son unique bien confié, VIVANT et du même compte : sans cela le cron
// écarterait le séjour, et la recette croirait le serveur en panne.
async function berthe () {
  const p = await profilBerthe()
  const { data: liaisons, error: eL } = await sb.from('property_cleaning_providers')
    .select('user_id, property_id, rang, requires_ack, active')
    .eq('provider_id', p.id).eq('active', true)
  if (eL) echec(`lecture de ses biens : ${eL.message}`)
  if ((liaisons || []).length !== 1) echec(`${(liaisons || []).length} bien(s) actif(s) confié(s) à ${PRENOM} : il en faut exactement un.`)
  const liaison = liaisons[0]
  if (String(liaison.user_id) !== String(p.account_user_id)) echec('la liaison de son bien appartient à un autre compte que le sien.')
  const { data: biens, error: eB } = await sb.from('properties')
    .select('id, name, provider, provider_property_id, archive_le')
    .eq('user_id', p.account_user_id).eq('provider_property_id', liaison.property_id)
  if (eB) echec(`lecture du bien : ${eB.message}`)
  if ((biens || []).length !== 1) echec(`${(biens || []).length} bien(s) du compte avec la clé de sa liaison : il en faut exactement un.`)
  if (biens[0].archive_le) echec(`le bien « ${biens[0].name} » est archivé : le cron écarterait ses séjours.`)
  return { profil: p, liaison, bien: biens[0] }
}

async function etat ({ profil, liaison, bien }) {
  console.log(`Base STAGING (${refDuProjet(URL)})`)
  console.log(`Prestataire : ${PRENOM} ${NOM} — ${profil.active ? 'active' : 'INACTIVE'}, ${profil.access_mode}`)
  console.log(`Bien : ${bien.name} (rang ${liaison.rang}, ${liaison.requires_ack ? 'proposition à confirmer' : "d'office"})`)

  const { data: apps, error: eA } = await sb.from('push_abonnements_prestataires')
    .select('dernier_envoi_le, dernier_echec').eq('profil_id', profil.id)
  if (eA) echec(`lecture des téléphones abonnés : ${eA.message}`)
  const enEchec = (apps || []).filter(x => x.dernier_echec).length
  const dernier = (apps || []).map(x => x.dernier_envoi_le).filter(Boolean).sort().pop()
  console.log(`Téléphones abonnés : ${(apps || []).length}${enEchec ? ` (dont ${enEchec} en échec au dernier envoi)` : ''}${dernier ? ` · dernier envoi ${dernier}` : ''}`)
  const s = String(process.env.CRON_SECRET || '').trim()
  console.log(`CRON_SECRET : ${s ? `présent (${s.length} caractères)` : 'ABSENT — `--cron` refusera'}`)

  const { data: sejours, error: eS } = await sb.from('bookings_snapshot')
    .select('booking_id, property_id, snapshot').eq('user_id', profil.account_user_id)
    .like('booking_id', `${MARQUE}-%`).order('created_at').limit(MAX_SEJOURS)
  if (eS) echec(`lecture des séjours : ${eS.message}`)
  if ((sejours || []).length >= MAX_SEJOURS) echec(`${MAX_SEJOURS} séjours de recette ou plus : lancez --nettoyer.`)
  if (!(sejours || []).length) { console.log('\nAucun séjour de recette.'); return }
  const { data: menages, error: eM } = await sb.from('menages').select('*')
    .eq('user_id', profil.account_user_id).like('booking_id', `${MARQUE}-%`)
  if (eM) echec(`lecture des ménages : ${eM.message}`)
  const ids = [...new Set((menages || []).flatMap(m => [m.provider_id, ...proposees(m)]).filter(Boolean).map(String))]
  const noms = new Map()
  if (ids.length) {
    const { data: ps, error: eP } = await sb.from('profiles').select('id, first_name').in('id', ids)
    if (eP) echec(`lecture des prénoms : ${eP.message}`)
    for (const x of ps || []) noms.set(String(x.id), x.first_name)
  }
  const nom = (id) => (id ? (noms.get(String(id)) || 'autre') : '—')
  console.log('\nSéjours de recette :')
  for (const r of sejours) {
    console.log(`  ${r.booking_id} · départ ${r.snapshot?.departure} · réservation ${r.snapshot?.status}`)
    const ms = (menages || []).filter(m => m.booking_id === r.booking_id)
    if (!ms.length) console.log('      pas encore de ménage (le cron le crée : --cron)')
    for (const m of ms) {
      // ⚠ Une validation ne vaut que pour QUI l'a posée (menages.vu_par).
      const vu = m.vu_le && String(m.vu_par) === String(m.provider_id) ? `vu le ${m.vu_le}` : 'pas vu'
      const qui = proposees(m)
      const offre = qui.length ? ` · proposé à ${qui.map(nom).join(', ')} jusqu'au ${m.offer_expires_at}` : ''
      const rel = [m.relance_vu_j1_le && 'veille', m.relance_vu_j0_le && 'jour même'].filter(Boolean)
      console.log(`      ménage ${m.status} · porté par ${nom(m.provider_id)}${offre} · ${vu}${rel.length ? ` · relancé (${rel.join(', ')})` : ''}`)
    }
  }
}

async function dernierSejour (compte, statut, voulu) {
  let q = sb.from('bookings_snapshot').select('id, booking_id, snapshot')
    .eq('user_id', compte).like('booking_id', `${MARQUE}-%`)
  if (voulu) q = q.eq('booking_id', voulu)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(MAX_SEJOURS)
  if (error) echec(`lecture des séjours : ${error.message}`)
  return (data || []).find(r => String(r.snapshot?.status || '') === statut) || null
}

function joursDuSejour () {
  const brut = val('sejour')
  if (brut == null || !/^\d+$/.test(brut) || Number(brut) > 60) {
    echec('--sejour attend un nombre de jours entre 0 et 60, collé au signe égal : --sejour=3 (0 = départ aujourd\'hui).')
  }
  return Number(brut)
}

async function sejour (ctx, n) {
  const compte = ctx.profil.account_user_id
  const depart = plusJours(jourParis(), n)
  const arrivee = plusJours(depart, -1)
  // ⚠ PAS DE CHEVAUCHEMENT : la sonde de surréservation du cron relancerait le
  // fondateur à chaque passage, et deux ménages naîtraient le même jour.
  const { data: voisins, error: eV } = await sb.from('bookings_snapshot')
    .select('booking_id, snapshot').eq('user_id', compte).eq('property_id', ctx.liaison.property_id)
    .lt('snapshot->>arrival', depart).gt('snapshot->>departure', arrivee).limit(MAX_SEJOURS)
  if (eV) echec(`lecture des séjours du bien : ${eV.message}`)
  const genants = (voisins || []).filter(v => isActiveStatus(v.snapshot, ctx.bien.provider))
  if (genants.length) {
    echec(`le bien a déjà un séjour confirmé sur ces dates (${genants.map(v => v.booking_id).join(', ')}). Choisissez un autre jour, ou --annuler d'abord.`)
  }
  const suffixe = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const ligne = {
    user_id: compte, booking_id: `${MARQUE}-${suffixe}`, property_id: ctx.liaison.property_id,
    snapshot: { provider: ctx.bien.provider || 'channex', source: 'Offline', arrival: arrivee,
                departure: depart, firstName: 'Voyageur', lastName: 'Recette', status: 'confirmed' }
  }
  const { error } = await sb.from('bookings_snapshot').insert(ligne)
  if (error) echec(`séjour : ${error.message}`)
  console.log(`ok    séjour ${ligne.booking_id} créé : départ le ${depart}. Le ménage naîtra au prochain --cron.`)
  if (n > JOURS_PROPOSITION && ctx.liaison.requires_ack) {
    console.log(`⚠     départ dans ${n} jours et bien « à confirmer » : la proposition ne sera posée qu'à ${JOURS_PROPOSITION} jours du départ.`)
  }
  console.log('')
}

async function changerStatut (ctx, de, vers, voulu) {
  const r = await dernierSejour(ctx.profil.account_user_id, de, voulu)
  if (!r) echec(`aucun séjour de recette en « ${de} »${voulu ? ` sous la référence ${voulu}` : ''}.`)
  const { data, error } = await sb.from('bookings_snapshot')
    // ⚠ `derive_le: null` : le statut change, donc l'argent dérivé du
    // snapshot est périmé (tests/snapshot-ecrit-invalide-les-derivees.test.js).
    .update({ snapshot: { ...r.snapshot, status: vers }, derive_le: null, updated_at: new Date().toISOString() })
    .eq('id', r.id).select('id')
  if (error) echec(`mise à jour : ${error.message}`)
  if ((data || []).length !== 1) echec(`mise à jour : ${(data || []).length} ligne modifiée au lieu d'une.`)
  console.log(`ok    ${r.booking_id} : réservation ${de} → ${vers}. Le ménage suivra au prochain --cron.\n`)
}

async function nettoyer () {
  const p = await profilBerthe()
  const compte = p.account_user_id
  const tables = ['menage_done', 'menages', 'bookings_snapshot']
  for (const t of tables) {
    const { data, error } = await sb.from(t).delete().eq('user_id', compte).like('booking_id', `${MARQUE}-%`).select('id')
    if (error) echec(`${t} : ${error.message}`)
    console.log(`ok    ${t} : ${(data || []).length} ligne(s) retirée(s)`)
  }
  for (const t of tables) {
    const { count, error } = await sb.from(t).select('id', { count: 'exact', head: true })
      .eq('user_id', compte).like('booking_id', `${MARQUE}-%`)
    if (error) echec(`recompte de ${t} : ${error.message}`)
    if (count) echec(`${t} : ${count} ligne(s) de recette restent.`)
  }
  console.log('ok    plus aucune ligne de recette.')
  console.log('      Lancez un --cron : il referme une éventuelle alarme de surréservation.\n')
}

async function cron () {
  const s = String(process.env.CRON_SECRET || '').trim()
  if (!s) echec('CRON_SECRET absent de l\'environnement : le cron de staging refuserait.')
  const t0 = Date.now()
  let rep, corps
  try {
    // ⚠ `redirect: 'error'` : l'en-tête d'autorisation ne suit jamais une
    // redirection, vers quelque domaine que ce soit.
    rep = await fetch(CRON_STAGING, { headers: { Authorization: `Bearer ${s}` }, redirect: 'error',
                                      signal: AbortSignal.timeout(120000) })
    corps = await rep.json().catch(() => null)
  } catch (e) { echec(`appel du cron : ${e.name === 'TimeoutError' ? 'pas de réponse en 2 minutes' : e.message}`) }
  console.log(`Cron de staging : HTTP ${rep.status} en ${Math.round((Date.now() - t0) / 1000)} s`)
  if (rep.status === 401 && corps && corps.error === 'Non autorisé') echec('CRON_SECRET refusé : la valeur locale n\'est pas celle du projet staging.')
  if (!rep.ok || !corps) echec('le passage n\'a pas abouti — voir les journaux du projet Vercel staging.')
  const relances = corps.relancesValidation == null ? 'non lancées (avant 9 h à Paris)' : corps.relancesValidation
  console.log(`  ménages créés : ${corps.totalMenagesCrees ?? '?'} · relances « Vu » : ${relances}`)
  const err = Array.isArray(corps.errors) ? corps.errors : []
  const contextes = [...new Set(err.map(e => (e && (e.context || e.etape)) || 'sans contexte'))]
  console.log(`  erreurs du passage : ${err.length}${err.length ? ' — ' + contextes.join(', ') : ''}\n`)
}

;(async () => {
  const actions = ['sejour', 'cron', 'annuler', 'retablir', 'nettoyer'].filter(n => a(n))
  if (actions.length > 1) echec(`une action à la fois (${actions.map(n => '--' + n).join(', ')}).`)
  const action = actions[0]

  if (action === 'nettoyer') return nettoyer()
  const jours = action === 'sejour' ? joursDuSejour() : null

  const ctx = await berthe()
  if (action === 'sejour') await sejour(ctx, jours)
  else if (action === 'annuler') await changerStatut(ctx, 'confirmed', 'cancelled', val('annuler'))
  else if (action === 'retablir') await changerStatut(ctx, 'cancelled', 'confirmed', val('retablir'))
  else if (action === 'cron') await cron()
  await etat(ctx)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
