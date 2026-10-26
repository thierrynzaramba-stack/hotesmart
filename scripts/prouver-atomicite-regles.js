#!/usr/bin/env node
// scripts/prouver-atomicite-regles.js — LA TRANSACTION TIENT-ELLE VRAIMENT ?
//
// ⚠ CE QU'AUCUN TEST UNITAIRE NE PEUT PROUVER. `tests/regles-atomiques.test.js`
// montre que le CODE ne fait plus qu'un seul aller-retour et n'ecrit rien a
// cote. Il ne peut pas montrer que Postgres ANNULE la desactivation quand
// l'insertion qui suit echoue : cela ne se demontre que contre une vraie base.
//
// LE SCENARIO, QUI EST CELUI DU CHANTIER :
//   1. on pose deux regles de test sur une liaison jetable ;
//   2. on rappelle la fonction avec un corps qui la fera lever APRES la
//      desactivation (un `p_regles` qui n'est pas un tableau : l'etape 4 leve,
//      l'etape 3 a deja tourne) ;
//   3. on relit. Si la transaction tient, les regles actives sont EXACTEMENT
//      celles d'avant. Sinon, il n'en reste aucune — c'est-a-dire
//      « disponible tous les jours », le defaut que ce lot ferme.
//   4. on nettoie : la liaison de test ne laisse rien.
//
// ⚠ JAMAIS EN PRODUCTION, ET LE SCRIPT LE REFUSE LUI-MEME. Il ecrit, meme si
// c'est sur des identifiants jetables : une garde qui depend de la prudence de
// qui lance la commande n'est pas une garde.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/prouver-atomicite-regles.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')
// ⚠ LA TABLE DES PROJETS NE SE RECOPIE PAS (constat MINEUR de la review du
// 26 octobre 2026). Ce script gardait par la BONNE regle — la reference du
// projet — mais avec sa propre copie des deux references. Une copie ne se
// corrige pas quand l'original change.
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const crypto = require('node:crypto')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}

// ⚠ LE PROJET DE PRODUCTION EST NOMME, ET REFUSE. Lire la liste des projets
// autorises serait plus souple ; nommer celui qu'on s'interdit est plus sur.
const PROJET = refDuProjet(URL) || ''
if (nomDeLaBase(URL) === 'PRODUCTION') {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. Ce script ecrit — staging seulement.`)
  process.exit(2)
}

const supabase = createClient(URL, KEY)

// ⚠ PAS D'UUID TIRES AU HASARD : `provider_availability_rules.provider_id`
// porte une cle etrangere vers `profiles`. On cree donc un profil JETABLE,
// rattache a un compte existant de staging, et on le supprime a la fin. La
// liaison de test n'est ainsi partagee avec aucune vraie prestataire : ses
// regles a elle ne sont jamais ni lues, ni desactivees.
const MARQUE = 'Preuve atomicite (jetable)'
let USER = null
let PRESTA = null

async function creerLaLiaisonJetable () {
  const { data: hote, error: eH } = await supabase.from('profiles')
    .select('account_user_id').not('account_user_id', 'is', null).limit(1).maybeSingle()
  if (eH || !hote) throw new Error('aucun compte sur cette base : ' + (eH ? eH.message : 'vide'))
  USER = hote.account_user_id
  const { data: p, error: eP } = await supabase.from('profiles')
    .insert({ account_user_id: USER, first_name: MARQUE,
              access_mode: 'lien', active: false })
    .select('id').maybeSingle()
  if (eP || !p) throw new Error('profil jetable impossible : ' + (eP ? eP.message : '?'))
  PRESTA = p.id
}

const regle = (jour) => ({
  rrule: `DTSTART:20261012T120000Z\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=${jour}`,
  label: `Preuve d'atomicite ${jour}`
})

async function actives () {
  const { data, error } = await supabase.from('provider_availability_rules')
    .select('id, rrule').eq('user_id', USER).eq('provider_id', PRESTA).eq('active', true)
  if (error) throw new Error('lecture impossible : ' + error.message)
  return (data || []).map(r => r.id).sort()
}

async function nettoyer () {
  if (!PRESTA) return
  const { error } = await supabase.from('provider_availability_rules')
    .delete().eq('user_id', USER).eq('provider_id', PRESTA)
  if (error) console.error('⚠ regles non nettoyees :', error.message)
  const { error: eP } = await supabase.from('profiles').delete().eq('id', PRESTA)
  if (eP) console.error('⚠ profil jetable non supprime :', eP.message, '— id', PRESTA)
}

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (production refusee)`)
  let ko = 0
  try {
    await creerLaLiaisonJetable()
    console.log('✓ liaison jetable creee')

    // 1. Deux regles de depart.
    const { error: e1 } = await supabase.rpc('remplacer_regles_dispo', {
      p_user_id: USER, p_provider_id: PRESTA, p_source: 'hote',
      p_regles: [regle('MO'), regle('WE')], p_max_actives: 50
    })
    if (e1) throw new Error('pose initiale impossible : ' + e1.message)
    const avant = await actives()
    if (avant.length !== 2) throw new Error(`2 regles attendues, ${avant.length} trouvee(s)`)
    console.log(`✓ etat de depart : ${avant.length} regles actives`)

    // 2. Un corps qui fait lever la fonction APRES la desactivation.
    // `jsonb_array_length` d'un scalaire leve (22023) ; a ce moment-la,
    // l'`update active = false` de l'etape 3 a DEJA tourne.
    const { error: e2 } = await supabase.rpc('remplacer_regles_dispo', {
      p_user_id: USER, p_provider_id: PRESTA, p_source: 'hote',
      p_regles: 'pas-un-tableau', p_max_actives: 50
    })
    if (!e2) { console.error('✗ la fonction a ACCEPTE un corps invalide'); ko++ }
    else console.log(`✓ la fonction a leve : ${String(e2.message).slice(0, 60)}`)

    // 3. La preuve.
    const apres = await actives()
    if (apres.join(',') === avant.join(',')) {
      console.log('✓ ATOMIQUE : les regles actives sont EXACTEMENT celles d\'avant')
    } else if (apres.length === 0) {
      console.error('✗ NON ATOMIQUE : plus aucune regle active — « disponible tous les jours »')
      ko++
    } else {
      console.error(`✗ NON ATOMIQUE : ${avant.length} regles avant, ${apres.length} apres`)
      ko++
    }
  } catch (e) {
    console.error('✗', e.message)
    ko++
  } finally {
    await nettoyer()
    const reste = PRESTA ? await actives().catch(() => []) : []
    const { data: profilReste } = PRESTA
      ? await supabase.from('profiles').select('id').eq('id', PRESTA).maybeSingle()
      : { data: null }
    console.log(reste.length === 0 && !profilReste
      ? '✓ rien ne reste sur la base'
      : `⚠ ${reste.length} regle(s) et ${profilReste ? 1 : 0} profil restant(s)`)
  }
  process.exit(ko === 0 ? 0 : 1)
})().catch((e) => { console.error('Erreur :', e.message); process.exit(2) })
