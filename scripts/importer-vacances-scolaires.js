// scripts/importer-vacances-scolaires.js
// Importe les vacances scolaires officielles dans le coeur (table cachee).
// Spec : docs/specs/spec-yieldflow-v1.md §5 — docs/kb/evenements-yield.md
//
// ⚠ LECTURE SEULE SUR LA SOURCE (REVIEW.md regle 12) : uniquement des GET sur
// data.education.gouv.fr, l'API publique du ministere. Aucun appel provider.
//
// ⚠ IMPORTE ET CACHE, JAMAIS INTERROGE A LA VOLEE.
// Les calendriers officiels sont publies des ANNEES a l'avance et ne bougent
// pratiquement jamais. Interroger la source a chaque calcul rendrait le moteur
// dependant d'un tiers pour une donnee qui ne change pas — et le ferait tomber
// avec elle.
//
// ⚠ LES TROIS ZONES, PAS SEULEMENT CELLE DU BIEN.
// Un logement toulousain (zone C) accueille des Parisiens (zone C) mais aussi
// des Lyonnais (zone A) et des Lillois (zone B). La demande depend des vacances
// de TOUTES les zones — c'est meme l'interet du signal : savoir quelle zone
// remplit quel bien.
//
// USAGE : node scripts/importer-vacances-scolaires.js [--go] [--zone=C]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const {
  periodeDepuisSource, estLignePertinente, zoneDepuisSource, zoneDuBien
} = require('../lib/yield/zones-scolaires')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const GO = process.argv.includes('--go')
const ZONE_ARG = (process.argv.find(a => a.startsWith('--zone=')) || '').split('=')[1] || null

const BASE = 'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records'
const PAR_PAGE = 100          // maximum autorise par l'API v2
const ZONES = ZONE_ARG ? [ZONE_ARG.toUpperCase()] : ['A', 'B', 'C']

let appels = 0

async function lirePage (zone, offset) {
  const url = `${BASE}?where=${encodeURIComponent(`zones="Zone ${zone}"`)}` +
    `&limit=${PAR_PAGE}&offset=${offset}&order_by=start_date`
  appels++
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`source HTTP ${r.status} (zone ${zone}, offset ${offset})`)
  return r.json()
}

// Toutes les periodes d'une zone, dedoublonnees.
// ⚠ LA SOURCE CONTIENT DES DOUBLONS PAR CONSTRUCTION : une ligne par ACADEMIE,
// et les academies d'une meme zone partagent leurs dates. Zone C = 340 lignes
// pour ~70 periodes reelles. On dedoublonne sur (nom, date_debut), la meme cle
// que l'index unique de la table — pour que le script et la base soient
// d'accord sur ce qu'est un doublon.
async function periodesDeLaZone (zone) {
  const parCle = new Map()
  const divergences = []
  const ignorees = []
  let offset = 0
  let total = null

  for (;;) {
    const page = await lirePage(zone, offset)
    if (total === null) total = page.total_count
    const lignes = page.results || []
    for (const l of lignes) {
      if (!estLignePertinente(l)) continue
      if (zoneDepuisSource(l) !== zone) continue
      const p = periodeDepuisSource(l)
      if (!p) continue
      const nom = String(l.description || '').trim()
      if (!nom) continue
      // ⚠ `annee_scolaire` EST OBLIGATOIRE EN BASE : une ligne sans annee
      // ferait echouer l'upsert du LOT ENTIER sur violation de contrainte, et
      // la zone ne serait pas importee du tout. On l'ecarte au filtre, comme
      // `nom` vide juste au-dessus.
      const annee = String(l.annee_scolaire || '').trim()
      if (!annee) { ignorees.push(`${nom} ${p.date_debut} : annee_scolaire absente`); continue }

      // ⚠ LA CLE DE DIVERGENCE PORTE SUR (nom, annee), PAS SUR LA DATE.
      // Releve en review : cle sur `date_debut`, deux academies qui divergent
      // sur le DEBUT produisaient deux cles differentes, donc deux lignes
      // ecrites toutes les deux — sans le moindre avertissement, exactement le
      // silence que ce bloc existe pour empecher.
      const cle = `${nom}|${annee}`
      const existante = parCle.get(cle)
      if (existante) {
        if (existante.date_debut !== p.date_debut || existante.date_fin !== p.date_fin) {
          divergences.push(`${nom} ${annee} : ${existante.date_debut}→${existante.date_fin}` +
            ` vs ${p.date_debut}→${p.date_fin}`)
        }
        continue
      }
      parCle.set(cle, {
        zone, annee_scolaire: annee,
        nom, date_debut: p.date_debut, date_fin: p.date_fin
      })
    }
    offset += PAR_PAGE
    if (!lignes.length || offset >= total) break
    if (offset > 5000) break     // garde-fou : la source ne depasse pas 1000 lignes par zone
  }
  return { periodes: [...parCle.values()], brut: total, divergences, ignorees }
}

