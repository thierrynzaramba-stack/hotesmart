#!/usr/bin/env node
// scripts/verifier-migration-cron-stats.js
// La migration migrations/2026-10-22-cron-stats.sql est-elle appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la table existe-t-elle ? ». `create table
// if not exists` reussit EN SILENCE sur une table a la forme differente, et une
// table peut exister sans sa RLS ni ses deux fonctions d'agregation : la page
// de diagnostic rendrait alors « migration non appliquee » sans qu'on sache
// lequel des trois morceaux manque.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. la table se lit, et ses 10 colonnes sont la ;
//   2. les DEUX fonctions d'agregation repondent a la cle service ;
//   3. la RLS mord : la cle PUBLIQUE ne lit aucune ligne et n'ecrit pas ;
//   4. les fonctions sont FERMEES a la cle publique (revoke execute) — la RLS
//      suffirait a ne rien rendre, mais une garde qui tient par une seule
//      raison n'est pas une garde ;
//   5. avec --ecrit : une ligne temoin s'insere, se relit, est AGREGEE par la
//      fonction, puis est supprimee. Ce point ECRIT : il refuse la production.
//
// Lecture seule par defaut : il peut donc tourner contre la PRODUCTION, et
// c'est la que ca compte (une migration « appliquee » sur staging seulement
// est le defaut le plus cher du depot).
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-cron-stats.js --ecrit
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/verifier-migration-cron-stats.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const PROD = 'cjmrizpdyhrcurmgyrhs'
const ECRIT = process.argv.includes('--ecrit')
if (ECRIT && PROJET === PROD) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. --ecrit est reserve a staging.`)
  process.exit(2)
}
const sb = createClient(URL, KEY)

const COLONNES = ['id', 'cron', 'commence_le', 'termine_le', 'duree_ms',
  'requetes', 'appels_externes', 'taches', 'totaux', 'cree_le']
const TEMOIN = 'VERIF-MIGRATION'
const absente = (m) => /(does not exist|schema cache|not find)/i.test(String(m || ''))

;(async () => {
  console.log(`Projet Supabase : ${PROJET}${PROJET === PROD ? ' (PRODUCTION, lecture seule)' : ''}`)
  let ko = 0

  // 1. La table et ses colonnes.
  {
    const { error } = await sb.from('cron_stats').select(COLONNES.join(', ')).limit(1)
    if (error) {
      console.error('✗ table absente ou colonnes manquantes :', error.message)
      ko++
    } else console.log(`✓ la table existe, et ses ${COLONNES.length} colonnes repondent`)
  }

  // 2. Les deux fonctions d'agregation.
  const depuis = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  for (const [nom, args] of [
    ['cron_stats_classement', { depuis, quel_cron: null }],
    ['cron_stats_par_jour', { depuis }],
  ]) {
    const { data, error } = await sb.rpc(nom, args)
    if (error) {
      console.error(`✗ ${nom} ne repond pas :`, error.message)
      ko++
    } else console.log(`✓ ${nom} repond (${(data || []).length} ligne(s) sur 24 h)`)
  }

  // 3 et 4. La porte, pour la cle publique.
  if (ANON) {
    const pub = createClient(URL, ANON)
    {
      const { data, error } = await pub.from('cron_stats').select('id').limit(1)
      // ⚠ UNE TABLE ABSENTE N'EST PAS UNE RLS QUI MORD. Sans ce cas, le script
      // annoncerait « la cle publique ne lit rien » sur une base ou la
      // migration n'est pas passee — un message faux, sur un point de
      // securite. Un verificateur qui crie a tort finit ignore.
      if (error && absente(error.message)) {
        console.error('✗ RLS non eprouvee : la table est absente')
        ko++
      } else if (error) {
        console.log('✓ la cle publique ne lit rien (refus :', error.message.slice(0, 60), ')')
      } else if ((data || []).length === 0) {
        console.log('✓ la cle publique ne lit aucune ligne')
      } else {
        console.error(`✗ LA CLE PUBLIQUE LIT ${data.length} LIGNE(S) : la RLS ne mord pas`)
        ko++
      }
    }
    {
      const { error } = await pub.from('cron_stats').insert({
        cron: TEMOIN, commence_le: new Date().toISOString(), duree_ms: 0,
      })
      // ⚠ MEME PIEGE QUE CI-DESSUS, ET IL M'A EU : sur une base ou la
      // migration n'est pas passee, l'insertion echoue parce que la TABLE
      // n'existe pas, et le script annoncait « la cle publique n ecrit pas ».
      // Un faux vert sur un point de securite est pire que pas de test.
      if (error && absente(error.message)) {
        console.error('✗ ecriture publique non eprouvee : la table est absente'); ko++
      } else if (error) console.log('✓ la cle publique n ecrit pas')
      else { console.error('✗ LA CLE PUBLIQUE A ECRIT une ligne : la RLS ne mord pas'); ko++ }
    }
    {
      const { data, error } = await pub.rpc('cron_stats_classement', { depuis, quel_cron: null })
      if (error && absente(error.message)) {
        console.error('✗ porte des fonctions non eprouvee : elles sont absentes'); ko++
      } else if (error) console.log('✓ les fonctions sont fermees a la cle publique')
      else if ((data || []).length === 0) {
        console.log('· les fonctions repondent a la cle publique mais ne rendent RIEN (la RLS'
          + ' mord) — le `revoke execute` n a pas ete applique, defense en profondeur incomplete')
      } else {
        console.error(`✗ LA CLE PUBLIQUE AGREGE ${data.length} LIGNE(S) par la fonction`)
        ko++
      }
    }
  } else {
    console.log('· SUPABASE_ANON_KEY absente : la porte publique n est pas eprouvee')
  }

  // 5. L'aller-retour complet, staging seulement.
  if (ECRIT) {
    const commence = new Date().toISOString()
    const detail = [{ nom: 'tache_temoin', n: 1, ms: 1234, ms_seul: 1234, req: 7,
                      ext: { channex: 2 }, ext_total: 2, travail: { totalTemoins: 3 }, travail_total: 3 }]
    const { error: errIns } = await sb.from('cron_stats').insert({
      cron: TEMOIN, commence_le: commence, duree_ms: 1234, requetes: 7,
      appels_externes: 2, taches: detail, totaux: { taches: 1 },
    })
    if (errIns) { console.error('✗ insertion temoin refusee :', errIns.message); ko++ }
    else {
      const { data } = await sb.rpc('cron_stats_classement',
        { depuis: new Date(Date.now() - 600000).toISOString(), quel_cron: TEMOIN })
      const vu = (data || []).find(l => l.tache === 'tache_temoin')
      if (!vu) { console.error('✗ la fonction n agrege PAS le detail JSON des taches'); ko++ }
      else if (Number(vu.requetes) !== 7 || Number(vu.ms) !== 1234
               || Number(vu.externes) !== 2 || Number(vu.travail) !== 3) {
        console.error('✗ la fonction agrege de travers :', JSON.stringify(vu)); ko++
      } else console.log('✓ le detail JSON est agrege juste (req, ms, externes, travail)')
      const { error: errDel } = await sb.from('cron_stats').delete().eq('cron', TEMOIN)
      if (errDel) { console.error('✗ menage du temoin impossible :', errDel.message); ko++ }
      else console.log('✓ temoin supprime')
    }
  } else {
    console.log('· sans --ecrit : l aller-retour d ecriture n est pas eprouve (lecture seule)')
  }

  console.log(ko === 0 ? '\nMIGRATION APPLIQUEE.' : `\n${ko} POINT(S) EN ECHEC.`)
  process.exit(ko === 0 ? 0 : 1)
})().catch(e => { console.error('verificateur en echec :', e.message); process.exit(3) })
