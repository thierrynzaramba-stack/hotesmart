// scripts/inventaire-references-uuid.js
// Inventaire des colonnes qui referencent un bien par son UUID `properties.id`.
//
// ⚠ POURQUOI CE SECOND INVENTAIRE EXISTE.
// `scripts/inventaire-tables.js` inventorie les references par la CLE DU
// PROVIDER (`property_id` en TEXT). Il suffisait au plan de bascule d'origine :
// le bien gardait sa fiche, donc son UUID ne changeait jamais.
//
// Le plan retenu par Thierry le 10 septembre 2026 cree des biens NEUFS et y
// transfere les donnees. L'UUID change donc AUSSI, et tout ce qui est classe
// dessus doit suivre. Le manquer laisserait des lignes rattachees a une fiche
// retiree — invisibles, sans erreur.
//
// La source de verite est le descripteur OpenAPI de PostgREST, comme pour
// l'autre inventaire : une table qu'aucun code ne lit reste visible ici.
//
// ⚠ ON NE DEVINE PAS SUR LE NOM. Une colonne s'appelle `property_id` dans les
// deux mondes (TEXT provider ou UUID). On tranche sur les VALEURS : une colonne
// dont les valeurs sont des UUID connus de `properties.id` est une reference
// UUID. Une colonne vide est signalee comme INDETERMINEE plutot que classee.
//
// USAGE : node scripts/inventaire-references-uuid.js
// LECTURE SEULE.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const supabase = createClient(URL, KEY)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function listerSchema () {
  const r = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`descripteur OpenAPI indisponible : HTTP ${r.status}`)
  const doc = await r.json()
  const defs = doc.definitions || doc.components?.schemas || {}
  const schema = {}
  Object.keys(defs).sort().forEach(t => { schema[t] = Object.keys(defs[t].properties || {}) })
  return schema
}

// Une colonne CANDIDATE : son nom evoque un bien. On elargit volontairement —
// c'est l'inventaire manuel etroit qui avait manque 3 references la derniere fois.
const CANDIDATE = (c) => /propert|bien|logement|listing/i.test(c)

async function main () {
  const schema = await listerSchema()

  // Les UUID reellement existants, pour trancher sur les valeurs.
  const { data: biens, error: eB } = await supabase.from('properties').select('id, name, provider_property_id')
  if (eB) throw new Error(`properties : ${eB.message}`)
  const uuidConnus = new Set(biens.map(b => b.id))
  console.log(`${biens.length} biens en base\n`)

  const uuid = []; const texte = []; const indetermine = []; const tableau = []

  for (const [table, colonnes] of Object.entries(schema)) {
    if (table === 'properties') continue
    for (const col of colonnes.filter(CANDIDATE)) {
      const { data, error } = await supabase.from(table).select(col).not(col, 'is', null).limit(50)
      if (error) continue  // vue non lisible, colonne calculee : on ignore
      const vals = (data || []).map(r => r[col]).filter(v => v != null)
      if (!vals.length) { indetermine.push([table, col]); continue }

      // Colonne TABLEAU (public_tokens.property_ids) : on regarde ses elements.
      if (Array.isArray(vals[0])) {
        const plats = vals.flat().filter(v => v != null).map(String)
        const nUuid = plats.filter(v => uuidConnus.has(v)).length
        tableau.push([table, col, plats.length, nUuid,
          plats.filter(v => UUID_RE.test(v)).length])
        continue
      }

      const s = vals.map(String)
      const nUuidConnu = s.filter(v => uuidConnus.has(v)).length
      const nUuidForme = s.filter(v => UUID_RE.test(v)).length
      // ⚠ « FORME UUID » NE SUFFIT PAS. Les propId Channex SONT des UUID :
      // `provider_property_id` d'un bien Channex passerait le test de forme
      // tout en etant une cle PROVIDER. Seule l'appartenance a
      // `properties.id` tranche.
      if (nUuidConnu > 0) uuid.push([table, col, s.length, nUuidConnu, nUuidForme])
      else texte.push([table, col, s.length, nUuidForme, s[0]])
    }
  }

  const ligne = (a, b, c) => `   ${String(a).padEnd(32)} ${String(b).padEnd(26)} ${c}`

  console.log('══ REFERENCES PAR UUID `properties.id` — A DEPLACER DANS LE PLAN « BIEN NEUF »')
  console.log(ligne('table', 'colonne', 'echantillon / dont UUID connus'))
  for (const [t, c, n, k, f] of uuid.sort()) console.log(ligne(t, c, `${n} lues, ${k} pointent un bien reel (${f} de forme UUID)`))
  if (!uuid.length) console.log('   (aucune)')

  console.log('\n══ COLONNES TABLEAU')
  for (const [t, c, n, k, f] of tableau.sort()) console.log(ligne(t, c, `${n} elements, ${k} UUID connus, ${f} de forme UUID`))
  if (!tableau.length) console.log('   (aucune)')

  console.log('\n══ REFERENCES PAR CLE PROVIDER (deja couvertes par rekeying_tables*)')
  for (const [t, c, n, f, ex] of texte.sort()) console.log(ligne(t, c, `${n} lues, ex. « ${String(ex).slice(0, 40)} »`))

  console.log('\n══ INDETERMINEES — COLONNE VIDE, A TRANCHER A LA MAIN')
  console.log('   ⚠ Une colonne vide aujourd\'hui peut se remplir demain : ne pas conclure.')
  for (const [t, c] of indetermine.sort()) console.log(ligne(t, c, ''))
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
