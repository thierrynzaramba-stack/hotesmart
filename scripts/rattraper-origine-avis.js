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
//     gardeDuTitulaire) → ia_valide, ou ia_presta si ce profil est une
//     prestataire (`access_mode = 'lien'`, revue de ed445b2) ;
//   - `publiee` sans profil : publication automatique OU titulaire sans profil,
//     indiscernables → laissee nulle (« rédigé par l'IA ») ;
//   - `evaluee_ailleurs` → ailleurs.
//
//   node --env-file=<.env de la base visee> scripts/rattraper-origine-avis.js [--go --base=<STAGING|PRODUCTION>]
//
// Sans --go : AUCUNE ecriture. N'ecrit que des lignes dont l'origine est NULLE.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  if (go && !['STAGING', 'PRODUCTION'].includes(String(val('base') || '').toUpperCase())) { console.error('ECHEC : --go exige --base=STAGING ou --base=PRODUCTION'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { count, error: eC } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (eC || !Number.isInteger(count)) throw new Error(`empreinte illisible ${eC ? eC.message : ''}`)
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Projet ${base} · biens = ${count} · ${go ? 'ECRITURE' : 'sans --go : AUCUNE ecriture'}`)
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

  const { data, error } = await sb.from('guest_evaluations').select('id, status, validated_by_profile, published_at, origine_texte')
    .in('status', ['publiee', 'evaluee_ailleurs']).is('origine_texte', null)
  if (error) throw new Error(/origine_texte/.test(error.message) ? 'la colonne origine_texte n existe pas : appliquer la migration 2026-10-08-avis-origine-texte.sql d abord' : error.message)
  const profils = [...new Set(data.map(e => e.validated_by_profile).filter(Boolean))]
  const { data: pr, error: eP } = profils.length ? await sb.from('profiles').select('id, access_mode').in('id', profils) : { data: [], error: null }
  if (eP) throw new Error(`profils : ${eP.message}`)
  const modeDe = new Map((pr || []).map(p => [p.id, p.access_mode]))
  const plan = { ia_valide: [], ia_presta: [], ailleurs: [], indecidable: [] }
  for (const e of data) {
    if (e.status === 'evaluee_ailleurs') plan.ailleurs.push(e.id)
    else if (e.validated_by_profile && modeDe.get(e.validated_by_profile) === 'lien') plan.ia_presta.push(e.id)
    else if (e.validated_by_profile && modeDe.has(e.validated_by_profile)) plan.ia_valide.push(e.id)
    else plan.indecidable.push(e.id)
  }
  console.log(`  ${plan.ia_valide.length} publiee(s) par un profil → ia_valide (« rédigé par l'IA, validé par vous »)`)
  console.log(`  ${plan.ia_presta.length} publiee(s) par une prestataire → ia_presta (« rédigé par l'IA, validé par la prestataire »)`)
  console.log(`  ${plan.ailleurs.length} rangee(s) « évaluée sur Airbnb » → ailleurs`)
  console.log(`  ${plan.indecidable.length} publiee(s) sans profil : laissee(s) nulle(s) (« rédigé par l'IA »)`)
  if (!go) { console.log('Sans --go : AUCUNE ecriture.'); return }
  for (const [origine, ids] of [['ia_valide', plan.ia_valide], ['ia_presta', plan.ia_presta], ['ailleurs', plan.ailleurs]]) {
    if (!ids.length) continue
    const { data: faits, error: eU } = await sb.from('guest_evaluations').update({ origine_texte: origine })
      .in('id', ids).is('origine_texte', null).select('id')
    if (eU) throw new Error(`ecriture ${origine} : ${eU.message}`)
    console.log(`  ${faits.length} ligne(s) ecrite(s) : ${origine}`)
  }
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
