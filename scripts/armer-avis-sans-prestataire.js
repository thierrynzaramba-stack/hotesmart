#!/usr/bin/env node
// scripts/armer-avis-sans-prestataire.js — poser l'horloge de la publication
// automatique sur les evaluations qui ATTENDAIENT deja quand la regle « sans
// prestataire » est arrivee (decision de Thierry du 9 novembre 2026).
//
// Usage : node --env-file=.env.local scripts/armer-avis-sans-prestataire.js            (a blanc)
//         node --env-file=.env.local scripts/armer-avis-sans-prestataire.js --go       (ecrit)
//         ... --compte <user_id>   pour un seul compte
//
// Pourquoi. A partir de ce lot, une evaluation qui NAIT arme son horloge
// elle-meme (lib/avis/naissance.js). Celles nees avant n'ont rien qui les
// rearme : mesure du 9 novembre 2026 en production, 13 evaluations de La bulle
// et de Coeur de vie 23 attendaient, sans prestataire autorisee, et Thierry a
// decide qu'elles recoivent elles aussi leur delai a la mise en production
// (« Les 13 aussi, avec 24 h »). Le delai part de l'execution du script, pas de
// la naissance : un avis publie ne se retire pas, l'hote garde ses 24 heures.
//
// ⚠ A BLANC PAR DEFAUT. Une ecriture de masse s'annonce AVANT d'ecrire : la
// sortie a blanc liste chaque evaluation, sa decision et l'heure prevue.
// ⚠ LA MEME DECISION QUE LA NAISSANCE (`armerSansPrestataire`), jamais une
// copie : reglage du bien, prestataire du menage, plafond avant l'echeance,
// ecriture conditionnee.
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
const ECRIRE = args.includes('--go')
const iCompte = args.indexOf('--compte')
const COMPTE = iCompte >= 0 ? args[iCompte + 1] : null
if (iCompte >= 0 && !COMPTE) { console.error('--compte attend un identifiant de compte.'); process.exit(1) }
const PAGE = 500
const COLONNES = 'id, user_id, property_id, property_id_ref, booking_uid, status, deadline_at, auto_publier_le, answers_host, answers_cleaner'

;(async () => {
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${refDuProjet(URL)} — ${nom}`)
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arret.'); process.exit(1) }
  console.log(ECRIRE ? 'MODE : ECRITURE (--go)\n' : 'MODE : A BLANC (rien n’est ecrit ; --go pour ecrire)\n')

  const maintenant = Date.now()
  const { data: biens, error: eB } = await sb.from('properties').select('id, name')
  if (eB) { console.error('Biens illisibles :', eB.message); process.exit(1) }
  const nomDe = new Map((biens || []).map(b => [b.id, b.name]))

  const bilan = { lues: 0, armees: 0, ignorees: 0, erreurs: 0 }
  const motifs = {}
  let curseur = null
  for (;;) {
    let q = sb.from('guest_evaluations').select(COLONNES)
      .eq('status', 'a_remplir').is('auto_publier_le', null)
      .gt('deadline_at', new Date(maintenant).toISOString())
      .order('id', { ascending: true }).limit(PAGE)
    if (COMPTE) q = q.eq('user_id', COMPTE)
    if (curseur) q = q.gt('id', curseur)
    const { data, error } = await q
    if (error) { console.error('Evaluations illisibles :', error.message); process.exit(1) }
    if (!data || !data.length) break
    for (const e of data) {
      bilan.lues++
      const r = await armerSansPrestataire(sb, e, { maintenant, aBlanc: !ECRIRE })
      const ligne = `${(nomDe.get(e.property_id) || e.property_id).padEnd(24)} ${String(e.booking_uid).padEnd(40)} echeance ${String(e.deadline_at).slice(0, 16)}`
      if (r.erreur) { bilan.erreurs++; console.error(`  ERREUR ${ligne} — ${r.erreur}`) }
      else if (r.arme) { bilan.armees++; console.log(`  ${ECRIRE ? 'armee ' : 'a armer'} ${ligne} → publication le ${r.quand.slice(0, 16)} UTC`) }
      else { bilan.ignorees++; motifs[r.motif] = (motifs[r.motif] || 0) + 1 }
    }
    curseur = data[data.length - 1].id
    if (data.length < PAGE) break
  }

  console.log(`\n${bilan.lues} lue(s), ${bilan.armees} ${ECRIRE ? 'armee(s)' : 'a armer'}, ${bilan.ignorees} laissee(s), ${bilan.erreurs} erreur(s)`)
  for (const [m, n] of Object.entries(motifs)) console.log(`  laissees — ${m} : ${n}`)
  process.exit(bilan.erreurs ? 1 : 0)
})()
