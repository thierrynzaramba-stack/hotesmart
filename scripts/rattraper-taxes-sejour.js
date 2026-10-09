#!/usr/bin/env node
// scripts/rattraper-taxes-sejour.js — remplit `taxes_sejour` pour toutes les
// reservations deja dans le coeur (spec docs/specs/spec-taxe-sejour.md §2, lot 1).
//
//   node --env-file=<.env de la base visee> scripts/rattraper-taxes-sejour.js         (a blanc)
//   node --env-file=<.env de la base visee> scripts/rattraper-taxes-sejour.js --go --projet=<ref>   (ecrit)
//
// ⚠ `--projet=<ref>` est EXIGE avec --go (revue de 049d3ed) : la reference du
// projet Supabase vise (affichee a blanc). Un mauvais --env-file est refuse au
// lieu d'ecrire sur la mauvaise base.
// ⚠ UNE RESERVATION MODIFIEE PENDANT LE RATTRAPAGE N'EST PAS ECRASEE : juste
// avant d'ecrire, l'empreinte `raw_hash` de chaque reservation est relue ; si
// elle a change, la couche sync a deja ecrit (ou ecrira) la taxe a jour, et le
// rattrapage passe.
//
// ⚠ AUCUN APPEL PROVIDER : on relit `bookings_snapshot.raw`, le payload integral
// deja conserve. La lecture est celle de la couche sync (lib/taxe-sejour/lecture.js)
// et l'ecriture passe par le writer unique (lib/taxe-sejour/writer.js).
// ⚠ A BLANC PAR DEFAUT : sans --go, rien n'est ecrit — le rapport seulement.
// ⚠ AVEC --go, L'ECRITURE DE MASSE S'ANNONCE AVANT D'ECRIRE (regle du
// 14 septembre 2026) : incident `ecriture_de_masse_annoncee`, relu en base ;
// sans trace, rien n'est ecrit.
// ⚠ AUCUNE ALERTE A L'HOTE (spec §4 bis) : le controle de coherence est le lot 4.
// Rejouable : upsert sur (user_id, booking_id).

const { createClient } = require('@supabase/supabase-js')
const { taxeSejourDe } = require('../lib/taxe-sejour/lecture')
const { ligneTaxe, ecrireLot, TABLE } = require('../lib/taxe-sejour/writer')

