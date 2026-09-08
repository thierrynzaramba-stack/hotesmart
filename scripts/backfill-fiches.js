// scripts/backfill-fiches.js
// Etape 1B du chantier « migration Channex » : rapatriement des FICHES DE BIEN.
//
// HORS CRON. Idempotent, rejouable. Ecrit EXCLUSIVEMENT par le writer unique
// (lib/property-snapshot.js) : aucun acces direct a la table.
//
// USAGE
//   node scripts/backfill-fiches.js [--execute]
//     par defaut : DRY RUN (aucune ecriture), --execute pour ecrire
//
// ⚠ N'IMPRIME JAMAIS LE PAYLOAD. Il porte des emails, des telephones, des
// reglages de passerelle de paiement et des identifiants de webhook. On
// affiche des comptes de champs, jamais du contenu.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')
const { savePropertySnapshot } = require('../lib/property-snapshot')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

// Compte les feuilles du payload : la mesure qui dit « la fiche est complete »
// sans rien reveler de son contenu.
function champs (o, p = '', n = 0) {
  if (o === null || typeof o !== 'object') return n + 1
  if (Array.isArray(o)) return o.length ? champs(o[0], p, n + 1) : n + 1
  for (const k of Object.keys(o)) n = champs(o[k], p, n)
  return n
}

async function main () {
  log(EXECUTE ? 'MODE ECRITURE' : 'DRY RUN — aucune ecriture, --execute pour ecrire')

  const { data: biens, error } = await supabase
    .from('properties')
    .select('id, name, user_id, provider, provider_property_id')
    .order('name')
  if (error) throw new Error(`properties : ${error.message}`)

  // La cle Beds24 vit sur le compte, pas sur le bien.
  // ⚠ `error` EST LU. Sans ca, une lecture en echec donne un tableau de cles
  // vide, donc un token `undefined` sur chaque bien Beds24, donc « le provider
  // n'a rien rendu » — le diagnostic accuserait le provider pour une panne
  // Supabase. postgrest-js ne throw pas : c'est a nous de regarder.
  const cles = {}
  const { data: k, error: eCles } = await supabase.from('api_keys').select('user_id, api_key')
  if (eCles) throw new Error(`api_keys : ${eCles.message}`)
  ;(k || []).forEach(r => { cles[r.user_id] = r.api_key })

  let ok = 0, changes = 0, echecs = 0
  for (const b of biens) {
    // ⚠ `getProvider` THROW sur un provider inconnu, il ne rend pas `undefined`.
    // Et `properties.provider` peut etre null en base — trois endroits du depot
    // ecrivent deja `getProvider(p.provider || 'channex')` par prudence. Une
    // seule ligne dans cet etat ferait sortir le script au milieu du parc, sans
    // bilan : un bien qu'on ne sait pas lire se saute, il n'arrete pas les autres.
    let provider = null
    try { provider = getProvider(b.provider) }
    catch (e) { log(`  ${b.name} — provider « ${b.provider} » inconnu : ${e.message}`); echecs++; continue }
    if (!provider?.getPropertyRaw) {
      log(`  ${b.name} — provider ${b.provider} sans getPropertyRaw, ignore`)
      continue
    }

    let raw = null
    try {
      raw = await provider.getPropertyRaw({
        propertyId: b.provider_property_id,
        credentials: { token: cles[b.user_id] }
      })
    } catch (e) {
      log(`  ${b.name} — fetch echec : ${e.message}`)
      echecs++
      continue
    }

    if (!raw) { log(`  ${b.name} — le provider n'a rien rendu`); echecs++; continue }

    const n = champs(raw)
    if (!EXECUTE) { log(`  ${b.name.padEnd(26)} ${String(b.provider).padEnd(8)} ${n} champs — DRY RUN`); ok++; continue }

    const res = await savePropertySnapshot(supabase, {
      userId: b.user_id, provider: b.provider, propertyId: b.provider_property_id, raw
    })
    if (!res.ok) { log(`  ${b.name} — ECRITURE ECHOUEE : ${res.raison}`); echecs++; continue }
    log(`  ${b.name.padEnd(26)} ${String(b.provider).padEnd(8)} ${n} champs — ${res.change ? 'ECRITE' : 'inchangee'}`)
    ok++
    if (res.change) changes++
  }

  log(`BILAN : ${ok} fiches lues, ${changes} ecrites, ${echecs} echecs`)
  if (echecs) process.exitCode = 1
}

main().catch(e => { console.error('echec :', e.message); process.exit(1) })
