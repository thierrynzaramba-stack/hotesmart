#!/usr/bin/env node
// scripts/rapport-base-connaissance.js
// LE RAPPORT DU LOT 2 — chantier « Base de connaissance V5 ».
// Spec : docs/specs/spec-base-connaissance-v5.md
//
//   node --env-file=<.env de la base visee> scripts/rapport-base-connaissance.js
//
// ⚠ LECTURE SEULE INTEGRALE, ET C'EST UN CHOIX, PAS UN DEFAUT D'OUTILLAGE.
// Thierry a dit « script a blanc, rapport, aucune ecriture en prod ». Ce
// fichier ne porte donc AUCUN chemin d'ecriture : pas de `--go`, pas d'`update`,
// pas d'`upsert`. Un script qui PEUT ecrire finit par ecrire — et la garde qui
// l'en empeche est une ligne qu'on peut retirer par distraction. Le nettoyage
// lui-meme sera un second outil, avec sa propre garde de production
// (`CONFIRMER_PROD` qui NOMME le projet), et il ne sera ecrit que sur un go.
//
// ⚠ ET LES SECRETS NE SORTENT PAS. Le mot de passe wifi et les codes d'acces
// sont MASQUES : on en imprime le nom et la LONGUEUR, jamais la valeur. Regle
// absolue du depot — un terminal n'est pas un canal prive : sa sortie part dans
// l'historique du shell et dans les transcriptions de session. Un secret
// affiche est un secret a faire tourner.
//
// CE QUE LE RAPPORT CHERCHE, et c'est l'inventaire de l'etape 0 rendu
// reproductible :
//   1. les valeurs ECRITES EN DUR dans les textes, alors qu'une balise existe ;
//   2. les CONTRADICTIONS entre ce que dit la base et ce que disent les modeles ;
//   3. tous les PRIX, avec leur age, pour que Thierry les verifie ;
//   4. les DOUBLONS de cle, et les entrees ORPHELINES (aucun bien derriere) ;
//   5. les biens SANS AUCUNE connaissance ;
//   6. les balises INCONNUES utilisees dans un texte.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')
const { BALISES, etiquetteDe } = require('../lib/balises')

// ⚠ LE CLIENT SE CREE AU LANCEMENT, PAS AU CHARGEMENT. `createClient` leve
// sans variables d'environnement : le construire ici rendait ce fichier
// impossible a REQUERIR, donc ses fonctions pures impossibles a eprouver
// autrement qu'en lisant leur source.
let sb = null

// ⚠ LES CLES DONT LA VALEUR NE S'IMPRIME JAMAIS.
const SECRETES = new Set(['wifi_mdp'])
const masque = (cle, v) => (SECRETES.has(cle)
  ? `(masqué, ${String(v || '').length} caractères)`
  : String(v || ''))

// ⚠ PostgREST TRONQUE A 1000 LIGNES SANS ERREUR : toute lecture se pagine.
async function tout (table, colonnes, ordre) {
  let de = 0; let acc = []
  for (;;) {
    const { data, error } = await sb.from(table).select(colonnes).order(ordre).range(de, de + 499)
    if (error) throw new Error(`${table} : ${error.message}`)
    acc = acc.concat(data)
    if (data.length < 500) return acc
    de += 500
  }
}

// Apostrophes et espaces normalises : sans ca, « l'Horloge » et « l’horloge »
// sont deux chaines differentes, et la comparaison manque ce qu'elle cherche.
const net = (s) => String(s || '').replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
const chiffres = (s) => String(s || '').replace(/\D/g, '')
const PRIX = /(\d+[.,]?\d*)\s*(€|euros?|EUR)/gi
const TEL = /0\s?\d(?:[\s.\-]?\d{2}){4}/g
const BALISE = /\{([\p{L}\p{N}_ ]{1,40})\}/gu

// ⚠ LES FONCTIONS PURES SONT EXPORTEES, ET LE RAPPORT NE S'EXECUTE QUE SI ON
// LANCE CE FICHIER. Sans ca, un test qui veut EPROUVER le masquage devrait
// l'extraire du texte source a coups d'expression reguliere — et il mesurerait
// alors sa propre regex, pas la fonction. Le `require.main` est ce qui permet
// d'appeler ce qui compte sans toucher a la base.
module.exports = { masque, SECRETES, net, chiffres }

