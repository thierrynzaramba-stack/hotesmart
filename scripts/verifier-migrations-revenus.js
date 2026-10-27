#!/usr/bin/env node
// scripts/verifier-migrations-revenus.js
// Les CINQ migrations du lot Revenus non couvertes sont-elles appliquees ?
//
// Les deux premieres du lot ont deja le leur
// (`verifier-migration-delais-versement.js`). Celui-ci couvre les cinq autres :
//   3. 2026-10-27-revenus-derives.sql        colonnes, fonctions, droits
//   4. 2026-10-27-est-blocage.sql            la colonne du blocage
//   5. 2026-10-26-revenus-hors-biens.sql     la signature a TROIS arguments
//   6. 2026-10-26-revenus-calcul-incomplet.sql  la sonde, et son droit
//   7. 2026-10-27-derive-raw-hash.sql        l'empreinte du payload
//
// ⚠ POURQUOI IL EXISTE. La regle du depot est qu'une migration se prouve en
// lancant un verificateur CONTRE LA BASE, pas a l'oeil : la table `fermetures`
// a manque en production une journee entiere parce que « appliquee » avait ete
// ecrit sans etre mesure. Demande par la session chef de file avant le go prod.
//
// ⚠ ET IL N'INTERROGE PAS DES NOMS, IL INTERROGE DES COMPORTEMENTS. Demander
// « la colonne existe-t-elle ? » ne suffit pas : `add column if not exists` et
// `create index if not exists` reussissent EN SILENCE sur un objet de forme
// differente, et `create or replace function` avec une signature differente
// cree une SURCHARGE au lieu de remplacer. On appelle donc, et on regarde ce
// que la base repond.
//
// LECTURE SEULE, sans exception et sans `--go` : il peut donc tourner contre la
// PRODUCTION, et c'est la que ca compte.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migrations-revenus.js
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/verifier-migrations-revenus.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY

if (!URL || !SERVICE) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}

// ─── LA BASE SE NOMME PAR SA REFERENCE DE PROJET, JAMAIS PAR SON CONTENU ───
//
// ⚠ UN VERIFICATEUR QUI CONTINUE SUR UNE BASE INCONNUE REND UN RESULTAT DONT
// PERSONNE NE POURRA DIRE D'OU IL VIENT. Et la menace n'est pas un attaquant :
// c'est un `.env` mal colle, ou `ENV_FILE` oublie — auquel cas ce script dirait
// « LES CINQ MIGRATIONS SONT APPLIQUEES » d'une base que personne n'a voulu
// interroger. `tests/empreinte-base.test.js` tient cette regle pour TOUS les
// scripts qui mesurent, et il a refuse celui-ci a sa premiere version.
const projet = refDuProjet(URL)
const base = nomDeLaBase(URL)
if (base === 'INCONNUE') {
  console.error(`ECHEC : projet « ${projet} » inconnu de lib/empreinte-base.js.`)
  console.error('Aucune mesure ne sera faite : un resultat sans base nommee ne')
  console.error('vaut rien. Verifiez ENV_FILE et SUPABASE_URL.')
  process.exit(2)
}

const sb = createClient(URL, SERVICE, { auth: { persistSession: false } })
const pub = ANON ? createClient(URL, ANON, { auth: { persistSession: false } }) : null

// Les dix colonnes de la migration 3, dans l'ordre du fichier.
const COLONNES_3 = [
  'property_uuid', 'canal', 'statut_canonique', 'montant_net_cents',
  'montant_est_brut', 'commission_cents', 'date_versement',
  'motif_non_calculable', 'derive_le', 'derive_version'
]

const UUID_NUL = '00000000-0000-0000-0000-000000000000'
const resultats = []
const nonCouvert = []

function dire (migration, quoi, ok, detail) {
  resultats.push({ migration, quoi, ok, detail })
  console.log(`  ${ok ? 'ok   ' : 'ECHEC'}  ${migration} · ${quoi}${detail ? ' — ' + detail : ''}`)
}

// ⚠ UNE COLONNE ABSENTE SE RECONNAIT A SON CODE, PAS A SON TEXTE. PostgREST
// rend `42703` (undefined_column) ; se fier au message, c'est dependre de la
// langue et de la version du serveur.
const colonneAbsente = (e) => !!e && (e.code === '42703' || /does not exist/i.test(e.message || ''))
// Et une fonction absente ou de signature differente rend `PGRST202`.
const fonctionIntrouvable = (e) => !!e && (e.code === 'PGRST202' || /could not find the function/i.test(e.message || ''))

