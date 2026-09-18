// scripts/config-lola-mardi-colomiers.js
// Reglage demande par Thierry le 18 septembre 2026 : confier Colomiers a Lola
// le MARDI, pour que le fait derriere l'alerte `menage_non_assigne` disparaisse.
//
// USAGE
//   node scripts/config-lola-mardi-colomiers.js [--execute]
//
// ⚠ C'EST UN REGLAGE, PAS UN CORRECTIF. L'ecran qui permettrait ce geste est
// l'etape 3.5 du chantier prestataires, non livree : d'ici la il se pose en
// base. Le noter ici evite qu'on cherche un jour « qui a modifie cette liaison
// a la main, et pourquoi ».
//
// ⚠ CONVENTION DES JOURS : 0 = dimanche … 6 = samedi (`getUTCDay`), celle de
// `lib/cleaning/garde.js`. Mardi = 2. Se tromper d'un cran donnerait le lundi.
//
// ⚠ `weekdays = []` NE VEUT PAS DIRE « RIEN REGLE ». C'est le geste « je ne lui
// confie ce bien aucun jour » : Lola paraissait rattachee a Colomiers et ne
// l'etait pour personne.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')

const COLOMIERS = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
const LOLA = '07b51d2b-44e7-4921-a262-10dcc88f973f'
const MARDI = 2

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

async function main () {
  log(EXECUTE ? 'MODE ECRITURE' : 'DRY RUN')
  console.log('')

  const { data: l, error } = await supabase
    .from('property_cleaning_providers')
    // ⚠ `rang`, PAS `rank` : `rank` est une fonction de fenetrage Postgres, et
    // PostgREST rend « WITHIN GROUP is required for ordered-set aggregate rank »
    // — un message qui ne parle pas du tout d'une colonne inconnue.
    .select('id, property_id, provider_id, weekdays, active, rang')
    .eq('property_id', COLOMIERS).eq('provider_id', LOLA).maybeSingle()
  if (error) throw new Error(`lecture liaison : ${error.message}`)
  if (!l) throw new Error('aucune liaison Lola <-> Colomiers : a creer depuis l\'ecran prestataires')

  console.log(`liaison ${l.id}`)
  console.log(`  actif=${l.active} rang=${l.rang} weekdays=${JSON.stringify(l.weekdays)}`)

  // ⚠ ON N'ECRASE PAS UN REGLAGE EXISTANT. Si l'hote a deja confie des jours a
  // Lola sur ce bien, on AJOUTE le mardi — retirer ses autres jours pour
  // satisfaire une demande qui ne parlait que du mardi serait un geste qu'il
  // n'a pas demande.
  const actuels = Array.isArray(l.weekdays) ? l.weekdays : []
  if (actuels.includes(MARDI)) { log('\nle mardi est deja confie — rien a faire'); return }
  const nouveaux = [...new Set([...actuels, MARDI])].sort((a, b) => a - b)

  console.log(`\n  ${JSON.stringify(actuels)}  ->  ${JSON.stringify(nouveaux)}`)
  if (l.active !== true) log('  ⚠ la liaison est INACTIVE : le mardi ne suffira pas.')

  // Est-elle disponible le mardi ? Le reglage serait vain sinon.
  const { data: regles } = await supabase
    .from('provider_availability_rules')
    .select('rrule, active').eq('provider_id', LOLA).eq('active', true)
  const mardiDispo = (regles || []).some(r => /BYDAY=[^\n]*TU/.test(String(r.rrule || '')))
  console.log(`  disponible le mardi (RRULE active) : ${mardiDispo ? 'OUI' : '⚠ NON — le reglage serait vain'}`)

  if (!EXECUTE) { console.log(''); log('DRY RUN termine. --execute pour ecrire.'); return }

  const { error: e2 } = await supabase.from('property_cleaning_providers')
    .update({ weekdays: nouveaux }).eq('id', l.id)
  if (e2) throw new Error(`ecriture : ${e2.message}`)

  const { data: apres, error: e3 } = await supabase
    .from('property_cleaning_providers').select('weekdays').eq('id', l.id).maybeSingle()
  if (e3) { log(`⚠ controle impossible : ${e3.message}`); process.exitCode = 1; return }
  console.log('')
  log(`ecrit. weekdays = ${JSON.stringify(apres.weekdays)}`)
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
