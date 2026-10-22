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
const PROJET = (process.env.SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Les VRAIES fonctions du cron, pas une copie.
const {
  chargerLesGardesDesFils, hasNewerTaskOrConv,
  MOTIF_PAUSE, FENETRE_TACHES_PAUSE
} = require('../lib/cron-classify')

const JOURS_DE_FIL = 30
const MESSAGES_MAX = 500
const REPONSES_HOTE = ['host', 'ai']

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (lecture seule)\n`)

  const { data: biens, error } = await sb.from('properties')
    .select('id, user_id, name, provider_property_id')
    .in('provider', ['channex', 'channel']).not('provider_property_id', 'is', null)
  if (error) { console.error('ECHEC lecture properties :', error.message); process.exit(1) }

  let filsVus = 0, divergences = 0, replis = 0
  const depuis = new Date(Date.now() - JOURS_DE_FIL * 864e5).toISOString()

  for (const b of biens) {
    const cle = String(b.provider_property_id)
    // Le MEME fil que celui que voit le cron : getPropertyMessages.
    const { data: msgs } = await sb.from('messages')
      .select('booking_id, direction, sender, sent_at')
      .eq('user_id', b.user_id).eq('property_id', cle).gte('sent_at', depuis)
      .order('sent_at', { ascending: false }).limit(MESSAGES_MAX)

    const fils = {}
    ;(msgs || []).forEach(m => {
      const bid = m.booking_id || 'unknown'
      if (!fils[bid]) fils[bid] = []
      fils[bid].push({
        source: m.direction === 'inbound' ? 'guest'
          : (m.sender === 'auto' || m.sender === 'ai' ? m.sender : 'host'),
        time: m.sent_at
      })
    })
    const ids = Object.keys(fils).filter(x => x && x !== 'unknown')

    const resultats = { errors: [] }
    const gardes = await chargerLesGardesDesFils(b.user_id, cle, ids, resultats)
    if (!gardes) {
      replis++
      console.error(`REPLI  ${b.name} (${cle}) : la lecture groupee n a pas abouti — rien a comparer`)
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

      // La garde de la pause : on compare la LISTE des taches a fermer, pas
      // un booleen — c'est elle qui decide d un UPDATE.
      const reponses = th.filter(m => REPONSES_HOTE.includes(m.source) && Number.isFinite(Date.parse(m.time)))
      if (reponses.length) {
        const derniere = Math.max(...reponses.map(m => Date.parse(m.time)))
        const aFermerGroupe = (gardes.pause.get(String(bid)) || [])
          .filter(t => Date.parse(t.created_at) < derniere).map(t => String(t.id)).sort()
        const { data: lu } = await sb.from('agent_tasks').select('id, created_at')
          .eq('user_id', b.user_id).eq('property_id', cle).eq('book_id', String(bid))
          .eq('status', 'pending').eq('summary', MOTIF_PAUSE).limit(FENETRE_TACHES_PAUSE)
        const aFermerParFil = (lu || [])
          .filter(t => Date.parse(t.created_at) < derniere).map(t => String(t.id)).sort()
        if (JSON.stringify(aFermerGroupe) !== JSON.stringify(aFermerParFil)) {
          divergences++
          ecartsDuBien.push(`    reservation ${bid} : taches de pause a fermer groupe=${JSON.stringify(aFermerGroupe)} parFil=${JSON.stringify(aFermerParFil)}`)
        }
      }
    }
    console.log(`${b.name.padEnd(18)} ${String(filsDuBien).padStart(3)} fil(s) compare(s)  ${ecartsDuBien.length ? `${ecartsDuBien.length} ECART(S)` : 'zero ecart'}`)
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