async function main () {
  console.log('IMPORT DES VACANCES SCOLAIRES')
  console.log(`Source  : data.education.gouv.fr (GET uniquement)`)
  console.log(`Zones   : ${ZONES.join(', ')}`)
  console.log(GO ? 'MODE ECRITURE (--go)\n' : 'DRY-RUN — aucune ecriture\n')

  // Les zones de nos biens, pour situer ce qu'on importe.
  // ⚠ L'ERREUR EST LUE, PAS AVALEE. Sans ce controle, une colonne
  // `zone_scolaire` absente (migration non appliquee) rendait `biens =
  // undefined`, donc une liste vide, donc un bloc « ZONE DES BIENS » muet —
  // et le script affichait un succes en n'ayant rien lu. Constate sur le
  // premier dry-run de ce script.
  const { data: biens, error: eBiens } = await supabase
    .from('properties').select('id, name, zip_code, country, zone_scolaire')
  if (eBiens) {
    throw new Error(`lecture des biens impossible (migration appliquee ?) : ${eBiens.message}`)
  }
  const zonesDesBiens = new Map()
  for (const b of biens || []) {
    const z = zoneDuBien(b)
    if (z) zonesDesBiens.set(z, [...(zonesDesBiens.get(z) || []), b.name])
  }

  let totalPeriodes = 0
  let totalEcrites = 0

  for (const zone of ZONES) {
    const { periodes, brut, divergences, ignorees } = await periodesDeLaZone(zone)
    totalPeriodes += periodes.length
    const annees = [...new Set(periodes.map(p => p.annee_scolaire).filter(Boolean))].sort()
    const biensIci = zonesDesBiens.get(zone)
    console.log(`Zone ${zone} : ${periodes.length} periode(s) retenue(s) sur ${brut} ligne(s) brutes` +
      (biensIci ? `   ← vos biens : ${biensIci.join(', ')}` : ''))
    console.log(annees.length
      ? `   annees scolaires : ${annees[0]} → ${annees[annees.length - 1]} (${annees.length})`
      : '   ⚠ AUCUNE periode retenue pour cette zone — verifier le filtre')
    if (ignorees.length) {
      console.log(`   ${ignorees.length} ligne(s) ecartee(s) : ${ignorees[0]}`)
    }
    if (divergences.length) {
      console.log(`   ⚠ ${divergences.length} divergence(s) entre academies d'une meme zone :`)
      for (const d of divergences.slice(0, 3)) console.log(`      ${d}`)
    }
    const proches = periodes
      .filter(p => p.date_fin >= new Date().toISOString().slice(0, 10))
      .sort((a, b) => a.date_debut.localeCompare(b.date_debut))
      .slice(0, 3)
    for (const p of proches) {
      console.log(`   a venir : ${p.date_debut} → ${p.date_fin}  ${p.nom}`)
    }

    if (GO && periodes.length) {
      // ⚠ ON REMPLACE L'ANNEE ENTIERE, JAMAIS UNE LIGNE ISOLEE.
      // Releve en review : un simple `upsert` sur (zone, nom, date_debut) ne
      // peut PAS rafraichir une periode dont la date de DEBUT change. Si le
      // ministere publie un arrete modificatif, le rejeu inserait une SECONDE
      // ligne et laisserait l'ancienne — le moteur compterait alors deux
      // periodes de vacances qui se chevauchent. Rien n'aurait jamais purge
      // les lignes disparues de la source.
      // C'est aussi ce que la migration annonce en commentaire ; le script ne
      // le faisait nulle part.
      const annees = [...new Set(periodes.map(p => p.annee_scolaire))]
      const { error: eDel } = await supabase
        .from('school_holidays')
        .delete().eq('zone', zone).in('annee_scolaire', annees)
      if (eDel) throw new Error(`purge zone ${zone} : ${eDel.message}`)
      const { error } = await supabase.from('school_holidays').insert(periodes)
      if (error) throw new Error(`ecriture zone ${zone} : ${error.message}`)
      totalEcrites += periodes.length
      console.log(`   ecrit : ${periodes.length} periode(s) sur ${annees.length} annee(s) remplacee(s)`)
    }
    console.log('')
  }

  // ─── La zone de chaque bien ───────────────────────────────────────────────
  console.log('ZONE DES BIENS (deduite du code postal, modifiable ensuite)')
  const aPoser = []
  for (const b of biens || []) {
    const z = zoneDuBien(b)
    const etat = b.zone_scolaire
      ? (b.zone_scolaire === z ? 'deja posee' : `⚠ posee ${b.zone_scolaire}, deduite ${z}`)
      : (z ? 'a poser' : 'indeterminable')
    console.log(`  ${String(b.name).padEnd(20)} ${b.zip_code || '?????'} → ${z || '—'}   (${etat})`)
    if (z && !b.zone_scolaire) aPoser.push({ id: b.id, zone_scolaire: z })
  }
  if (GO && aPoser.length) {
    for (const p of aPoser) {
      const { error } = await supabase
        .from('properties').update({ zone_scolaire: p.zone_scolaire }).eq('id', p.id)
      if (error) throw new Error(`zone du bien ${p.id} : ${error.message}`)
    }
    console.log(`  ${aPoser.length} zone(s) posee(s)`)
  }

  console.log(`\nBUDGET D'APPELS : ${appels} requete(s) GET sur la source publique.`)
  console.log(`${totalPeriodes} periode(s) au total${GO ? `, ${totalEcrites} ecrite(s)` : ''}`)
  if (!GO) console.log('DRY-RUN — relancer avec --go pour ecrire.')
  else console.log('Rafraichissement : rejouer ce script (upsert, aucun doublon).')
}

main().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
