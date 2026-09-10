// scripts/rekeyer-json-config.js
// Deplace les references a un bien tenues comme CLES DANS UN JSONB.
//
// ⚠ LE TROISIEME ANGLE MORT DE L'INVENTAIRE, TROUVE EN REVIEW LE
// 10 SEPTEMBRE 2026.
// `scripts/inventaire-tables.js` cherche les colonnes nommees `property_id` ;
// `scripts/inventaire-references-uuid.js` tranche sur les valeurs de colonnes
// dont le NOM parle de bien. Aucun des deux ne pouvait voir
// `agent_alert_config.config` : la colonne s'appelle `config`, et la reference
// n'est pas une valeur de colonne mais une CLE d'objet JSON.
//
// CE QUE CA COUTAIT, MESURE : l'entree `209413` de La bulle porte
// `mode: 'auto'` et les destinataires d'alerte (SMS + e-mail). La fiche neuve
// n'ayant aucune entree, `getPropertyMode` (lib/cron-shared.js:118) retombe sur
// son defaut `'test'` — l'agent IA du bien migre etait donc muet depuis le
// transfert, et ses alertes d'intervention rattachees a la cle abandonnee.
// Aucune erreur, aucun log : exactement le genre de silence que ce depot paye
// en boucle.
//
// ⚠ POURQUOI CE N'EST PAS DANS `transferer_bien` (SQL).
// Manipuler des cles d'objet JSONB en plpgsql generique demanderait de
// reconstruire l'objet cle par cle, sans gain : il n'y a qu'une table dans ce
// cas, et l'operation est naturelle en JS. Le transfert l'appelle donc juste
// apres, dans le meme geste.
//
// DRY RUN par defaut.
// USAGE : node scripts/rekeyer-json-config.js <ancienneCle> <nouvelleCle> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Liste fermee : (table, colonne jsonb). A completer si un autre JSONB se met
// a indexer par bien — et le signaler dans l'inventaire, pas ici.
const JSONB_INDEXES_PAR_BIEN = [
  ['agent_alert_config', 'config']
]

async function rekeyerJson (ancienne, nouvelle, { ecrire = false, userId = null } = {}) {
  const faits = []
  for (const [table, colonne] of JSONB_INDEXES_PAR_BIEN) {
    let q = supabase.from(table).select(`user_id, ${colonne}`)
    if (userId) q = q.eq('user_id', userId)
    const { data, error } = await q
    if (error) { faits.push({ table, erreur: error.message }); continue }

    for (const ligne of data || []) {
      const cfg = ligne[colonne] || {}
      if (!Object.prototype.hasOwnProperty.call(cfg, String(ancienne))) continue

      // ⚠ ON N'ECRASE PAS UNE ENTREE EXISTANTE SOUS LA NOUVELLE CLE.
      // Elle serait le reglage que l'hote a pose sur la fiche neuve : le
      // remplacer par celui de l'ancienne perdrait son geste le plus recent.
      const dejaLa = Object.prototype.hasOwnProperty.call(cfg, String(nouvelle))
      if (dejaLa) {
        faits.push({ table, user_id: ligne.user_id, saute: 'la nouvelle cle a deja une entree' })
        continue
      }

      const neuf = { ...cfg }
      neuf[String(nouvelle)] = neuf[String(ancienne)]
      delete neuf[String(ancienne)]

      if (!ecrire) {
        faits.push({ table, user_id: ligne.user_id,
          ferait: `${ancienne} -> ${nouvelle}`,
          mode: (cfg[String(ancienne)] || {}).mode })
        continue
      }
      const { error: eUp } = await supabase.from(table)
        .update({ [colonne]: neuf }).eq('user_id', ligne.user_id)
      faits.push({ table, user_id: ligne.user_id,
        fait: !eUp, erreur: eUp ? eUp.message : undefined,
        mode: (cfg[String(ancienne)] || {}).mode })
    }
  }
  return faits
}

async function main () {
  const args = process.argv.slice(2).filter(a => a !== '--ecrire')
  const ecrire = process.argv.includes('--ecrire')
  if (args.length !== 2) {
    console.error('USAGE : node scripts/rekeyer-json-config.js <ancienneCle> <nouvelleCle> [--ecrire]')
    process.exit(1)
  }
  console.log(ecrire ? 'MODE ECRITURE' : 'DRY RUN — rien ne sera ecrit')
  console.log(`   ${args[0]}  ->  ${args[1]}`)
  const faits = await rekeyerJson(args[0], args[1], { ecrire })
  if (!faits.length) return console.log('\n   aucune entree a deplacer')
  for (const f of faits) console.log('   ' + JSON.stringify(f))
}

if (require.main === module) {
  main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
}

module.exports = { rekeyerJson, JSONB_INDEXES_PAR_BIEN }
