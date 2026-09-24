#!/usr/bin/env node
// scripts/calculer-calendrier-marche.js — LE CALENDRIER DU MARCHE, CALCULE ET
// (avec --go) STOCKE dans `marche_calendrier`. Lot V2.3.3.
//
//   node --env-file=<.env de la base visee> scripts/calculer-calendrier-marche.js \
//     --pacing=tests/fixtures/airroi/pacing-bagneres-2026-09-24.json \
//     --marche60=tests/fixtures/airroi/marche-60.json [--go --biens=<N>]
//
// ⚠ --go EXIGE --biens=N, et N doit etre le nombre de biens de la base
// visee (3 staging, 5 production) : l'empreinte n'est pas qu'affichee, elle
// arrete une ecriture sur la mauvaise base (review).
//
// ⚠ AUCUN APPEL AIRROI : le pacing et les 60 mois viennent de fichiers (la
// capture du 24 septembre, deja payee). Les vacances viennent de la BASE
// visee (lecture seule, `lib/yield/vacances.js`).
// ⚠ EMPREINTE en tete : projet et nombre de biens (5 = production,
// 3 = staging). Sans --go : AUCUNE ecriture, le resume seulement.
// ⚠ N'ECRIT QUE dans `marche_calendrier` (writer unique). Aucun prix.

const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const { lireVacances } = require('../lib/yield/vacances')
const { construireLigne, enregistrerCalendrier } = require('../lib/marche/calendrier-marche')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')
const lire = f => JSON.parse(fs.readFileSync(f, 'utf8'))

;(async () => {
  if (!val('pacing') || !val('marche60')) { console.error('Usage : --pacing=<fichier> --marche60=<fichier> [--go --biens=<N>]'); process.exit(1) }
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (3 staging, 5 production)'); process.exit(1) }
  const pacing = lire(val('pacing'))
  const marche60 = val('marche60') ? lire(val('marche60')) : null
  if (!pacing.market) throw new Error('le fichier de pacing ne porte pas son marche (cle `market`)')
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} (5 = production, 3 = staging) · ${go ? 'ECRITURE dans marche_calendrier' : 'sans --go : AUCUNE ecriture'}`)
  if (go && Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count} — mauvaise base, rien n'est ecrit`); process.exit(3) }

  const dates = (pacing.results || []).map(x => x.date).filter(Boolean).sort()
  // ⚠ UNE MARGE AVANT LA FENETRE : la couverture se juge sur l'etendue de la
  // source ; lue a partir du premier jour du pacing, elle croyait la source
  // commencee aux premieres vacances DANS la fenetre (17 octobre) et refusait
  // un calendrier pourtant complet (vecu le 24 septembre 2026).
  const marge = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 200 * 86400000).toISOString().slice(0, 10)
  const vacances = await lireVacances(sb, marge, dates[dates.length - 1])
  const ligne = construireLigne({ marche: pacing.market, pacing, marche60, vacances, calculeLe: new Date().toISOString() })
  console.log(`${ligne.localite} · capture du ${ligne.capture_le} · statut ${ligne.statut}${ligne.motif ? ` (${ligne.motif})` : ''} · methode ${ligne.methode}`)
  if (ligne.statut === 'calcule') {
    console.log(`  horizon ${ligne.horizon_fin} · ${ligne.saisons.length} saisons · ${ligne.ruptures.length} ruptures · ${ligne.evenements_possibles.length} evenement(s) possible(s), a lire · vacances lues : ${vacances.length} periode(s)`)
    for (const r of ligne.regimes) console.log(`  regime ${r.regime} : ${r.debut} → ${r.fin}`)
  }
  if (go) { await enregistrerCalendrier(sb, ligne); console.log('Calendrier ecrit dans marche_calendrier.') }
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
