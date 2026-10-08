#!/usr/bin/env node
// scripts/nettoyer-profil-test-colomiers.js — recette de Thierry du 7 octobre
// 2026, point F : « ménage : test » sur Colomiers.
//
// Le profil prestataire « test » (6ed13b3c, cree le 3 septembre 2026 pendant
// les essais du chantier prestataires, desactive) est encore inscrit sur 13
// menages PASSES de Colomiers (departs du 7 aout au 6 septembre 2026). Decision
// de Thierry : le retirer (prestataire non renseigne) et passer en « expiree »
// les evaluations hors delai de ces sejours.
//
//   node --env-file=<.env de la base visee> scripts/nettoyer-profil-test-colomiers.js [--go --biens=5]
//
// Sans --go : AUCUNE ecriture, la liste exacte de ce qui serait ecrit.
// ⚠ --go EXIGE --biens=N, le nombre de biens de la base visee (5 production) :
//   l'empreinte arrete une ecriture sur la mauvaise base.
// ⚠ BORNE : seuls les menages DE CE PROFIL, PASSES (depart avant aujourd'hui)
//   et non annules ; seules les evaluations `a_remplir` de CES sejours dont
//   l'echeance est passee. Au-dela de 13 menages ou 2 evaluations, il s'arrete
//   sans rien ecrire : la base ne ressemble plus au diagnostic.
// ⚠ Chaque menage modifie laisse sa trace dans `menage_assignment_log`.

const { createClient } = require('@supabase/supabase-js')

const PROFIL_TEST = '6ed13b3c-c893-4ebd-987b-6a5c1e9e3490'
const ATTENDU = { menages: 13, evaluations: 2 }
const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (5 production)'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { count, error: eC } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (eC || !Number.isInteger(count)) throw new Error(`empreinte illisible ${eC ? eC.message : ''}`)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} · ${go ? 'ECRITURE' : 'sans --go : AUCUNE ecriture'}`)
  if (go && Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count}`); process.exit(3) }

  const { data: p, error: eP } = await sb.from('profiles').select('id, account_user_id, first_name, last_name, active, access_mode').eq('id', PROFIL_TEST).maybeSingle()
  if (eP || !p) throw new Error(`profil ${PROFIL_TEST} introuvable dans cette base`)
  if (p.first_name !== 'test' || p.active !== false || p.access_mode !== 'lien') throw new Error(`le profil ne ressemble pas au profil de test : ${JSON.stringify({ prenom: p.first_name, actif: p.active, acces: p.access_mode })}`)
  const userId = p.account_user_id
  const aujourdhui = new Date().toISOString().slice(0, 10)

  const { data: menages, error: eM } = await sb.from('menages').select('id, booking_id, departure_date, status, provider_id')
    .eq('user_id', userId).eq('provider_id', PROFIL_TEST).lt('departure_date', aujourdhui).neq('status', 'cancelled').order('departure_date')
  if (eM) throw new Error(`menages : ${eM.message}`)
  const uids = menages.map(m => m.booking_id)
  const { data: evals, error: eE } = uids.length
    ? await sb.from('guest_evaluations').select('id, booking_uid, status, deadline_at').eq('user_id', userId).in('booking_uid', uids)
      .eq('status', 'a_remplir').lt('deadline_at', new Date().toISOString())
    : { data: [], error: null }
  if (eE) throw new Error(`evaluations : ${eE.message}`)

  console.log(`\n${menages.length} menage(s) passe(s) portent le profil « test » :`)
  for (const m of menages) console.log(`  ${m.departure_date}  ${m.status}  menage ${m.id.slice(0, 8)}  sejour ${String(m.booking_id).slice(0, 8)}  → prestataire non renseigne`)
  console.log(`\n${evals.length} evaluation(s) hors delai de ces sejours :`)
  for (const e of evals) console.log(`  sejour ${String(e.booking_uid).slice(0, 8)}  echeance ${String(e.deadline_at).slice(0, 10)}  a_remplir → expiree`)
  if (menages.length > ATTENDU.menages || evals.length > ATTENDU.evaluations) {
    console.error(`\nECHEC : plus que le diagnostic (${ATTENDU.menages} menages, ${ATTENDU.evaluations} evaluations) — rien n'est ecrit`)
    process.exit(4)
  }
  if (!go) { console.log('\nSans --go : AUCUNE ecriture.'); return }

  const ids = menages.map(m => m.id)
  if (ids.length) {
    const { data: faits, error } = await sb.from('menages').update({ provider_id: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('provider_id', PROFIL_TEST).in('id', ids).select('id')
    if (error) throw new Error(`ecriture menages : ${error.message}`)
    console.log(`\n${faits.length} menage(s) : prestataire retire.`)
    const { error: eL } = await sb.from('menage_assignment_log').insert(faits.map(f => ({
      user_id: userId, menage_id: f.id, event: 'manual_assign', from_provider_id: PROFIL_TEST, to_provider_id: null,
      actor: 'host', reason: 'Profil de test retire (recette du 7 octobre 2026, decision de Thierry).',
    })))
    if (eL) console.error(`journal non ecrit (les menages sont modifies) : ${eL.message}`)
  }
  if (evals.length) {
    const { data: faites, error } = await sb.from('guest_evaluations').update({ status: 'expiree', updated_at: new Date().toISOString() })
      .eq('user_id', userId).in('id', evals.map(e => e.id)).eq('status', 'a_remplir').select('id')
    if (error) throw new Error(`ecriture evaluations : ${error.message}`)
    console.log(`${faites.length} evaluation(s) passee(s) en « expiree ».`)
  }
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
