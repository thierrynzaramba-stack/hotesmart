#!/usr/bin/env node
// scripts/armer-avis-sans-prestataire.js — poser l'horloge de la publication
// automatique sur les evaluations qui ATTENDAIENT deja quand la regle « sans
// prestataire » est arrivee (decision de Thierry du 9 novembre 2026).
//
// Usage : node --env-file=.env.local scripts/armer-avis-sans-prestataire.js --nees-avant <instant ISO>        (a blanc)
//         node --env-file=.env.local scripts/armer-avis-sans-prestataire.js --nees-avant <instant ISO> --go   (ecrit)
//         ... --compte <user_id>   pour un seul compte
//
// Pourquoi. A partir de ce lot, une evaluation qui NAIT arme son horloge
// elle-meme (lib/avis/naissance.js). Celles nees avant n'ont rien qui les
// arme : mesure du 9 novembre 2026 en production, 13 evaluations de La bulle
// et de Coeur de vie 23 attendaient, sans prestataire autorisee, et Thierry a
// decide qu'elles recoivent elles aussi leur delai a la mise en production
// (« Les 13 aussi, avec 24 h »). Le delai part de l'execution du script.
//
// ⚠ A BLANC PAR DEFAUT. Une ecriture de masse s'annonce AVANT d'ecrire : la
// sortie a blanc liste chaque evaluation, sa decision et l'heure prevue.
// ⚠ `--nees-avant` EST OBLIGATOIRE : l'instant du deploiement du lot. Le script
// ne rattrape que ce qui est ne AVANT ; ce qui nait apres s'arme seul.
// ⚠ LE DELAI PLEIN OU RIEN (revue de 6e73da3, constat 1). Le plafond d'Airbnb
// (echeance − 12 h) raccourcirait le delai des plus anciennes — jusqu'a
// publier trois minutes apres le script, sans rappel. Celles-la ne sont PAS
// armees : elles sont listees a part, « a publier a la main avant … » — et
// seulement elles : ce qui est deja arme une fois, ou attend une prestataire
// autorisee, n'y figure jamais (re-revue de 22f2013).
// ⚠ JAMAIS DEUX FOIS : `armerSansPrestataire` lit la marque `avis.auto_armee`
// du journal ; une evaluation deja armee une fois, puis arretee par l'hote,
// n'est pas rearmee si le script est relance.
// ⚠ LA MEME DECISION QUE LA NAISSANCE (`armerSansPrestataire`), jamais une
// copie : reglage du bien, prestataire du menage, ecriture conditionnee.
// ⚠ PAGINE PAR CURSEUR : PostgREST rend 1000 lignes sans erreur.
// ⚠ EMPREINTE EN TETE : la reference du projet Supabase (lib/empreinte-base.js).

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { armerSansPrestataire } = require('../lib/avis/auto-validation')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const valeur = (nom) => {
  const i = args.indexOf(nom)
  if (i < 0) return null
  const v = args[i + 1]
  if (!v || v.startsWith('--')) { console.error(`${nom} attend une valeur.`); process.exit(1) }
  return v
}
const ECRIRE = args.includes('--go')
const COMPTE = valeur('--compte')
const NEES_AVANT = valeur('--nees-avant')
if (!NEES_AVANT || !Number.isFinite(Date.parse(NEES_AVANT))) {
  console.error('--nees-avant <instant ISO> est obligatoire : l’instant du déploiement du lot.')
  process.exit(1)
}
const PAGE = 500
const COLONNES = 'id, user_id, property_id, property_id_ref, booking_uid, status, deadline_at, auto_publier_le, answers_host, answers_cleaner'
const heureParis = (v) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date(v))

;(async () => {
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${refDuProjet(URL)} — ${nom}`)
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arret.'); process.exit(1) }
  console.log(ECRIRE ? 'MODE : ECRITURE (--go)' : 'MODE : A BLANC (rien n’est ecrit ; --go pour ecrire)')
  console.log(`Evaluations nees avant : ${new Date(NEES_AVANT).toISOString()}${COMPTE ? ` — compte ${COMPTE}` : ''}\n`)

  const maintenant = Date.now()
  const bilan = { lues: 0, armees: 0, plafonnees: 0, ignorees: 0, erreurs: 0 }
  const motifs = {}
  const aLaMain = []
  let curseur = null
  for (;;) {
    let q = sb.from('guest_evaluations').select(COLONNES)
      .eq('status', 'a_remplir').is('auto_publier_le', null)
      .gt('deadline_at', new Date(maintenant).toISOString())
      .lt('created_at', new Date(NEES_AVANT).toISOString())
      .order('id', { ascending: true }).limit(PAGE)
    if (COMPTE) q = q.eq('user_id', COMPTE)
    if (curseur) q = q.gt('id', curseur)
    const { data, error } = await q
    if (error) { console.error('Evaluations illisibles :', error.message); process.exit(1) }
    if (!data || !data.length) break

    // Les noms des biens de CETTE page seulement : jamais toute la table.
    const ids = [...new Set(data.map(e => e.property_id))]
    const { data: biens, error: eB } = await sb.from('properties').select('id, name').in('id', ids)
    if (eB) console.error('Noms des biens illisibles :', eB.message)
    const nomDe = new Map((biens || []).map(b => [b.id, b.name]))

    for (const e of data) {
      bilan.lues++
      const r = await armerSansPrestataire(sb, e, { maintenant, aBlanc: !ECRIRE, exigerDelaiPlein: true, par: 'script' })
      const ligne = `${String(nomDe.get(e.property_id) || e.property_id).padEnd(24)} ${String(e.booking_uid).padEnd(40)} échéance ${heureParis(e.deadline_at)}`
      if (r.erreur) { bilan.erreurs++; console.error(`  ERREUR  ${ligne} — ${r.erreur}`) }
      else if (r.arme) { bilan.armees++; console.log(`  ${ECRIRE ? 'armée  ' : 'à armer'} ${ligne} → publication le ${heureParis(r.quand)}`) }
      else if (r.aLaMain) { bilan.plafonnees++; aLaMain.push(`${ligne} — ${r.motif}`) }
      else { bilan.ignorees++; motifs[r.motif] = (motifs[r.motif] || 0) + 1 }
    }
    curseur = data[data.length - 1].id
    if (data.length < PAGE) break
  }

  if (aLaMain.length) {
    console.log('\nDélai plein impossible avant la fermeture d’Airbnb — NON armées, à publier à la main :')
    for (const l of aLaMain) console.log(`  ${l}`)
  }
  console.log(`\n${bilan.lues} lue(s), ${bilan.armees} ${ECRIRE ? 'armée(s)' : 'à armer'}, ${bilan.plafonnees} à publier à la main, ${bilan.ignorees} laissée(s), ${bilan.erreurs} erreur(s)`)
  for (const [m, n] of Object.entries(motifs)) console.log(`  laissées — ${m} : ${n}`)
  process.exit(bilan.erreurs ? 1 : 0)
})()
