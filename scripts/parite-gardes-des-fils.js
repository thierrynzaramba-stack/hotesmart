#!/usr/bin/env node
// scripts/parite-gardes-des-fils.js
// LA PARITE DES DEUX BRANCHES, SUR LES FILS REELS. Lecture seule.
//
// Les gardes de la classification existent en deux versions depuis le lot B :
// la lecture GROUPEE (trois fonctions SQL par bien) et la lecture PAR FIL
// (le code d'avant, conserve comme repli). Elles doivent rendre le MEME
// verdict. Zero divergence est la condition posee par Thierry avant staging.
//
// ⚠ C'EST CE SCRIPT QUI EPROUVE LE SQL, ET LUI SEUL. Les tests de
// tests/gardes-des-fils-groupees.test.js prouvent que les deux BRANCHES JS
// s'accordent ; ils ne peuvent rien dire de trois fonctions Postgres. La
// fenetre des 20 conversations, le filtre `[AUTO:`, le `distinct on` : leur
// semantique ne se verifie qu'ici, contre les lignes de la base.
//
// ⚠ ET IL N'ECRIT RIEN. Il ne touche ni `agent_tasks`, ni `conversations`, ni
// un message : il POSE les deux questions et compare les reponses. Il peut
// donc tourner contre la PRODUCTION, et c'est la que vivent les fils qui
// comptent.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/parite-gardes-des-fils.js
//
// Sortie 0 : zero divergence. Sortie 1 : au moins une — on ne va pas plus loin.

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
// ⚠ CE SCRIPT APPELLE LES VRAIES FONCTIONS DU CRON, DONC IL CHARGE
// `lib/cron-shared.js`, QUI CONSTRUIT LE CLIENT ANTHROPIC. Il n'emet aucun
// appel au modele — mais sans la variable, le `require` plus bas leverait une
// trace de pile brute au lieu d'un message. Constat 15 de la review. (Le
// verificateur de migration, lui, n'a plus cette dependance du tout.)
if (!process.env.CLAUDE_API_KEY) {
  console.error('CLAUDE_API_KEY doit etre PRESENTE (aucun appel n est emis) :')
  console.error('ce script traverse lib/cron-shared.js, qui construit le client.')
  process.exit(2)
}
const PROJET = (process.env.SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Les VRAIES fonctions du cron, pas une copie.
const {
  chargerLesGardesDesFils, hasNewerTaskOrConv, fermerTachesPause, REPONSES_HOTE
} = require('../lib/cron-classify')
// ⚠ LE FIL VIENT DE `getPropertyMessages`, PAS D'UNE COPIE DE SA REQUETE.
// Constat 6 : ma premiere version recopiait la fenetre de 30 jours, le plafond
// de 500 messages, et la table de correspondance `direction`/`sender` ->
// `source`. Le jour ou l'une des trois change — le mapping de `sender` a deja
// change le 2 octobre 2026 pour distinguer 'auto' —, le script comparerait des
// FILS QUE LE CRON NE VOIT PAS, et imprimerait quand meme « zero divergence ».
// La preuve qui conditionne la recette serait fausse sans rougir.
const { getProvider } = require('../lib/channels')

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (lecture seule)\n`)

  const { data: biens, error } = await sb.from('properties')
    .select('id, user_id, name, provider_property_id')
    .in('provider', ['channex', 'channel']).not('provider_property_id', 'is', null)
  if (error) { console.error('ECHEC lecture properties :', error.message); process.exit(1) }

  let filsVus = 0, divergences = 0, replis = 0
  const provider = getProvider('channex')

  for (const b of biens) {
    const cle = String(b.provider_property_id)
    // Le MEME fil que celui que voit le cron, par la MEME fonction.
    const msgs = await provider.getPropertyMessages({ userId: b.user_id, providerPropertyId: cle })

    const fils = {}
    ;(msgs || []).forEach(m => {
      const bid = m.bookingId || 'unknown'
      if (!fils[bid]) fils[bid] = []
      fils[bid].push({ source: m.sender, time: m.time })
    })
    // ⚠ 'unknown' EST COMPARE LUI AUSSI. Constat 1 : c'est precisement le fil
    // que la lecture groupee oubliait, et un script de parite qui l'ecarte ne
    // peut pas voir ce defaut-la.
    const ids = Object.keys(fils)

    const resultats = { errors: [] }
    const gardes = await chargerLesGardesDesFils(b.user_id, cle, ids, resultats)
    if (!gardes) {
      replis++
      console.error(`REPLI  ${String(b.name || cle)} (${cle}) : la lecture groupee n a pas abouti — rien a comparer`)
      continue
    }

    let filsDuBien = 0, ecartsDuBien = []
    for (const bid of ids) {
      const th = fils[bid]
      const tempsVoyageur = th.filter(m => m.source === 'guest' && m.time).map(m => m.time).sort()
      if (!tempsVoyageur.length) continue
      const guestAt = new Date(tempsVoyageur[tempsVoyageur.length - 1])
      filsDuBien++
      filsVus++

      const groupe = await hasNewerTaskOrConv(b.user_id, cle, bid, guestAt, gardes)
      const parFil = await hasNewerTaskOrConv(b.user_id, cle, bid, guestAt, null)
      if (groupe !== parFil) {
        divergences++
        ecartsDuBien.push(`    reservation ${bid} : groupe=${groupe} parFil=${parFil} (dernier message voyageur ${guestAt.toISOString()})`)
      }

      // La garde de la pause : on compare la LISTE des taches a fermer, pas un
      // booleen — c'est elle qui decide d'un UPDATE.
      //
      // ⚠ ET ON LA DEMANDE AUX DEUX BRANCHES DE `fermerTachesPause`, SANS
      // RECOPIER SA LECTURE. Ma version d'avant refaisait la requete a la main
      // — et avait justement oublie le `order by` que le constat 7 venait
      // d'ajouter au module. Elle comparait donc les 20 PLUS ANCIENNES du SQL a
      // 20 lignes ARBITRAIRES de PostgREST : au-dela de 20 taches de pause sur
      // un fil, elle aurait refuse la recette sur le faux defaut qu'elle etait
      // censee avoir supprime. C'est la lecon du constat 6, une seconde fois.
      const reponses = th.filter(m => REPONSES_HOTE.includes(m.source) && Number.isFinite(Date.parse(m.time)))
      if (reponses.length) {
        const ferme = async (g) => {
          const vus = []
          await fermerTachesPause(b.user_id, cle, bid, th, { errors: [] }, g, { surFermeture: (ids) => vus.push(...ids) })
          return vus.map(String).sort()
        }
        const aFermerGroupe = await ferme(gardes)
        const aFermerParFil = await ferme(null)
        if (JSON.stringify(aFermerGroupe) !== JSON.stringify(aFermerParFil)) {
          divergences++
          ecartsDuBien.push(`    reservation ${bid} : taches de pause a fermer groupe=${JSON.stringify(aFermerGroupe)} parFil=${JSON.stringify(aFermerParFil)}`)
        }
      }
    }
    // `properties.name` n'est pas NOT NULL : un bien de test sans nom faisait
    // tomber toute la campagne sur un TypeError (constat 14).
    const etiquette = String(b.name || b.provider_property_id || '(sans nom)')
    console.log(`${etiquette.padEnd(18)} ${String(filsDuBien).padStart(3)} fil(s) compare(s)  ${ecartsDuBien.length ? `${ecartsDuBien.length} ECART(S)` : 'zero ecart'}`)
    ecartsDuBien.forEach(l => console.log(l))
  }

  console.log(`\n${filsVus} fil(s) compare(s) au total, ${divergences} divergence(s), ${replis} repli(s).`)
  if (replis) {
    console.error('VERDICT : la lecture groupee n a pas abouti sur au moins un bien.')
    console.error('          Lancez d abord scripts/verifier-migration-gardes-des-fils.js.')
    process.exit(1)
  }
  if (!filsVus) {
    console.error('VERDICT : AUCUN fil compare. Un script qui n a rien lu ne prouve rien.')
    process.exit(1)
  }
  if (divergences) {
    console.error(`VERDICT : ${divergences} divergence(s). On ne passe pas en recette.`)
    process.exit(1)
  }
  console.log('VERDICT : zero divergence sur les fils reels.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
