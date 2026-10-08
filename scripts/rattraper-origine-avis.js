#!/usr/bin/env node
// scripts/rattraper-origine-avis.js — recette de Thierry du 7 octobre 2026,
// point B : l'origine des evaluations DEJA publiees ou rangees, avant la
// colonne `origine_texte` (migration 2026-10-08-avis-origine-texte.sql).
//
// Decision de Thierry (8 octobre 2026) : « rédigé par l'IA », puis « validé par
// vous » ou « publié automatiquement » selon ce que la base dit REELLEMENT ; si
// elle ne permet pas de trancher, « rédigé par l'IA » seul (la colonne reste
// nulle, et l'ecran le dit ainsi).
//
// Ce que la base dit :
//   - `publiee` avec `validated_by_profile` renseigne : un PROFIL a publie —
//     la publication automatique, elle, n'en porte aucun (api/avis.js,
//     gardeDuTitulaire) → ia_valide ;
//   - `publiee` sans profil : publication automatique OU titulaire sans profil,
//     indiscernables → laissee nulle (« rédigé par l'IA ») ;
//   - `evaluee_ailleurs` → ailleurs.
//
//   node --env-file=<.env de la base visee> scripts/rattraper-origine-avis.js [--go --biens=<N>]
//
// Sans --go : AUCUNE ecriture. N'ecrit que des lignes dont l'origine est NULLE.

const { createClient } = require('@supabase/supabase-js')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (3 staging, 5 production)'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { count, error: eC } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (eC || !Number.isInteger(count)) throw new Error(`empreinte illisible ${eC ? eC.message : ''}`)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} (5 = production, 3 = staging) · ${go ? 'ECRITURE' : 'sans --go : AUCUNE ecriture'}`)
  if (go && Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count}`); process.exit(3) }

  const { data, error } = await sb.from('guest_evaluations').select('id, status, validated_by_profile, published_at, origine_texte')
    .in('status', ['publiee', 'evaluee_ailleurs']).is('origine_texte', null)
  if (error) throw new Error(/origine_texte/.test(error.message) ? 'la colonne origine_texte n existe pas : appliquer la migration 2026-10-08-avis-origine-texte.sql d abord' : error.message)
  const plan = { ia_valide: [], ailleurs: [], indecidable: [] }
  for (const e of data) {
    if (e.status === 'evaluee_ailleurs') plan.ailleurs.push(e.id)
    else if (e.validated_by_profile) plan.ia_valide.push(e.id)
    else plan.indecidable.push(e.id)
  }
  console.log(`  ${plan.ia_valide.length} publiee(s) par un profil → ia_valide (« rédigé par l'IA, validé par vous »)`)
  console.log(`  ${plan.ailleurs.length} rangee(s) « évaluée sur Airbnb » → ailleurs`)
  console.log(`  ${plan.indecidable.length} publiee(s) sans profil : laissee(s) nulle(s) (« rédigé par l'IA »)`)
  if (!go) { console.log('Sans --go : AUCUNE ecriture.'); return }
  for (const [origine, ids] of [['ia_valide', plan.ia_valide], ['ailleurs', plan.ailleurs]]) {
    if (!ids.length) continue
    const { data: faits, error: eU } = await sb.from('guest_evaluations').update({ origine_texte: origine })
      .in('id', ids).is('origine_texte', null).select('id')
    if (eU) throw new Error(`ecriture ${origine} : ${eU.message}`)
    console.log(`  ${faits.length} ligne(s) ecrite(s) : ${origine}`)
  }
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
