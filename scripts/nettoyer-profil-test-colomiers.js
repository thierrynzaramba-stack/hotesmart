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
//   node --env-file=<.env de la base visee> scripts/nettoyer-profil-test-colomiers.js [--go --base=PRODUCTION --statut=completed|unassigned]
//
// ⚠ UN MENAGE `accepted` DOIT AVOIR UN PORTEUR (contrainte
// menages_accepted_a_un_porteur, revue de ed445b2) : retirer la prestataire
// impose de changer son statut. Le choix est celui de Thierry, et --go l'exige :
//   completed  — le menage a eu lieu, par une personne non renseignee ;
//   unassigned — le menage n'a jamais ete attribue.
//
// Sans --go : AUCUNE ecriture, la liste exacte de ce qui serait ecrit.
// ⚠ --go EXIGE --base=PRODUCTION (l'identite du projet, pas un nombre) :
//   l'empreinte arrete une ecriture sur la mauvaise base.
// ⚠ BORNE : seuls les menages DE CE PROFIL, PASSES (depart avant aujourd'hui)
//   et non annules ; seules les evaluations `a_remplir` de CES sejours dont
//   l'echeance est passee. Au-dela de 13 menages ou 2 evaluations, il s'arrete
//   sans rien ecrire : la base ne ressemble plus au diagnostic.
// ⚠ Chaque menage modifie laisse sa trace dans `menage_assignment_log`.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const PROFIL_TEST = '6ed13b3c-c893-4ebd-987b-6a5c1e9e3490'
const ATTENDU = { menages: 13, evaluations: 2 }
const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  if (go && !['STAGING', 'PRODUCTION'].includes(String(val('base') || '').toUpperCase())) { console.error('ECHEC : --go exige --base=STAGING ou --base=PRODUCTION'); process.exit(1) }
  const statut = val('statut')
  if (go && !['completed', 'unassigned'].includes(statut)) { console.error('ECHEC : --go exige --statut=completed ou --statut=unassigned (un menage accepte doit avoir un porteur)'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { count, error: eC } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (eC || !Number.isInteger(count)) throw new Error(`empreinte illisible ${eC ? eC.message : ''}`)
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Base ${base} · biens = ${count} · ${go ? 'ECRITURE' : 'sans --go : AUCUNE ecriture'}`)
  // ⚠ L'OPERATEUR ANNONCE LA BASE, ET LE SCRIPT VERIFIE L'IDENTITE DU PROJET
  // — PLUS SON NOMBRE DE BIENS (26 octobre 2026, constat GRAVE de la review du
  // lot `fix-empreinte-par-projet`). L'accuse de reception humain GARDE sa
  // vertu : c'est lui qui protege d'un `--env-file` confondu, et il reste
  // exige. Ce qui change est ce qu'il annonce.
  //
  // Le compte de biens ne pouvait pas tenir ce role : staging en porte QUATRE
  // depuis qu'un bien y a ete cree, alors que l'aide de ce script disait
  // « 3 staging ». Un operateur qui suivait l'aide obtenait « mauvaise base »
  // SUR LA BONNE BASE — et le jour ou les deux bases porteraient le meme
  // nombre, il n'y aurait plus rien derriere : un `--env-file` confondu
  // ecrirait sur la mauvaise base en silence. La reference du projet, elle, ne
  // derive pas avec la donnee.
  if (base === 'INCONNUE') { console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging. Rien n'est ecrit.`); process.exit(3) }
  if (go && String(val('base')).toUpperCase() !== base) { console.error(`ECHEC : --base=${val('base')} annonce, la base est ${base} — mauvaise base, rien n'est ecrit`); process.exit(3) }

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
  for (const m of menages) console.log(`  ${m.departure_date}  ${m.status}  menage ${m.id.slice(0, 8)}  sejour ${String(m.booking_id).slice(0, 8)}  → prestataire non renseigne${m.status === 'accepted' ? `, statut ${statut || '<--statut a choisir>'}` : ''}`)
  console.log(`\n${evals.length} evaluation(s) hors delai de ces sejours :`)
  for (const e of evals) console.log(`  sejour ${String(e.booking_uid).slice(0, 8)}  echeance ${String(e.deadline_at).slice(0, 10)}  a_remplir → expiree`)
  if (menages.length > ATTENDU.menages || evals.length > ATTENDU.evaluations) {
    console.error(`\nECHEC : plus que le diagnostic (${ATTENDU.menages} menages, ${ATTENDU.evaluations} evaluations) — rien n'est ecrit`)
    process.exit(4)
  }
  if (!go) { console.log('\nSans --go : AUCUNE ecriture.'); return }

  const ids = menages.map(m => m.id)
  if (ids.length) {
    // Un seul UPDATE par statut d'origine : `accepted` change de statut avec son
    // porteur (contrainte), les autres ne perdent que leur porteur.
    const acceptes = menages.filter(m => m.status === 'accepted').map(m => m.id)
    const autres = ids.filter(id => !acceptes.includes(id))
    const faits = []
    for (const [lot, maj] of [[acceptes, { provider_id: null, status: statut }], [autres, { provider_id: null }]]) {
      if (!lot.length) continue
      const { data: d, error } = await sb.from('menages').update({ ...maj, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('provider_id', PROFIL_TEST).in('id', lot).select('id')
      if (error) throw new Error(`ecriture menages : ${error.message}`)
      faits.push(...(d || []))
    }
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
