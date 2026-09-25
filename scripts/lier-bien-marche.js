#!/usr/bin/env node
// scripts/lier-bien-marche.js — RELIER UN LOGEMENT A SON MARCHE. Lot V2.3.4.
// Seul writer de `marche_biens` (migration 2026-09-24-marche-biens.sql).
//
//   node --env-file=<.env de la base visee> scripts/lier-bien-marche.js \
//     --bien=<uuid> --pays=France --region=Occitania --localite="Bagnères-de-Bigorre" [--go --biens=<N>]
//
// ⚠ SAISIE DU FONDATEUR, comme la liste des comparables : aucun appel AirROI
// (le marche se lit sur `markets/lookup` au moment de l'etude ; ici on le
// nomme). Sans --go : AUCUNE ecriture. --go exige --biens=N, qui doit etre le
// nombre de biens de la base visee (3 staging, 5 production).
// ⚠ AJOUT SEUL : un logement deja relie est refuse (unicite), jamais relie
// en silence a un autre marche.
// ⚠ N'ECRIT QUE dans `marche_biens`. Aucun prix.

const { createClient } = require('@supabase/supabase-js')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  // Forme NFC : la cle du cache depend des octets (« Bagnères »).
  const [bien, pays, region, localite] = ['bien', 'pays', 'region', 'localite'].map(val).map(v => (v == null ? v : v.normalize('NFC')))
  if (!bien || !pays || !region || !localite) { console.error('Usage : --bien=<uuid> --pays= --region= --localite= [--go --biens=<N>]'); process.exit(1) }
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (3 staging, 5 production)'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} (5 = production, 3 = staging) · ${go ? 'ECRITURE dans marche_biens' : 'sans --go : AUCUNE ecriture'}`)
  if (go && Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count} — mauvaise base, rien n'est ecrit`); process.exit(3) }
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
