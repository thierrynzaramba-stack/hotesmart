// scripts/diagnostic-orphelines.js
// Diagnostic des lignes dont property_id ne correspond a aucun bien connu.
//
// Cause : apps/agent-ai/knowledge.html et analyze.html ecrivaient properties.id
// (UUID) au lieu de provider_property_id pour les biens channel. Corrige, mais
// les lignes deja ecrites restent orphelines : le cron ne les lit pas, et depuis
// le chantier des droits elles sont invisibles aux membres.
//
// Pour chaque valeur orpheline, ce script determine si elle correspond a un bien
// EXISTANT (-> rattachable) ou a un bien SUPPRIME (-> a purger).
//
// USAGE
//   node scripts/diagnostic-orphelines.js            # diagnostic (lecture seule)
//   node scripts/diagnostic-orphelines.js --apply    # rattache les rattachables
//
// --apply ne rattache QUE les lignes dont l'UUID correspond a un bien existant.
// Il ne SUPPRIME jamais rien : la purge des lignes de biens disparus est une
// decision separee.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const APPLY = process.argv.includes('--apply')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Lecture PAGINEE : PostgREST tronque a 1000 lignes par defaut. Un select('*')
// nu sur une table de plus de 1000 lignes n'inspecterait que la premiere page et
// pourrait conclure « aucune orpheline » a tort.
async function lireTout(supabase, table, colonnes) {
  const PAGE = 1000
  let out = [], from = 0
  for (;;) {
    const { data, error } = await supabase.from(table).select(colonnes).range(from, from + PAGE - 1)
    if (error) return { data: null, error }
    out = out.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return { data: out, error: null }
}

// ⚠ NE JAMAIS classer « bien supprime » une valeur qui n'est pas un UUID.
// Les biens Beds24 sont servis en live par l'API et ne sont materialises dans
// `properties` que par le cron : un propId numerique absent de la table peut
// parfaitement designer un bien VIVANT dont la materialisation n'a pas encore eu
// lieu. Purger sur cette base supprimerait des donnees actives.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TABLES = ['knowledge', 'messages', 'conversations', 'agent_tasks', 'sms_logs',
                'menage_events', 'menage_done', 'menage_comments', 'bookings_snapshot',
                'access_codes', 'property_status', 'message_templates', 'agent_prompting',
                'automation_incidents', 'property_locks', 'booking_change_events']

async function main() {
  const { data: props } = await supabase
    .from('properties').select('id, user_id, name, provider, provider_property_id')
  const parUuid = {}, refsConnues = new Set()
  ;(props || []).forEach(p => {
    parUuid[String(p.id)] = p
    if (p.provider_property_id != null) refsConnues.add(String(p.provider_property_id))
  })

  console.log(APPLY ? '=== MODE RATTACHEMENT (--apply) ===' : '=== DIAGNOSTIC (lecture seule) ===')
  console.log(`${Object.keys(parUuid).length} biens connus\n`)

  let totalRattachables = 0, totalDisparus = 0, rattachees = 0

  for (const t of TABLES) {
    const { data, error } = await lireTout(supabase, t, '*')
    if (error) { console.log(`${t.padEnd(24)} (illisible : ${error.message.slice(0, 40)})`); continue }

    const orphelines = {}
    ;(data || []).forEach(r => {
      const v = r.property_id == null ? null : String(r.property_id)
      if (v === null || refsConnues.has(v)) return          // null = global, ou cle connue
      orphelines[v] = orphelines[v] || { lignes: [], bien: parUuid[v] || null }
      orphelines[v].lignes.push(r)
    })

    const valeurs = Object.keys(orphelines)
    if (!valeurs.length) continue

    console.log(`── ${t}`)
    for (const v of valeurs) {
      const o = orphelines[v]
      if (o.bien) {
        totalRattachables += o.lignes.length
        const cible = o.bien.provider_property_id
        console.log(`   ${v}  ${String(o.lignes.length).padStart(3)} ligne(s)  ✅ BIEN EXISTANT « ${o.bien.name} » (${o.bien.provider}) -> ${cible}`)
        if (APPLY && cible) {
          const { error: e } = await supabase.from(t)
            .update({ property_id: String(cible) })
            .eq('property_id', v)
          if (e) console.log(`      ECHEC rattachement : ${e.message.slice(0, 60)}`)
          else { rattachees += o.lignes.length; console.log(`      rattachees : ${o.lignes.length}`) }
        }
      } else if (UUID_RE.test(v)) {
        totalDisparus += o.lignes.length
        const apercu = o.lignes.slice(0, 3).map(r => r.key || r.event_type || r.direction || r.status || '—')
        console.log(`   ${v}  ${String(o.lignes.length).padStart(3)} ligne(s)  ❌ BIEN SUPPRIME  (ex: ${apercu.join(', ')})`)
      } else {
        // Identifiant non-UUID inconnu de `properties` : probablement un bien
        // Beds24 vivant non encore materialise. NE PAS conclure a la suppression.
        console.log(`   ${v}  ${String(o.lignes.length).padStart(3)} ligne(s)  ⚠ A VERIFIER (propId non materialise ?)`)
      }
    }
    console.log()
  }

  console.log('─'.repeat(72))
  console.log(`rattachables (bien existant) : ${totalRattachables}`)
  console.log(`biens disparus (a purger)    : ${totalDisparus}`)
  if (APPLY) console.log(`RATTACHEES                   : ${rattachees}`)
  else if (totalRattachables) console.log('\nRelancer avec --apply pour rattacher. La purge des biens disparus reste manuelle.')
}
main().catch(e => { console.error(e.message); process.exit(1) })
