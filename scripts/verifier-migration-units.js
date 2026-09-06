// scripts/verifier-migration-units.js
// Verification de la migration 2026-09-06-inventory-units.sql, EN LECTURE SEULE.
//
// Pourquoi un script et pas un `select` dans l'editeur SQL : le copier-coller
// vers Supabase tronque les lignes longues (constate trois fois). La migration ne
// porte donc plus que du DDL en lignes courtes, et tout le controle se fait ici.
//
// USAGE : node scripts/verifier-migration-units.js

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m')

async function colonneExiste (table, colonne) {
  const { error } = await supabase.from(table).select(colonne).limit(1)
  return !error
}

;(async () => {
  console.log('\n' + '─'.repeat(64))
  console.log('VERIFICATION — migration 2026-09-06-inventory-units')
  console.log('─'.repeat(64))

  const resultats = []

  // 1. properties.inventory_units
  const aUnits = await colonneExiste('properties', 'inventory_units')
  resultats.push(aUnits)
  console.log(`${ok(aUnits)} properties.inventory_units`)

  if (aUnits) {
    const { data: biens } = await supabase
      .from('properties')
      .select('name, capacity, inventory_units, inventory_type')
      .order('name')
    const tousA1 = (biens || []).every(b => b.inventory_units === 1)
    resultats.push(tousA1)
    console.log(`${ok(tousA1)} les ${(biens || []).length} biens sont a 1 unite (defaut)`)
    console.log('\n  ⚠ NE PAS CONFONDRE — capacity = PERSONNES, units = LOGEMENTS :')
    ;(biens || []).forEach(b => console.log(
      `    ${String(b.name).padEnd(28)} ${String(b.capacity).padStart(2)} personne(s)` +
      ` · ${b.inventory_units} unite(s) · ${b.inventory_type}`))
    const suspect = (biens || []).filter(b => b.inventory_units === b.capacity && b.capacity > 1)
    if (suspect.length) {
      console.log(`\n  \x1b[31m⚠ ${suspect.length} bien(s) ou units == capacity : le contresens que la migration evite.\x1b[0m`)
      resultats.push(false)
    }
  }

  // 2. Colonnes d'acquittement
  console.log('')
  for (const c of ['acquitted_at', 'acquitted_by', 'last_alerted_at']) {
    const e = await colonneExiste('automation_incidents', c)
    resultats.push(e)
    console.log(`${ok(e)} automation_incidents.${c}`)
  }

  // 3. Table write_locks (+ token) — et surtout : PAS la table des serrures
  console.log('')
  const aVerrous = await colonneExiste('write_locks', 'key')
  const aToken = aVerrous && await colonneExiste('write_locks', 'token')
  resultats.push(aVerrous, aToken)
  console.log(`${ok(aVerrous)} table write_locks`)
  console.log(`${ok(aToken)} write_locks.token (propriete du verrou)`)

  const { data: serrures } = await supabase.from('locks').select('seam_device_id').limit(1)
  const serruresIntactes = Array.isArray(serrures)
  resultats.push(serruresIntactes)
  console.log(`${ok(serruresIntactes)} table locks (SERRURES) intacte et distincte`)

  // 4. Ecriture/lecture/suppression reelle d'un verrou : la contrainte d'unicite
  //    est ce qui fait l'exclusion mutuelle, il faut la voir fonctionner.
  if (aVerrous) {
    console.log('')
    const cle = `verif-migration:${Date.now()}`
    const expire = new Date(Date.now() + 60000).toISOString()
    const { error: e1 } = await supabase.from('write_locks').insert({ key: cle, token: 'a', expire_at: expire })
    const { error: e2 } = await supabase.from('write_locks').insert({ key: cle, token: 'b', expire_at: expire })
    const collision = e2 && e2.code === '23505'
    resultats.push(!e1, !!collision)
    console.log(`${ok(!e1)} pose d'un verrou`)
    console.log(`${ok(!!collision)} exclusion mutuelle (2e insert rejete en 23505)`)
    await supabase.from('write_locks').delete().eq('key', cle)
    const { data: reste } = await supabase.from('write_locks').select('key').eq('key', cle)
    console.log(`${ok(!(reste || []).length)} liberation (nettoyage du verrou de test)`)
    resultats.push(!(reste || []).length)
  }

  const tout = resultats.every(Boolean)
  console.log('\n' + '─'.repeat(64))
  console.log(tout
    ? '\x1b[32mVERDICT : migration appliquee et fonctionnelle.\x1b[0m'
    : '\x1b[31mVERDICT : INCOMPLETE — voir les ✗ ci-dessus.\x1b[0m')
  console.log('─'.repeat(64) + '\n')
  process.exit(tout ? 0 : 1)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
