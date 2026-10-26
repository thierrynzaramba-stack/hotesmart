#!/usr/bin/env node
// scripts/lier-bien-marche.js — RELIER UN LOGEMENT A SON MARCHE. Lot V2.3.4.
// Seul writer de `marche_biens` (migration 2026-09-24-marche-biens.sql).
//
//   node --env-file=<.env de la base visee> scripts/lier-bien-marche.js \
//     --bien=<uuid> --pays=France --region=Occitania --localite="Bagnères-de-Bigorre" [--go --base=<STAGING|PRODUCTION>]
//
// ⚠ SAISIE DU FONDATEUR, comme la liste des comparables : aucun appel AirROI
// (le marche se lit sur `markets/lookup` au moment de l'etude ; ici on le
// nomme). Sans --go : AUCUNE ecriture. --go exige --base=STAGING ou
// --base=PRODUCTION : l'operateur annonce la base, le script verifie la
// REFERENCE DU PROJET (lib/empreinte-base.js).
// ⚠ AJOUT SEUL : un logement deja relie est refuse (unicite), jamais relie
// en silence a un autre marche.
// ⚠ N'ECRIT QUE dans `marche_biens`. Aucun prix.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  // Forme NFC : la cle du cache depend des octets (« Bagnères »).
  const [bien, pays, region, localite] = ['bien', 'pays', 'region', 'localite'].map(val).map(v => (v == null ? v : v.normalize('NFC')))
  if (!bien || !pays || !region || !localite) { console.error('Usage : --bien=<uuid> --pays= --region= --localite= [--go --base=<STAGING|PRODUCTION>]'); process.exit(1) }
  if (go && !['STAGING', 'PRODUCTION'].includes(String(val('base') || '').toUpperCase())) { console.error('ECHEC : --go exige --base=STAGING ou --base=PRODUCTION'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Projet ${base} · biens = ${count} · ${go ? 'ECRITURE dans marche_biens' : 'sans --go : AUCUNE ecriture'}`)
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
  const { data: p, error: e } = await sb.from('properties').select('id, user_id, name').eq('id', bien).maybeSingle()
  if (e || !p) throw new Error(`logement ${bien} introuvable dans cette base`)
  const ligne = { user_id: p.user_id, property_id: p.id, pays, region, localite, lie_par: 'fondateur' }
  console.log(`${p.name} → ${localite} (${region}, ${pays})`)
  if (!go) return
  const { error: ei } = await sb.from('marche_biens').insert(ligne)
  if (ei && ei.code === '23505') throw new Error(`${p.name} est deja relie a un marche : rien n'est reecrit`)
  if (ei) throw new Error(`ecriture : ${ei.message}`)
  console.log('Lien ecrit dans marche_biens.')
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
