#!/usr/bin/env node
// scripts/verifier-index-price-log.js — la migration
// `migrations/2026-10-28-price-log-source-idx.sql` est-elle en place, et le
// comptage du menu YieldFlow repond-il sur CETTE base ?
//
//   node --env-file=<.env de la base visee> scripts/verifier-index-price-log.js
//
// ⚠ LECTURE SEULE. Aucune ecriture, aucun `rpc`, aucune suppression.
//
// ⚠ CE QU'IL PROUVE, ET CE QU'IL NE PROUVE PAS — MESURE, PAS SUPPOSE.
// L'API ne donne pas le catalogue : `pg_indexes` n'est pas expose, et le plan
// de requete est REFUSE par PostgREST sur ce projet. Mesure du 28 octobre 2026
// sur staging, en demandant le plan :
//   PGRST107 — None of these media types are available:
//   application/vnd.pgrst.plan+text
// Donc, honnetement :
//   · PROUVE      le contrat de requete — les trois colonnes existent, sont
//                 filtrables, et le comptage rend un ENTIER sur chaque bien
//                 de la base. C'est ce qui casserait si la table changeait.
//   · NON PROUVE  la presence de l'index lui-meme. C'est la dette 32 du
//                 depot, deja notee dans les autres verificateurs.
// Le script le DIT en toutes lettres a chaque passage. Un verificateur qui
// laisserait croire qu'il a prouve l'index serait pire que pas de
// verificateur : il rassurerait.
//
// ⚠ IL LANCE LA VRAIE REQUETE, PAS UNE COPIE. Elle vient de
// `lib/yield/menu-calendrier.js`, le module que l'endpoint utilise. Une copie
// ecrite ici deriverait du jour ou la requete change, et un double plus
// permissif que le vrai valide du code qui ne peut pas tourner.
//
// Sortie : 0 = contrat de requete tenu. 1 = base inconnue, rien lu, ou refus.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')
const { requetePrixAjustes, JOURS_COMPTEUR, SOURCE_MOTEUR } = require('../lib/yield/menu-calendrier')

const INDEX = 'price_display_log_source_idx'

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  // ─── L'EMPREINTE D'ABORD ────────────────────────────────────────────────
  // Un resultat qui ne dit pas OU il a ete obtenu ne prouve rien.
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  if (base === 'INCONNUE') {
    console.error('ECHEC : projet Supabase inconnu — ni la production, ni staging.')
    process.exit(1)
  }
  console.log(`Base ${base}`)
  console.log(`Index attendu : ${INDEX} (property_id, source, created_at)`)

  // ─── 1. LE CONTRAT DE REQUETE, SUR DE VRAIS BIENS ───────────────────────
  // ⚠ UN SCRIPT QUI N'A RIEN LU DOIT ECHOUER. Zero bien, zero comptage : il
  // n'y a rien a conclure, et surtout pas « tout va bien ».
  // ⚠ PAGINE PAR CURSEUR — constat de la review du 28 octobre 2026.
  // PostgREST rend 1000 lignes SANS erreur. Un verificateur qui lit sans
  // borne annoncerait « contrat de requete tenu » sur un echantillon tronque
  // en silence — dans un script dont tout l'objet est de REFUSER un faux
  // vert. Inerte aujourd'hui (7 biens sur staging), mais c'est la seule
  // lecture du lot qui croit avec le produit.
  const PAGE = 500
  const biens = []
  for (let depuis = 0; ; depuis += PAGE) {
    const { data, error } = await sb.from('properties')
      .select('id, user_id, name, pilote_tarifaire').order('id')
      .range(depuis, depuis + PAGE - 1)
    if (error) {
      console.error('ECHEC : lecture des biens impossible —', error.message)
      process.exit(1)
    }
    biens.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  if (!biens || !biens.length) {
    console.error('ECHEC : aucun bien sur cette base, le comptage n’a rien pu couvrir.')
    process.exit(1)
  }

  let echecs = 0
  let totalAjustes = 0
  const maintenantMs = Date.now()
  for (const b of biens) {
    // LA VRAIE REQUETE DE L'ENDPOINT, avec son cloisonnement par compte.
    const { count, error } = await requetePrixAjustes(sb, {
      propertyId: b.id, userId: b.user_id, maintenantMs
    })
    if (error || !Number.isInteger(count)) {
      echecs++
      console.log(`  \u2716 ${b.name} : ${error ? error.message : 'compte non entier'}`)
      continue
    }
    totalAjustes += count
    const pilote = b.pilote_tarifaire === 'yieldflow' ? 'pilote' : 'calendrier'
    console.log(`  \u2714 ${b.name} (${pilote}) : ${count} prix ajuste(s) sur ${JOURS_COMPTEUR} jours`)
  }

  // ─── 2. CE QUE L'API NE DONNE PAS, DIT EN TOUTES LETTRES ────────────────
  console.log('')
  console.log(`CONTRAT DE REQUETE : ${biens.length - echecs}/${biens.length} bien(s), `
    + `${totalAjustes} ligne(s) '${SOURCE_MOTEUR}' sur ${JOURS_COMPTEUR} jours.`)
  console.log(`INDEX ${INDEX} : NON PROUVE PAR L'API.`)
  console.log("  pg_indexes n'est pas expose et le plan de requete est refuse")
  console.log('  (PGRST107). Dette 32. La relecture du fichier de migration et')
  console.log("  le collage dans l'editeur sont ce qui l'atteste.")

  if (echecs) {
    console.error(`ECHEC : ${echecs} bien(s) sur ${biens.length}.`)
    process.exit(1)
  }
  console.log('OK : le comptage du menu YieldFlow repond sur cette base.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
