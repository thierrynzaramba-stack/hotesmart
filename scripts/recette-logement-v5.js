#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// RECETTE — GET /api/logement sur une preview (liste + une fiche)
// ═══════════════════════════════════════════════════════════════════════════
//
// LECTURE SEULE. Aucune ecriture, aucun appel au partenaire : l'endpoint lui-meme
// n'en fait pas, et ce script ne fait que l'appeler en GET.
//
// Usage : BASE=https://… node scripts/recette-logement-v5.js [--env .env.staging]
//
// ⚠ IL REFUSE D'AFFICHER UNE REPONSE QUI PORTE UN IDENTIFIANT DU PARTENAIRE.
// C'est le point que Thierry demande de verifier a l'oeil ; le verifier a l'oeil
// seul, sur un JSON de 200 lignes, ne prouve rien. Le script le prouve d'abord,
// et n'imprime qu'ensuite — sinon il s'arrete en echec.
//
// ⚠ ET IL ECHOUE SI LA REPONSE EST VIDE. Un script qui n'a rien lu doit echouer :
// « 0 bien » et « endpoint casse » ne se distinguent pas autrement.

const fs = require('node:fs')
const { createClient } = require('@supabase/supabase-js')

const BASE = (process.env.BASE || '').replace(/\/+$/, '')
const iEnv = process.argv.indexOf('--env')
const FICHIER_ENV = iEnv > -1 ? process.argv[iEnv + 1] : '.env.staging'

if (!BASE) { console.error('BASE manquante (URL de la preview).'); process.exit(1) }

// Les valeurs ne sont JAMAIS imprimees : seuls les noms et les longueurs le sont.
for (const ligne of fs.readFileSync(FICHIER_ENV, 'utf8').split('\n')) {
  const m = ligne.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const { nomDeLaBase, refDuProjet } = require('./../lib/empreinte-base')

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, TEST_EMAIL, TEST_PASSWORD } = process.env
for (const [nom, v] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD })) {
  if (!v) { console.error(`${nom} absente de ${FICHIER_ENV}`); process.exit(1) }
}

// Tout ce qui ne doit JAMAIS apparaitre dans une reponse : les cles du
// partenaire, lues en service key AVANT l'appel, puis cherchees dans le JSON.
const INTERDITS_PAR_NOM = [
  'provider_property_id', 'provider_rate_plan_id', 'provider_channel_id',
  'provider_room_type_id', 'channel_id', 'rate_plan_id', 'room_type_id'
]

const joli = (o) => JSON.stringify(o, null, 2)

async function appeler (chemin, jeton) {
  const r = await fetch(`${BASE}${chemin}`, { headers: { authorization: `Bearer ${jeton}` } })
  const texte = await r.text()
  let json = null
  try { json = JSON.parse(texte) } catch { /* garde ci-dessous */ }
  return { statut: r.status, json, texte, entetes: Object.fromEntries(r.headers) }
}

function controlerFuite (etiquette, json, valeursInterdites) {
  const brut = JSON.stringify(json)
  const trouves = []
  for (const nom of INTERDITS_PAR_NOM) if (brut.includes(`"${nom}"`)) trouves.push(`cle ${nom}`)
  for (const v of valeursInterdites) if (v && brut.includes(String(v))) trouves.push(`valeur d un identifiant partenaire`)
  if (trouves.length) {
    console.error(`\n✖ ${etiquette} : IDENTIFIANT DU PARTENAIRE DANS LA REPONSE — ${[...new Set(trouves)].join(', ')}`)
    console.error('  La reponse n est PAS imprimee : elle ne doit pas se retrouver dans un journal.')
    return false
  }
  return true
}

