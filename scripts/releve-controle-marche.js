#!/usr/bin/env node
// scripts/releve-controle-marche.js — UN RELEVE DU CONTROLE PERMANENT (V2.5).
//
//   AIRROI_API_KEY="$AIRROI_KEY" node --env-file=.env.local scripts/releve-controle-marche.js --bien=<uuid> [--go]
//
// Etudie le bien (comparables retenus, cache d'abord), calcule la grille marche,
// la mesuree 12 mois et la mesuree 3 ans, et ECRIT une ligne dans
// `grille_controle` avec --go. Sans --go : rien n'est ecrit.
//
// ⚠ REGLE 19 : ce script N'AFFICHE JAMAIS un niveau ni un ecart — seulement le
// statut, les nombres de nuits et de comparables, et les avertissements de
// selection. Le critere de l'interrupteur se fixe AVANT la premiere lecture.
// ⚠ EMPREINTE : le projet Supabase et le nombre de biens sont affiches en tete
// (5 en production, 3 en staging).

const { createClient } = require('@supabase/supabase-js')
const { creerClient } = require('../lib/airroi/client')
const { depotSupabase } = require('../lib/airroi/depot')
const { etudierBien } = require('../lib/marche/etude')
const { grilleMarche } = require('../lib/marche/grille-marche')
const { construireReleve, enregistrerReleve, grilleMesureeDouzeMois } = require('../lib/marche/controle')
const { preparerContexte } = require('../lib/yield/contexte-du-bien')
const { sejoursAvecMenage } = require('../lib/marche/menage')

const args = process.argv.slice(2)
const bienId = (args.find(a => a.startsWith('--bien=')) || '').slice(7)
const go = args.includes('--go')
if (!bienId) { console.error('Usage : --bien=<uuid> [--go]'); process.exit(1) }

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (!Number.isInteger(count)) throw new Error('empreinte illisible (nombre de biens)')
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} · ${go ? 'ECRITURE du releve' : 'sans --go : appels AirROI (payants hors cache) mais AUCUNE ecriture du releve'}`)
  const { data: bien, error } = await sb.from('properties').select('*').eq('id', bienId).maybeSingle()
  if (error || !bien) throw new Error(`bien ${bienId} illisible`)
  const client = creerClient({ depot: depotSupabase(sb) })
  const e = await etudierBien({ supabase: sb, client, bien })
  if (e.refus) { console.log(`REFUS : ${e.message}`); process.exit(2) }
  const auj = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
  const marche = grilleMarche({ comparables: e.comparables, aujourdHui: auj, prixMinimum: e.prixMinimum })
  const ctx = await preparerContexte(sb, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin: auj })
  const mesure12 = grilleMesureeDouzeMois({ eclatements: ctx.eclatements, contexte: ctx.contexte, fenetre: marche.fenetre })
  const mesure12Airbnb = grilleMesureeDouzeMois({ eclatements: ctx.eclatements, contexte: ctx.contexte, fenetre: marche.fenetre, airbnbSeul: true })
  // Le drapeau de menage, fenetre par fenetre, depuis les payloads (dette 26).
  const menage = {
    trois_ans: sejoursAvecMenage(ctx.duBien, ctx.eclatements, ctx.debutHistorique, ctx.finRef),
    douze_mois: sejoursAvecMenage(ctx.duBien, ctx.eclatements, `${marche.fenetre.debut}-01`, `${marche.fenetre.fin}-31`)
  }
  const ligne = construireReleve({ bien, marche, mesure12, mesure12Airbnb, menage, grille3ans: ctx.grille, motif: 'manuel',
    releveLe: new Date().toISOString(), fraicheur: e.fraicheur })
  console.log(`${bien.name} : statut ${ligne.statut} · ${marche.comparables.length} comparable(s) · nuits marche ${ligne.nuits_marche} · nuits mesurees 12 mois ${ligne.nuits_mesure_12m} · fenetre ${ligne.fenetre_debut} → ${ligne.fenetre_fin}`)
  for (const a of ligne.avertissements.filter(a => a.type !== 'sous_plancher')) console.log(`  avertissement : ${a.phrase}`)
  console.log('  (niveaux et ecarts NON affiches : regle 19)')
  if (go) { await enregistrerReleve(sb, ligne); console.log('Releve ecrit.') }
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