async function colonnesLisibles (migration, colonnes) {
  // Une seule requete : si elle passe, les colonnes nommees existent toutes.
  // On ne demande AUCUNE ligne (`limit 0`) — la forme nous interesse, pas la
  // donnee, et ca vaut aussi contre la production.
  const { error } = await sb.from('bookings_snapshot').select(colonnes.join(', ')).limit(0)
  if (error && colonneAbsente(error)) {
    dire(migration, `les ${colonnes.length} colonne(s)`, false, error.message)
    return false
  }
  if (error) {
    dire(migration, `les ${colonnes.length} colonne(s)`, false, 'lecture impossible : ' + error.message)
    return false
  }
  dire(migration, `les ${colonnes.length} colonne(s) sont lisibles`, true, colonnes.join(', '))
  return true
}

async function main () {
  console.log(`Base : ${base} (${projet})`)
  console.log('Lecture seule. Aucune ecriture, aucun `--go`.\n')
  if (!pub) {
    console.log('⚠ SUPABASE_ANON_KEY absente : les DROITS ne seront pas eprouves.')
    console.log('  Un `revoke` non verifie est une regle qu on croit acquise.\n')
  }

  // ─── Migration 3 : les colonnes derivees, et les deux agregats ───────────
  await colonnesLisibles('migration 3', COLONNES_3)

  {
    const { error } = await sb.rpc('revenus_du_mois', {
      p_user_id: UUID_NUL, p_mois: '2026-10', p_aujourdhui: '2026-10-27', p_refs: null
    })
    dire('migration 3', 'revenus_du_mois(4 arguments) repond', !error,
      error ? (fonctionIntrouvable(error) ? 'fonction introuvable avec CETTE signature' : error.message) : '')
  }

  // ─── Migration 4 : la colonne du blocage ─────────────────────────────────
  await colonnesLisibles('migration 4', ['est_blocage'])

  // ─── Migration 5 : la signature a TROIS arguments, et UNE SEULE ──────────
  {
    const { error } = await sb.rpc('revenus_hors_mois', {
      p_user_id: UUID_NUL, p_mois: '2026-10', p_refs: null
    })
    dire('migration 5', 'revenus_hors_mois(3 arguments) repond', !error,
      error ? (fonctionIntrouvable(error) ? 'fonction introuvable avec CETTE signature' : error.message) : '')
  }
  {
    // ⚠ LE TEST QUI COMPTE DE LA MIGRATION 5. L'ancienne signature a DEUX
    // arguments doit avoir DISPARU. `create or replace function` avec une
    // signature differente ne remplace pas : il cree une SURCHARGE, et les deux
    // versions repondent alors — celle que PostgREST choisit n'etant pas celle
    // qu'on croit. `p_mois` n'a pas de valeur par defaut : un appel a deux
    // arguments ne peut donc reussir QUE si l'ancienne version vit encore.
    const { error } = await sb.rpc('revenus_hors_mois', { p_user_id: UUID_NUL, p_refs: null })
    const bien = fonctionIntrouvable(error)
    dire('migration 5', 'l ancienne signature a 2 arguments est bien PARTIE', bien,
      bien ? '' : (error ? error.message : 'ELLE REPOND ENCORE : deux versions coexistent'))
  }

  // ─── Migration 6 : la sonde, et son droit ────────────────────────────────
  {
    const { error } = await sb.rpc('revenus_calcul_incomplet', { p_user_id: UUID_NUL, p_refs: null })
    dire('migration 6', 'revenus_calcul_incomplet repond', !error,
      error ? (fonctionIntrouvable(error) ? 'fonction introuvable avec CETTE signature' : error.message) : '')
  }

  // ─── Migration 7 : l'empreinte du payload ────────────────────────────────
  await colonnesLisibles('migration 7', ['derive_raw_hash', 'raw_hash'])

  // ─── LES DROITS, eprouves par la cle PUBLIQUE ────────────────────────────
  //
  // ⚠ POSTGRES DONNE `EXECUTE` A **PUBLIC** PAR DEFAUT, et `anon` en herite :
  // un `revoke from anon` seul est INOPERANT. C'est un constat de Thierry, et
  // c'est la raison de ce bloc — la seule facon de savoir si le `revoke from
  // public` a pris est de demander avec la cle que tout le monde a.
  if (pub) {
    for (const [fn, args] of [
      ['revenus_du_mois', { p_user_id: UUID_NUL, p_mois: '2026-10', p_aujourdhui: '2026-10-27', p_refs: null }],
      ['revenus_hors_mois', { p_user_id: UUID_NUL, p_mois: '2026-10', p_refs: null }],
      ['revenus_calcul_incomplet', { p_user_id: UUID_NUL, p_refs: null }]
    ]) {
      const { error } = await pub.rpc(fn, args)
      // ⚠ CE QU'UN ECHEC ICI VEUT DIRE, ET CE QU'IL NE VEUT PAS DIRE. Les trois
      // fonctions sont `security invoker`, donc la RLS s'applique a l'appelant :
      // mesure du 27 octobre 2026 contre un compte reel portant 795 €, la cle
      // publique rend `[]` la ou la cle de service rend deux biens et leurs
      // montants. Un echec ici n'est donc PAS une fuite de donnee — c'est la
      // garde de defense en profondeur du lot (« seul `service_role` execute »)
      // qui ne filtre rien. Le dire exactement evite deux erreurs symetriques :
      // paniquer, ou classer sans suite.
      dire('droits', `${fn} est REFUSEE a la cle publique`, !!error,
        error ? '' : 'ELLE REPOND — pas une fuite (RLS invoker, mesuree a 0 ligne), '
          + 'mais le `revoke` ne couvre pas `anon` : migration 8 a coller')
    }
  }

  // ─── CE QUE CE SCRIPT NE COUVRE PAS, ET IL LE DIT ────────────────────────
  //
  // ⚠ UN VERIFICATEUR QUI TAIT SES ANGLES MORTS EST PIRE QU'AUCUN : on le lance,
  // il est vert, et on croit avoir tout prouve.
  nonCouvert.push('les INDEX (3 au total : les deux de la migration 3, celui de la 7)'
    + ' — PostgREST n expose pas `pg_indexes`, donc ni leur existence ni leur'
    + ' definition ne sont atteignables par ce chemin. Les preuves SQL collees'
    + ' dans chaque migration les regardent, elles.')
  nonCouvert.push('le TRIGGER `delais_versement_invalide_trg` de la migration 3'
    + ' — l eprouver demanderait d ECRIRE dans `delais_versement`, ce que ce'
    + ' script ne fait pas, et surtout pas en production.')
  nonCouvert.push('le CONTENU des agregats — c est le travail de'
    + ' `scripts/verifier-parite-revenus.js`, qui compare le SQL au module'
    + ' ligne a ligne. Ici on prouve la FORME, pas la justesse.')

  console.log('')
  for (const n of nonCouvert) console.log('⚠ NON COUVERT : ' + n + '\n')

  // ─── Le verdict, et la garde du faux vert ────────────────────────────────
  //
  // ⚠ UN SCRIPT QUI N'A RIEN SONDE DOIT ECHOUER. Zero controle rend zero
  // echec, donc un vert — c est le faux vert le plus facile a fabriquer, et le
  // depot l a deja paye.
  const attendus = pub ? 9 : 6
  if (resultats.length < attendus) {
    console.error(`ECHEC : ${resultats.length} controle(s) effectue(s), ${attendus} attendu(s).`)
    console.error('Le script n a pas tout sonde : son vert ne vaudrait rien.')
    process.exit(1)
  }
  const echecs = resultats.filter(r => !r.ok)
  if (echecs.length) {
    console.error(`\nECHEC : ${echecs.length} controle(s) en echec sur ${resultats.length}.`)
    console.error('Les migrations du lot Revenus ne sont PAS toutes appliquees sur cette base.')
    process.exit(1)
  }
  console.log(`LES CINQ MIGRATIONS SONT APPLIQUEES sur ${base} (${projet}) :`)
  console.log(`${resultats.length} controle(s), 0 echec.`)
}

main().catch((e) => {
  console.error('ECHEC inattendu :', e && e.message)
  process.exit(1)
})