const GO = process.argv.includes('--go')
const PROJET = (process.argv.find(a => a.startsWith('--projet=')) || '').slice('--projet='.length)
const PAGE = 200

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  const { data: biens, error: eB } = await sb.from('properties').select('id, user_id, name, provider_property_id')
  if (eB || !biens) { console.error('ECHEC : biens illisibles', eB ? eB.message : ''); process.exit(1) }
  console.log(`Projet ${projet} · biens = ${biens.length} (5 = production, 3 = staging) · ${GO ? 'ECRITURE (--go)' : 'A BLANC'}`)
  if (GO && PROJET !== projet) { console.error(`REFUS : --projet=${PROJET || '(absent)'} ne designe pas la base ouverte (${projet}). Rien n a ete ecrit.`); process.exit(1) }

  const { count: total, error: eC } = await sb.from('bookings_snapshot').select('id', { count: 'exact', head: true })
  if (eC || !Number.isInteger(total)) { console.error('ECHEC : compte des reservations illisible'); process.exit(1) }

  // Pagination sur `id` (cle unique) : une lecture non bornee serait tronquee a
  // 1000 lignes sans erreur (vecu du 14 septembre 2026).
  const lignes = []
  let sansRaw = 0
  for (let a = 0; ; a += PAGE) {
    const { data, error } = await sb.from('bookings_snapshot')
      .select('user_id, booking_id, property_id, snapshot, raw, raw_hash').order('id').range(a, a + PAGE - 1)
    if (error) { console.error('ECHEC : lecture des reservations', error.message); process.exit(1) }
    for (const l of data) {
      if (l.raw == null) { sansRaw++; continue }
      const lu = taxeSejourDe(l.snapshot, l.raw, l.snapshot?.provider)
      const bien = biens.filter(b => b.user_id === l.user_id && String(b.provider_property_id) === String(l.property_id))
      lignes.push({ lu, nom: bien.length === 1 ? bien[0].name : `(cle ${l.property_id})`,
        canal: `${l.snapshot?.provider || '?'}/${l.snapshot?.source || '?'}`,
        ligne: ligneTaxe({ userId: l.user_id, bookingId: l.booking_id, propertyId: l.property_id,
          propertyUuid: bien.length === 1 ? bien[0].id : null, rawHash: l.raw_hash || null, lu }) })
    }
    if (data.length < PAGE) break
  }
  // Un rattrapage qui n'a pas tout lu ne doit pas se dire complet.
  if (lignes.length + sansRaw !== total) { console.error(`ECHEC : lu ${lignes.length + sansRaw} reservations sur ${total}`); process.exit(1) }
  if (!lignes.length) { console.error('ECHEC : aucune reservation lisible — rien a rattraper ne veut pas dire tout va bien'); process.exit(1) }

  const agg = new Map()
  const inconnus = new Map()
  for (const x of lignes) {
    const k = [x.nom, x.canal, x.lu.collecteur, x.lu.origine].join(' | ')
    const a = agg.get(k) || { n: 0, cents: 0 }
    a.n++; a.cents += x.lu.montant_cents || 0
    agg.set(k, a)
    for (const l of x.lu.libelles_inconnus) inconnus.set(l, (inconnus.get(l) || 0) + 1)
  }
  console.log(`\nReservations : ${total} · avec payload : ${lignes.length} · sans payload (ignorees) : ${sansRaw}`)
  console.log('\nbien | canal | collecteur | origine | reservations | taxe')
  for (const [k, a] of [...agg.entries()].sort()) console.log(`  ${k} | ${a.n} | ${(a.cents / 100).toFixed(2)} €`)
  console.log(`\nLibelles de taxe non classes (Airbnb et Booking, non comptes) : ${inconnus.size ? [...inconnus].map(([l, n]) => `${l} (${n})`).join(', ') : 'aucun'}`)
  console.log(`Sans bien resolu (property_uuid vide) : ${lignes.filter(x => !x.ligne.property_uuid).length}`)

  if (!GO) { console.log(`\nA BLANC : rien n'a ete ecrit. ${lignes.length} lignes ${TABLE} seraient ecrites (upsert).`); process.exit(0) }

  // ── L'INCIDENT, AVANT D'ECRIRE.
  const t0 = new Date(Date.now() - 1000).toISOString()
  const { reportIncident } = require('../lib/founder-notify')
  await reportIncident('ecriture_de_masse_annoncee', {
    propertyId: TABLE,
    detail: {
      message: `Rattrapage de la taxe de sejour : ${lignes.length} lignes ${TABLE} (une par reservation), relues dans bookings_snapshot.raw. Croissance attendue, ce n'est PAS une boucle d'ecriture.`,
      script: 'scripts/rattraper-taxes-sejour.js', date: new Date().toISOString(), compte: lignes.length,
      spec: 'docs/specs/spec-taxe-sejour.md §2',
    },
  })
  const { data: trace, error: eT } = await sb.from('automation_incidents').select('id')
    .eq('type', 'ecriture_de_masse_annoncee').eq('property_id', TABLE).gte('created_at', t0)
  if (eT || !(trace || []).length) { console.error('REFUS : l incident n est pas en base —', eT ? eT.message : 'aucune ligne', '— rien n a ete ecrit.'); process.exit(1) }
  console.log(`\nIncident pose et relu (ecriture_de_masse_annoncee, ${trace[0].id}).`)

  // Relecture des empreintes juste avant d'ecrire : une reservation modifiee
  // depuis la lecture est laissee a la couche sync.
  let ecrites = 0, passees = 0
  for (let i = 0; i < lignes.length; i += PAGE) {
    const tranche = lignes.slice(i, i + PAGE).map(x => x.ligne)
    const parCompte = new Map()
    for (const l of tranche) parCompte.set(l.user_id, [...(parCompte.get(l.user_id) || []), l.booking_id])
    const actuelles = new Map()
    for (const [uid, ids] of parCompte) {
      const { data, error } = await sb.from('bookings_snapshot').select('booking_id, raw_hash').eq('user_id', uid).in('booking_id', ids)
      if (error) { console.error(`ECHEC apres ${ecrites} lignes : relecture des empreintes — ${error.message}`); process.exit(2) }
      for (const d of data) actuelles.set(`${uid}|${d.booking_id}`, d.raw_hash || null)
    }
    const aEcrire = tranche.filter(l => actuelles.get(`${l.user_id}|${l.booking_id}`) === l.raw_hash)
    passees += tranche.length - aEcrire.length
    const r = await ecrireLot(sb, aEcrire)
    ecrites += r.ecrites
    if (r.erreur) { console.error(`ECHEC apres ${ecrites} lignes : ${r.erreur}`); process.exit(2) }
  }
  const r = { ecrites }
  if (passees) console.log(`${passees} reservation(s) modifiee(s) pendant le rattrapage : laissees a la couche sync.`)
  const { count: enBase, error: eN } = await sb.from(TABLE).select('id', { count: 'exact', head: true })
  if (eN) { console.error('ECHEC : relecture du compte', eN.message); process.exit(2) }
  console.log(`Ecrites : ${r.ecrites} · lignes en base : ${enBase}`)
  if (enBase < lignes.length - passees) { console.error('ECHEC : moins de lignes en base que de reservations rattrapees'); process.exit(2) }
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
