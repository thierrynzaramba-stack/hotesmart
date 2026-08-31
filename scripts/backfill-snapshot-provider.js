// scripts/backfill-snapshot-provider.js
// Backfill des lignes bookings_snapshot ANTERIEURES a l'unification :
//   - renseigne snapshot.provider depuis properties (via property_id = provider_property_id)
//   - normalise snapshot.status avec canonicalStatus(), en conservant le brut dans statusRaw
//
// USAGE
//   node scripts/backfill-snapshot-provider.js            -> COMPTAGE A BLANC (aucune ecriture)
//   node scripts/backfill-snapshot-provider.js --apply    -> ecrit les lignes concernees
//
// IDEMPOTENT : ne reecrit que les lignes qui changent reellement. Un second passage
// ne touche plus rien. Ne supprime jamais, n'ajoute aucune ligne.
//
// Contexte : docs/kb/bookings-snapshot.md. Ce backfill n'est PAS indispensable —
// les lecteurs passent desormais le provider du bien en defaut — mais il supprime
// les warns "statut inconnu" residuels et rend chaque ligne auto-portante.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const { canonicalStatus, ALL_STATUSES } = require('../lib/bookings-snapshot')

const APPLY = process.argv.includes('--apply')
const PAGE = 1000

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

function pct(n, total) {
  return total ? ` (${(100 * n / total).toFixed(1)} %)` : ''
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents de .env.local')
    process.exit(1)
  }
  console.log(APPLY ? '=== MODE ECRITURE (--apply) ===' : '=== COMPTAGE A BLANC (aucune ecriture) ===')

  // 1. Table de correspondance provider_property_id (TEXT) -> provider du bien.
  const { data: props, error: propErr } = await supabase
    .from('properties')
    .select('provider_property_id, provider')
    .not('provider_property_id', 'is', null)
  if (propErr) throw new Error('lecture properties : ' + propErr.message)

  const providerByPropId = {}
  ;(props || []).forEach(p => { providerByPropId[String(p.provider_property_id)] = p.provider })
  console.log(`biens references : ${Object.keys(providerByPropId).length}`)

  // 2. Parcours pagine de bookings_snapshot.
  const stats = {
    total: 0,
    providerNull: 0,
    statusHorsVocabulaire: 0,
    aCorriger: 0,
    corrigees: 0,
    echecs: 0,
    bienIntrouvable: 0,        // property_id sans bien correspondant -> provider indeterminable
    warnALaLecture: 0,         // provider absent ET statut brut -> fallback + warn si le lecteur
                               // ne fournit pas le provider du bien en defaut
    comptes: new Set(),
    parProvider: {},           // provider du bien -> compteurs
    statutsBrutsRencontres: {} // statut brut -> occurrences
  }

  function bump(provider, champ) {
    const key = provider || '(bien introuvable)'
    stats.parProvider[key] = stats.parProvider[key] || { lignes: 0, providerNull: 0, statusHorsVocabulaire: 0, aCorriger: 0 }
    stats.parProvider[key][champ]++
  }

  let from = 0
  for (;;) {
    const { data: rows, error } = await supabase
      .from('bookings_snapshot')
      .select('user_id, booking_id, property_id, snapshot')
      .order('booking_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error('lecture bookings_snapshot : ' + error.message)
    if (!rows || !rows.length) break

    for (const row of rows) {
      const snap = row.snapshot || {}
      const propProvider = providerByPropId[String(row.property_id)]
      stats.total++
      bump(propProvider, 'lignes')

      const statusBrut = String(snap.status || '')
      stats.statutsBrutsRencontres[statusBrut || '(vide)'] =
        (stats.statutsBrutsRencontres[statusBrut || '(vide)'] || 0) + 1

      const providerManquant = !snap.provider
      const statusHorsVocab = !!statusBrut && !ALL_STATUSES.includes(statusBrut.toLowerCase())

      stats.comptes.add(row.user_id)
      if (providerManquant && statusHorsVocab) stats.warnALaLecture++
      if (providerManquant) { stats.providerNull++; bump(propProvider, 'providerNull') }
      if (statusHorsVocab)  { stats.statusHorsVocabulaire++; bump(propProvider, 'statusHorsVocabulaire') }
      if (!propProvider)    stats.bienIntrouvable++

      // Sans provider du bien on ne peut pas choisir la table de correspondance :
      // on ne devine pas, on laisse la ligne intacte (les lecteurs la gerent).
      if (!propProvider) continue
      if (!providerManquant && !statusHorsVocab) continue

      const provider = snap.provider || propProvider
      const nouveau = { ...snap, provider }
      if (statusHorsVocab) {
        if (snap.statusRaw === undefined) nouveau.statusRaw = snap.status || null
        nouveau.status = canonicalStatus(snap.status, provider)
      }

      // Idempotence : rien a ecrire si le contenu est deja identique.
      if (JSON.stringify(nouveau) === JSON.stringify(snap)) continue
      stats.aCorriger++
      bump(propProvider, 'aCorriger')

      if (APPLY) {
        const { error: upErr } = await supabase
          .from('bookings_snapshot')
          .update({ snapshot: nouveau })
          .eq('user_id', row.user_id)
          .eq('booking_id', row.booking_id)
        if (upErr) { stats.echecs++; console.error('echec', row.booking_id, upErr.message) }
        else stats.corrigees++
      }
    }

    from += PAGE
    if (rows.length < PAGE) break
  }

  // 3. Rapport.
  console.log('\n--- COMPTAGE ---')
  console.log(`lignes bookings_snapshot         : ${stats.total}`)
  console.log(`provider absent du snapshot      : ${stats.providerNull}${pct(stats.providerNull, stats.total)}`)
  console.log(`statut hors vocabulaire canonique: ${stats.statusHorsVocabulaire}${pct(stats.statusHorsVocabulaire, stats.total)}`)
  console.log(`bien introuvable (non corrigeable): ${stats.bienIntrouvable}`)
  console.log(`lignes a corriger                : ${stats.aCorriger}`)
  console.log(`comptes concernes                : ${stats.comptes.size}`)
  console.log(`-> warn a la lecture SI le lecteur ne passe pas le provider du bien : ${stats.warnALaLecture}`)
  console.log('   (avec le provider en defaut, ces lignes sont lues correctement et sans warn)')

  console.log('\n--- VENTILATION PAR PROVIDER DU BIEN ---')
  for (const [prov, c] of Object.entries(stats.parProvider)) {
    console.log(`${prov.padEnd(20)} lignes=${c.lignes}  provider_null=${c.providerNull}  statut_hors_vocab=${c.statusHorsVocabulaire}  a_corriger=${c.aCorriger}`)
  }

  console.log('\n--- STATUTS BRUTS RENCONTRES ---')
  Object.entries(stats.statutsBrutsRencontres)
    .sort((a, b) => b[1] - a[1])
    .forEach(([s, n]) => {
      const canonique = ALL_STATUSES.includes(s.toLowerCase())
      console.log(`${s.padEnd(14)} ${String(n).padStart(6)}  ${canonique ? 'canonique' : '<- a normaliser'}`)
    })

  if (APPLY) console.log(`\n--- ECRITURE --- corrigees=${stats.corrigees} echecs=${stats.echecs}`)
  else console.log('\nAucune ecriture effectuee. Relancer avec --apply pour corriger.')
}

main().catch(e => { console.error(e.message); process.exit(1) })
