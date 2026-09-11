// scripts/mapper-airbnb-second-bien.js
// Rattache un SECOND bien a un canal Airbnb existant, et mappe son annonce.
//
// ⚠ POURQUOI CE CHEMIN EXISTE, ET POURQUOI IL EVITE UN OAUTH.
// Un canal Airbnb porte les JETONS OAuth d'un compte. Le compte de Thierry
// porte trois annonces, dont celle du 23 : son canal existant les voit toutes
// (`mapping_details` les liste). Rattacher le 23 a CE canal evite de refaire un
// OAuth — et evite surtout de creer un SECOND canal sur le meme compte Airbnb,
// ce que Channex n'aime pas et qui brouille la lecture.
//
// ⚠ URGENCE REELLE AU MOMENT DE L'ECRIRE (11 septembre 2026) : depuis la
// deconnexion de test de la veille, l'annonce du 23 vend EN AUTONOMIE — Airbnb
// affiche septembre ouvert a 94 €. Channex detient deja la fermeture
// (`availability: 0`, `stop_sell: true` sur son tarif derive) : il ne manque que
// le mapping pour qu'elle reprenne la main.
//
// ⚠ LE PUT NE DOIT PAS EMPORTER LES JETONS. Mesure du 10 septembre sur un canal
// Booking : `PUT /channels/:id` FUSIONNE les `settings`. Ici on n'envoie meme
// pas `settings` — seulement `properties` — et on VERIFIE apres coup que
// `settings.tokens` est toujours la. Un canal Airbnb sans jetons est mort.
//
// ⚠ ET UN MAPPING PAR ANNONCE. Airbnb refuse un second mapping sur la MEME
// annonce (`422 rate plan already exists`). Ici l'annonce est differente de
// celle deja mappee : c'est le cas legitime.
//
// DRY RUN par defaut.
// USAGE : node scripts/mapper-airbnb-second-bien.js <coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')
const dodo = (ms) => new Promise(r => setTimeout(r, ms))