if (require.main !== module) return
;(async () => {
  sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  // ⚠ UN RAPPORT QUI NE SAIT PAS D'OU IL PARLE NE VAUT RIEN — regle du depot,
  // et c'est un TEST qui me l'a rappelee (`tests/empreinte-base.test.js`), pas
  // ma prudence. Un verificateur qui continue sur une base inconnue rend des
  // chiffres dont personne ne pourra dire d'ou ils viennent, et la menace n'est
  // pas l'attaquant : c'est le `.env` mal colle.
  if (base === 'INCONNUE') {
    console.error('ÉCHEC : base non reconnue. Ce rapport ne mesure que des bases nommées')
    console.error('        (production ou staging) — refus plutôt qu’un chiffre sans origine.')
    process.exit(3)
  }
  console.log(`\n╔══ RAPPORT « BASE DE CONNAISSANCE » — base ${base}, LECTURE SEULE`)
  console.log(`╚══ ${new Date().toISOString()}\n`)

  const biens = await tout('properties', 'id, name, provider_property_id, provider', 'name')
  const parRef = new Map(biens.map(p => [p.provider_property_id, p]))
  const connaissance = await tout('knowledge', 'property_id, type, key, value, created_at', 'property_id')
  const modeles = await tout('message_templates', 'property_id, event_type, active, template_text', 'property_id')

  console.log(`${biens.length} bien(s), ${connaissance.length} entrée(s) de connaissance, ${modeles.length} modèle(s).\n`)

  // ── 1. Les entrées orphelines et les biens muets ────────────────────────
  const refsConnues = new Set(biens.map(p => p.provider_property_id))
  const orphelines = connaissance.filter(l => !refsConnues.has(l.property_id))
  const parBien = new Map()
  for (const l of connaissance) {
    if (!parBien.has(l.property_id)) parBien.set(l.property_id, [])
    parBien.get(l.property_id).push(l)
  }
  const muets = biens.filter(p => !parBien.has(p.provider_property_id))

  console.log('━━ 1. CE QUI N\'EST RATTACHÉ À RIEN')
  console.log(`   ${orphelines.length} entrée(s) sans bien derrière`
    + (orphelines.length ? ` : ${[...new Set(orphelines.map(l => l.property_id.slice(0, 8) + '…'))].join(', ')}` : ''))
  console.log(`   ${muets.length} bien(s) sans aucune connaissance`
    + (muets.length ? ` : ${muets.map(p => p.name).join(', ')}` : ''))

  // ── 2. Les doublons de clé ──────────────────────────────────────────────
  console.log('\n━━ 2. DOUBLONS DE CLÉ (même bien, même clé, deux entrées)')
  let doublons = 0
  for (const [ref, lignes] of parBien) {
    const vus = new Map()
    for (const l of lignes) {
      const k = `${l.type}|${net(l.key)}`
      if (vus.has(k)) {
        doublons++
        const nom = parRef.get(ref) ? parRef.get(ref).name : ref.slice(0, 8) + '…'
        const identique = net(vus.get(k).value) === net(l.value)
        console.log(`   ⚠ ${nom} · ${l.type} « ${l.key} » en double `
          + `(${identique ? 'MÊME valeur' : 'valeurs DIFFÉRENTES'}) — `
          + `${String(vus.get(k).created_at).slice(0, 10)} et ${String(l.created_at).slice(0, 10)}`)
      } else vus.set(k, l)
    }
  }
  if (!doublons) console.log('   aucun')

  // ── 3. Tous les prix, avec leur âge ─────────────────────────────────────
  console.log('\n━━ 3. TOUS LES PRIX (à vérifier un par un)')
  console.log('   ⚠ l’âge est celui de la CRÉATION de l’entrée : la base ne porte')
  console.log('     pas encore de date de vérification (lot 3). Une valeur corrigée')
  console.log('     hier peut donc s’afficher avec cent jours.')
  let prix = 0
  for (const l of connaissance) {
    const m = String(l.value || '').match(PRIX)
    if (!m) continue
    prix++
    const nom = parRef.get(l.property_id) ? parRef.get(l.property_id).name : l.property_id.slice(0, 8) + '…'
    // ⚠ C'EST L'AGE DE LA CREATION, PAS CELUI DE LA VALEUR, et il faut le dire :
    // la table ne porte AUCUNE date de vérification. Mesuré le 3 novembre 2026 :
    // Thierry a corrigé le prix du champagne ce jour-là, et cette ligne
    // affichait « écrit il y a 106 jours » — un nombre imprimé se lit comme une
    // mesure. La date de vérification arrive au lot 3 (décision D4).
    const jours = Math.round((Date.now() - new Date(l.created_at)) / 86400000)
    console.log(`   ${nom} · ${l.type} « ${l.key} » : ${m.join(', ')}  — entrée créée il y a ${jours} jours`)
  }
  for (const m of modeles) {
    const p = String(m.template_text || '').match(PRIX)
    if (!p) continue
    prix++
    const nom = parRef.get(m.property_id) ? parRef.get(m.property_id).name : m.property_id.slice(0, 8) + '…'
    console.log(`   ⚠ ${nom} · modèle ${m.event_type} : ${p.join(', ')} — un prix dans un MODÈLE, pas dans la base`)
  }
  if (!prix) console.log('   aucun')

  // ── 4. Les valeurs écrites en dur, et les contradictions ────────────────
  console.log('\n━━ 4. VALEURS ÉCRITES EN DUR DANS LES MODÈLES')
  let durs = 0
  for (const m of modeles) {
    const fixes = {}
    for (const l of (parBien.get(m.property_id) || [])) if (l.type === 'fixed') fixes[l.key] = l.value
    const nom = parRef.get(m.property_id) ? parRef.get(m.property_id).name : m.property_id.slice(0, 8) + '…'
    const txt = String(m.template_text || '')
    const dits = []

    for (const t of [...new Set(txt.match(TEL) || [])].filter(x => chiffres(x).length === 10)) {
      const attendu = fixes.telephone_hote ? chiffres(fixes.telephone_hote) : null
      dits.push(`téléphone en dur (…${chiffres(t).slice(-4)})`
        + (attendu ? (chiffres(t) === attendu ? ' = la base' : ' ⚡ CONTREDIT la base') : ' — la base n’en a pas'))
    }
    if (fixes.adresse) {
      const rue = net(String(fixes.adresse).split(',')[0])
      if (rue && net(txt).includes(rue)) dits.push('adresse en dur')
    }
    for (const cle of ['wifi_nom', 'checkin', 'checkout']) {
      if (fixes[cle] && net(txt).includes(net(fixes[cle])) && !txt.includes(`{${cle}}`)) {
        dits.push(`${etiquetteDe(cle)} en dur`)
      }
    }
    const codes = [...new Set(txt.match(/\b\d{4}#/g) || [])]
    if (codes.length) dits.push(`${codes.length} code(s) d’accès en dur (masqué)`)

    if (dits.length) {
      durs++
      console.log(`   ⚠ ${nom} · ${m.event_type} (${m.active ? 'actif' : 'inactif'}) : ${dits.join(' · ')}`)
    }
  }
  if (!durs) console.log('   aucune')

  // ── 5. Les balises utilisées, connues et inconnues ──────────────────────
  console.log('\n━━ 5. BALISES UTILISÉES DANS LES MODÈLES')
  const inconnues = new Map()
  const utilisees = new Map()
  for (const m of modeles) {
    for (const [, cle] of String(m.template_text || '').matchAll(BALISE)) {
      const dest = BALISES[cle] ? utilisees : inconnues
      dest.set(cle, (dest.get(cle) || 0) + 1)
    }
  }
  console.log(`   connues   : ${[...utilisees].map(([c, n]) => `{${c}} ×${n}`).join(', ') || 'aucune'}`)
  console.log(`   INCONNUES : ${[...inconnues].map(([c, n]) => `{${c}} ×${n}`).join(', ') || 'aucune'}`
    + (inconnues.size ? '  ⚠ ces messages sont RETENUS, jamais envoyés' : ''))

  // ── 6. Ce que la base porte, bien par bien ──────────────────────────────
  console.log('\n━━ 6. LA BASE, BIEN PAR BIEN')
  for (const p of biens) {
    const lignes = parBien.get(p.provider_property_id) || []
    const fixes = lignes.filter(l => l.type === 'fixed')
    const faqs = lignes.filter(l => l.type !== 'fixed')
    console.log(`\n   ${p.name} — ${fixes.length} fait(s), ${faqs.length} réponse(s)`)
    for (const l of fixes.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`     ${etiquetteDe(l.key).padEnd(20)} ${masque(l.key, l.value).slice(0, 70)}`)
    }
    // ⚠ UNE CLE SANS BALISE EST UN FAIT QU'AUCUN MESSAGE NE PEUT INSERER : elle
    // n'existe que pour l'IA, qui lit la base entière. C'est licite, mais ça se
    // sait — sinon l'hôte croit pouvoir s'en servir dans un modèle.
    const sansBalise = fixes.filter(l => !BALISES[l.key]).map(l => l.key)
    if (sansBalise.length) {
      console.log(`     ⓘ sans balise (lues par l’IA seulement) : ${sansBalise.join(', ')}`)
    }
    const manquantes = Object.keys(BALISES)
      .filter(c => BALISES[c].origine === 'base' && !fixes.some(l => l.key === c))
    if (manquantes.length) {
      console.log(`     ⚠ non renseigné : ${manquantes.map(etiquetteDe).join(', ')}`)
    }
  }
  console.log('\n╚══ fin du rapport — aucune écriture n’a eu lieu.\n')
})().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1) })