;(async () => {
  // ⚠ L'EMPREINTE PASSE PAR LE MODULE, ET ELLE REFUSE (26 octobre 2026, constat
  // GRAVE de la re-review). Ce script lisait la reference par un motif maison
  // — celui dont `refDuProjet` vient de fermer les trous — et il ne refusait
  // RIEN : il imprimait la base et continuait. Or il ouvre un client de
  // SERVICE, qui contourne la RLS. Un resultat de recette qui ne dit pas OU il
  // a ete obtenu ne prouve rien.
  const base = nomDeLaBase(SUPABASE_URL)
  console.log(`base Supabase : ${base} (${refDuProjet(SUPABASE_URL) || 'reference illisible'})`)
  if (base === 'INCONNUE') {
    console.error('ECHEC : projet Supabase inconnu — ni la production, ni staging.')
    process.exit(1)
  }
  console.log(`preview       : ${BASE}`)

  // Les identifiants partenaire a traquer, lus en service key (jamais imprimes).
  let valeursInterdites = []
  if (SUPABASE_SERVICE_KEY) {
    const sbs = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data } = await sbs.from('properties')
      .select('provider_property_id, migration_target_property_id, provider_rate_plan_id').limit(100)
    valeursInterdites = (data || []).flatMap(p => [p.provider_property_id, p.migration_target_property_id, p.provider_rate_plan_id])
      .filter(v => v != null && String(v).length >= 4).map(String)
    console.log(`identifiants partenaire traques : ${valeursInterdites.length} (valeurs jamais imprimees)`)
  } else {
    console.log('SUPABASE_SERVICE_KEY absente : seule la recherche par NOM de cle sera faite')
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data: auth, error: eAuth } = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
  if (eAuth || !auth?.session?.access_token) { console.error('session de test impossible :', eAuth?.message || 'pas de jeton'); process.exit(1) }
  const jeton = auth.session.access_token

  let echecs = 0

  // ─── 1. La liste ───
  console.log('\n═══ GET /api/logement (la liste) ═══')
  const liste = await appeler('/api/logement', jeton)
  console.log(`HTTP ${liste.statut} | cache-control: ${liste.entetes['cache-control'] || '(absent)'} | vary: ${liste.entetes.vary || '(absent)'}`)
  if (liste.statut !== 200) { console.error('✖ la liste ne repond pas 200 :', liste.texte.slice(0, 300)); process.exit(1) }
  if (!liste.json || !Array.isArray(liste.json.biens)) { console.error('✖ reponse sans tableau `biens`'); process.exit(1) }
  if (!liste.json.biens.length) { console.error('✖ AUCUN BIEN : un script qui n a rien lu doit echouer'); process.exit(1) }
  if (!controlerFuite('liste', liste.json, valeursInterdites)) process.exit(1)

  console.log(`${liste.json.biens.length} logement(s) | indisponibles: ${joli(liste.json.indisponibles)} | refuses: ${joli(liste.json.refuses)}`)
  for (const b of liste.json.biens) {
    const canaux = b.canaux == null ? 'NON LU' : (b.canaux.length
      ? b.canaux.map(c => `${c.ota}${c.mappe === true ? ' en vente' : c.mappe === null ? ' (indetermine)' : ' pas sur ce bien'}`).join(', ')
      : 'aucun')
    const MOTS = { occupe: 'occupe, depart le', ferme: 'FERME jusqu au', arrivee: 'libre, prochaine arrivee le', fermeture: 'libre, puis FERME du', libre: 'libre, rien a venir' }
    const fd = b.fait_date
    const fait = fd == null ? 'NON LU'
      : `${MOTS[fd.type] || fd.type} ${fd.du || fd.au || ''}${fd.type === 'fermeture' && fd.au ? ' au ' + fd.au : ''}`.trim()
    console.log(`\n  ${b.nom}`)
    console.log(`    ville/capacite : ${b.ville || '(vide)'} · ${b.capacite == null ? 'non renseignee' : b.capacite + ' voyageurs'}`)
    console.log(`    canaux         : ${canaux}   (vu : ${b.canaux_vu_le || 'jamais'}${b.canaux_echec ? ', ECHEC signale' : ''})`)
    console.log(`    fait date      : ${fait}`)
    console.log(`    prix           : ${b.mode_des_prix} / pilote ${b.pilote_tarifaire} / base ${b.prix_de_base} ${b.devise} / plancher ${b.prix_plancher}`)
    console.log(`    assistant      : ${b.assistant_en_pause ? 'EN PAUSE' : 'actif'}${b.beds24_de_l_hote ? ' | compte Beds24 de l hote' : ''}`)
  }

  // ─── 2. Une fiche ───
  const cible = liste.json.biens[0]
  console.log(`\n═══ GET /api/logement?id=… (la fiche de « ${cible.nom} ») ═══`)
  const fiche = await appeler(`/api/logement?id=${encodeURIComponent(cible.id)}`, jeton)
  console.log(`HTTP ${fiche.statut}`)
  if (fiche.statut !== 200) { console.error('✖ la fiche ne repond pas 200 :', fiche.texte.slice(0, 300)); process.exit(1) }
  if (!controlerFuite('fiche', fiche.json, valeursInterdites)) process.exit(1)
  console.log(joli(fiche.json))

  // ─── 3. Les refus ───
  console.log('\n═══ Les refus ═══')
  const inconnu = await appeler('/api/logement?id=00000000-0000-0000-0000-000000000000', jeton)
  console.log(`bien inconnu            : HTTP ${inconnu.statut} ${inconnu.statut === 404 ? '(attendu)' : '✖ attendu 404'}`)
  if (inconnu.statut !== 404) echecs++
  const sansJeton = await fetch(`${BASE}/api/logement`)
  console.log(`sans jeton              : HTTP ${sansJeton.status} ${sansJeton.status === 401 ? '(attendu)' : '✖ attendu 401'}`)
  if (sansJeton.status !== 401) echecs++
  const post = await fetch(`${BASE}/api/logement`, { method: 'POST', headers: { authorization: `Bearer ${jeton}` } })
  console.log(`POST (aucune ecriture)  : HTTP ${post.status} ${post.status === 405 ? '(attendu)' : '✖ attendu 405'}`)
  if (post.status !== 405) echecs++

  await sb.auth.signOut()
  if (echecs) { console.error(`\nECHEC : ${echecs} controle(s) en defaut.`); process.exit(1) }
  console.log('\nRECETTE OK : liste et fiche servies, aucun identifiant partenaire, refus conformes.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