async function appel (m, p, b, n = 5) {
  for (let i = 1; i <= n; i++) {
    try {
      const r = await fetch(`${BASE}${p}`, {
        method: m,
        headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
        ...(b ? { body: JSON.stringify(b) } : {})
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { j = null }
      return { ok: r.ok, status: r.status, json: j, texte: t }
    } catch (e) {
      console.log(`      reseau KO (${i}/${n}) : ${e.cause?.code || e.message}`)
      if (i === n) throw e
      await dodo(3000 * i)
    }
  }
}

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const CIBLES = {
  'coeur-23': {
    nom: 'Cœur de vie l 23',
    canal: '224cbb66-0e3f-4f4d-9a27-3071629ab27c',   // canal Airbnb du compte de Thierry
    fiche: 'efe1daf1-652c-4177-b29b-19f1db377c96',        // la fiche HoteSmart
    propriete: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66',
    derive: '97462698-d3ea-4c70-84ec-67d0f71429ea',
    listing: '697908942876699669'
  }
}
const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/mapper-airbnb-second-bien.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]
const ok = (b) => b ? '✓' : '⛔'

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN'}  ${C.nom}\n`)

  const g = await appel('GET', `/channels/${C.canal}`)
  const a = g.json?.data?.attributes
  if (!a) throw new Error(`canal introuvable : HTTP ${g.status}`)
  const propsAvant = a.properties || []
  const clesAvant = Object.keys(a.settings || {}).sort()
  console.log(`   canal ${JSON.stringify(a.title)}  actif=${a.is_active}`)
  console.log(`   biens avant : ${JSON.stringify(propsAvant)}`)
  console.log(`   jetons : ${a.settings?.tokens ? 'presents' : 'ABSENTS ⛔'}  token_invalid=${a.settings?.token_invalid}`)
  console.log(`   mappings avant : ${(a.rate_plans || []).length}`)

  // ⚠ LE DERIVE VISE DOIT ETRE CELUI DE CE BIEN, ET C'EST LA BASE QUI LE DIT.
  // Releve en review : la « preuve » finale comparait la reponse de Channex a
  // la constante qu'on venait de poster — tautologique. Depuis que le canal de
  // Thierry porte LES DEUX biens, coller par erreur le derive de La bulle dans
  // la fiche du 23 mapperait l'annonce du 23 sur le tarif du voisin, POST
  // accepte, et le script imprimerait « ✓ mappe sur le DERIVE attendu ».
  const { data: lien } = await supabase.from('property_channel_rate_plans')
    .select('provider_rate_plan_id').eq('property_id', C.fiche)
    .eq('channel', 'airbnb').eq('role', 'derived').maybeSingle()
  const deriveEnBase = lien?.provider_rate_plan_id || null
  console.log(`   derive attendu (base) : ${deriveEnBase || 'AUCUN ⛔'}`)
  if (!deriveEnBase) throw new Error('aucun lien airbnb/derived en base pour ce bien')
  if (deriveEnBase !== C.derive) {
    throw new Error(`le derive code en dur (${C.derive}) n'est pas celui du bien `
      + `(${deriveEnBase}) — mapper l'annonce sur le tarif d'un AUTRE bien`)
  }

  // ⚠ REFUS : l'annonce visee ne doit pas deja etre mappee (un mapping par annonce).
  // ⚠ MAIS LE MAPPING SEUL NE SUFFIT PAS : le bien doit aussi etre RATTACHE au
  // canal. Releve en review : apres une execution partielle (POST mapping
  // passe, PUT properties non), ce court-circuit affichait ✓ et sortait en 0
  // alors que `channel.properties` ne portait pas le bien — donc aucun ARI ne
  // partait sur ce canal. Le faux vert portait sur un geste d'ECRITURE.
  const dejaMappee = (a.rate_plans || []).some(m => String(m.settings?.listing_id) === C.listing)
  const dejaRattache = propsAvant.map(String).includes(C.propriete)
  if (dejaMappee && dejaRattache) { console.log('\n   ✓ annonce mappee ET bien rattache — rien a faire'); return }
  if (dejaMappee && !dejaRattache) {
    console.log('\n   ⚠ annonce DEJA mappee mais bien NON rattache au canal'
      + ' — on fait le rattachement seul (execution partielle precedente)')
  }

  const propsApres = [...new Set([...propsAvant.map(String), C.propriete])]
  const payloadProps = { channel: { properties: propsApres } }
  const payloadMap = { mapping: {
    rate_plan_id: C.derive,
    settings: { listing_id: C.listing, primary_occ: true }
  } }

  if (!ECRIRE) {
    console.log(`\n   ferait : PUT /channels/${C.canal}`)
    console.log(`      ${JSON.stringify(payloadProps)}`)
    console.log(`   puis   : POST /channels/${C.canal}/mappings`)
    console.log(`      ${JSON.stringify(payloadMap)}`)
    console.log('\nEssai a blanc — rien ecrit. Relancer avec --ecrire.')
    return
  }

  // ── 1) RATTACHER LE BIEN ──────────────────────────────────────────────────
  const pu = await appel('PUT', `/channels/${C.canal}`, payloadProps)
  console.log(`\n   PUT properties -> HTTP ${pu.status}`)
  if (!pu.ok) { console.log('   ' + pu.texte.slice(0, 300)); throw new Error('rattachement refuse') }

  // ⚠ CONTROLE IMMEDIAT DES JETONS. Un canal Airbnb sans jetons est mort, et il
  // faudrait un nouvel OAuth pour le ressusciter.
  await dodo(3000)
  const v1 = await appel('GET', `/channels/${C.canal}`)
  const a1 = v1.json?.data?.attributes || {}
  const clesApres = Object.keys(a1.settings || {}).sort()
  const perdues = clesAvant.filter(k => !clesApres.includes(k))
  console.log(`   ${ok(!!a1.settings?.tokens)} jetons ${a1.settings?.tokens ? 'intacts' : 'PERDUS ⛔'}`)
  console.log(`   ${ok(perdues.length === 0)} cles de settings perdues : ${perdues.length ? perdues.join(', ') : 'aucune'}`)
  console.log(`   biens apres : ${JSON.stringify(a1.properties)}`)
  if (!a1.settings?.tokens) throw new Error('JETONS PERDUS — on s arrete, ne pas mapper')

  // ── 2) MAPPER L'ANNONCE ───────────────────────────────────────────────────
  if (dejaMappee) {
    console.log(`\n   mapping deja en place — POST saute (Channex refuse le doublon : 422)`)
  } else {
    const mp = await appel('POST', `/channels/${C.canal}/mappings`, payloadMap)
    console.log(`\n   POST mapping -> HTTP ${mp.status}`)
    if (!mp.ok) { console.log('   ' + mp.texte.slice(0, 400)); throw new Error('mapping refuse') }
  }

  // ⚠ LA LECTURE EST DIFFEREE : un GET immediat peut montrer `rate_plans: []`
  // puis le mapping revenir avec la config reelle de l'annonce. On attend.
  await dodo(8000)
  const v2 = await appel('GET', `/channels/${C.canal}`)
  const a2 = v2.json?.data?.attributes || {}
  console.log(`\n── PREUVE`)
  console.log(`   actif=${a2.is_active}  mappings=${(a2.rate_plans || []).length}`)
  for (const m of a2.rate_plans || []) {
    const s = m.settings || {}
    const p = s.pricing_setting || {}
    const cible = String(s.listing_id) === C.listing
    console.log(`   ${cible ? '>>>' : '   '} listing=${s.listing_id} rate_plan=${m.rate_plan_id}`)
    console.log(`       published=${s.published} sync=${s.sync_category}`)
    if (cible) {
      console.log(`       ${ok(m.rate_plan_id === deriveEnBase)} mappe sur le DERIVE de ce bien (lu en base : ${deriveEnBase})`)
      console.log(`       A1 : guests_included=${p.guests_included} price_per_extra_person=${p.price_per_extra_person}`)
    }
  }
  console.log(`   ${ok(!!a2.settings?.tokens)} jetons toujours la`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
