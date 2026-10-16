#!/usr/bin/env node
// scripts/diagnostic-parite-semaines.js — COMBIEN DE RÈGLES A/B L'ÉCRAN
// MONTRAIT-IL SUR LA MAUVAISE LIGNE ? (16 octobre 2026)
//
// ⚠ LE DÉFAUT. `pages/menages.html` décidait si une règle de quinzaine tombe
// sur « cette semaine » (ligne A) ou sur la suivante (ligne B) en comptant les
// semaines depuis l'epoch : `Date.parse(iso) / 604800000`. Ce découpage
// commence le 1er janvier 1970, un JEUDI. Deux dates de la même semaine civile
// tombent donc dans deux tranches différentes dès que l'une est un lundi, un
// mardi ou un mercredi — et A et B s'échangent.
//
// ⚠ CE QUE CE SCRIPT NE CHERCHE PAS, PARCE QUE LE CODE RÉPOND DÉJÀ.
// L'ATTRIBUTION des ménages n'a jamais utilisé ce calcul :
// `lib/cleaning/availability.js` passe par `rrulestr(...).between(...)`, la
// bibliothèque RRULE, qui part du `DTSTART` et de l'`INTERVAL` de la chaîne.
// Aucune semaine n'y est comptée depuis l'epoch. Le défaut était donc
// d'AFFICHAGE — mais un affichage faux fait prendre de mauvaises décisions à
// qui le lit, et c'est ce qu'on chiffre ici.
//
// ⚠ ET IL NE CORRIGE RIEN. Lecture seule, aucune écriture, aucun `update`.
//
//   ENV_FILE=…/.env.local node scripts/diagnostic-parite-semaines.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const { lireRrule } = require('../lib/cleaning/availability')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const supabase = createClient(URL, KEY)
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || '(inconnu)'

const jourUTC = (iso) => new Date(String(iso).slice(0, 10) + 'T12:00:00Z')
const lundiDe = (iso) => {
  const d = jourUTC(iso)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}
// L'ANCIEN calcul, celui qui mentait.
const ancienVerdict = (ancre, auj) =>
  (Math.floor(Date.parse(ancre + 'T12:00:00Z') / 604800000) -
   Math.floor(Date.parse(auj + 'T12:00:00Z') / 604800000)) % 2 === 0
// Le NOUVEAU, qui ramène chaque date à son lundi.
const nouveauVerdict = (ancre, auj) =>
  (Math.round(jourUTC(lundiDe(ancre)).getTime() / 604800000) -
   Math.round(jourUTC(lundiDe(auj)).getTime() / 604800000)) % 2 === 0

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

;(async () => {
  const auj = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
  console.log(`Projet Supabase : ${PROJET} — lecture seule, aucune écriture`)
  console.log(`Aujourd'hui (Paris) : ${auj}\n`)

  const { data, error } = await supabase.from('provider_availability_rules')
    .select('id, user_id, provider_id, rrule, label, active, source, created_at')
    .eq('active', true)
  if (error) { console.error('Lecture impossible :', error.message); process.exit(2) }

  const actives = data || []
  const lues = actives.map(r => ({ ...r, forme: lireRrule(r.rrule) }))
  const illisibles = lues.filter(r => !r.forme)
  const quinzaine = lues.filter(r => r.forme && Number(r.forme.cadence) >= 2)

  console.log(`Règles actives            : ${actives.length}`)
  console.log(`  dont illisibles         : ${illisibles.length}`)
  console.log(`  dont cadence >= 2 (A/B) : ${quinzaine.length}`)

  if (!quinzaine.length) {
    console.log('\nAucune règle de quinzaine : l\'écran ne pouvait afficher ' +
                'aucune ligne A/B, donc aucune n\'a pu être montrée du mauvais côté.')
    return
  }

  // Combien d'entre elles l'écran montrait-il sur la mauvaise ligne, AUJOURD'HUI ?
  const fausses = []
  for (const r of quinzaine) {
    const ancre = r.forme.ancre ? String(r.forme.ancre).slice(0, 10) : null
    if (!ancre) continue
    if (ancienVerdict(ancre, auj) !== nouveauVerdict(ancre, auj)) fausses.push({ r, ancre })
  }

  console.log(`\nAffichées sur la MAUVAISE ligne aujourd'hui : ${fausses.length} / ${quinzaine.length}`)
  for (const { r, ancre } of fausses) {
    const j = JOURS[jourUTC(ancre).getUTCDay()]
    console.log(`  · ${r.id} — ancre ${ancre} (${j}), lundi ${lundiDe(ancre)}` +
                ` — « ${r.label || '(sans libellé)'} » — posée par ${r.source || '?'}`)
  }

  // ⚠ ET CE QUE LE MOTEUR, LUI, A FAIT. On rejoue sa décision sur les sept
  // prochains jours pour CHAQUE règle de quinzaine : si elle venait du
  // découpage epoch, les deux verdicts différeraient. Ils ne peuvent pas :
  // `regleCouvre` n'a jamais compté de semaines.
  const { regleCouvre } = require('../lib/cleaning/availability')
  let verifies = 0
  for (const r of quinzaine) {
    for (let k = 0; k < 7; k++) {
      const d = new Date(jourUTC(auj).getTime() + k * 86400000).toISOString().slice(0, 10)
      if (regleCouvre(r.rrule, d) !== null) verifies++
    }
  }
  console.log(`\nDécisions du moteur rejouées (7 jours × ${quinzaine.length} règles) : ${verifies}`)
  console.log('Le moteur lit la RRULE par `rrulestr().between()` : son verdict ne')
  console.log('dépend d\'aucun découpage de semaines, donc aucune attribution n\'a')
  console.log('pu suivre la mauvaise semaine. Le défaut était d\'AFFICHAGE.')

  console.log('\n⚠ Aucune donnée n\'a été modifiée.')
})().catch((e) => { console.error('Erreur :', e.message); process.exit(2) })
