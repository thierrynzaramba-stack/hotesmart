// scripts/inventaire-tables.js
// Inventaire EXHAUSTIF des tables du schema public, avec le type de property_id.
//
// ⚠ POURQUOI CE SCRIPT EXISTE. Le premier inventaire du chantier « profils et
// droits » partait des tables citees dans le code (`grep from('...')`). Une table
// presente en base mais qu'aucun code ne lit etait donc INVISIBLE — c'est ainsi
// qu'une table `profiles` preexistante a ete manquee, et que la migration a
// echoue en tentant de la creer.
//
// La source de verite est ici l'API OpenAPI de PostgREST (GET /rest/v1/), qui
// liste TOUT ce que le schema public expose, code ou pas.
//
// USAGE : node scripts/inventaire-tables.js
// LECTURE SEULE.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const supabase = createClient(URL, KEY)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Toutes les tables exposees, depuis le descripteur OpenAPI de PostgREST.
async function listerTables() {
  const r = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`descripteur OpenAPI indisponible : HTTP ${r.status}`)
  const doc = await r.json()
  return Object.keys(doc.definitions || doc.components?.schemas || {}).sort()
}

async function main() {
  if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents de .env.local'); process.exit(1) }

  const tables = await listerTables()
  const { data: props } = await supabase.from('properties').select('id, provider_property_id')
  const uuids = new Set((props || []).map(p => String(p.id)))
  const refs  = new Set((props || []).map(p => String(p.provider_property_id)))

  console.log(`${tables.length} tables exposees dans le schema public\n`)
  console.log('TABLE'.padEnd(32) + 'LIGNES'.padStart(7) + '  user_id  property_id')
  console.log('-'.repeat(92))

  const sansUserId = []
  for (const t of tables) {
    const { data, count, error } = await supabase.from(t).select('*', { count: 'exact' }).limit(200)
    if (error) { console.log(`${t.padEnd(32)}${'?'.padStart(7)}  (${error.message.slice(0, 40)})`); continue }

    const cols = new Set()
    ;(data || []).forEach(r => Object.keys(r).forEach(k => cols.add(k)))
    const aUserId = cols.has('user_id')
    if (!aUserId) sansUserId.push(t)

    let typePid = '—'
    if (cols.has('property_id')) {
      const vals = [...new Set((data || []).map(r => r.property_id).filter(v => v != null).map(String))]
      if (!vals.length) typePid = 'present (aucune valeur)'
      else {
        const nRef = vals.filter(v => refs.has(v)).length
        const nId  = vals.filter(v => uuids.has(v)).length
        const nOrph = vals.filter(v => !refs.has(v) && !uuids.has(v)).length
        const p = []
        if (nRef) p.push(`${nRef} TEXT`)
        if (nId) p.push(`${nId} UUID`)
        if (nOrph) p.push(`${nOrph} orphelin${vals.some(v => UUID_RE.test(v) && !uuids.has(v)) ? ' (uuid)' : ''}`)
        typePid = p.join(' + ') + ([nRef, nId, nOrph].filter(Boolean).length > 1 ? '  ⚠ MIXTE' : '')
      }
    }
    console.log(`${t.padEnd(32)}${String(count).padStart(7)}  ${aUserId ? '  oui  ' : '  NON  '}  ${typePid}`)
  }

  console.log(`\nSans user_id (hors RLS par compte) : ${sansUserId.length}`)
  sansUserId.forEach(t => console.log('   -', t))
  console.log(`\nA user_id : ${tables.length - sansUserId.length}`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
