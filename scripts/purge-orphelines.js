// scripts/purge-orphelines.js
// Purge les lignes rattachees a un bien SUPPRIME (property_id ne correspondant
// a aucun provider_property_id ni properties.id connu).
//
// Origine : apps/agent-ai/knowledge.html et analyze.html ecrivaient properties.id
// (UUID) au lieu de provider_property_id. Corrige (REVIEW.md §10) ; ces lignes
// sont les residus, sur des biens depuis longtemps supprimes.
//
// USAGE
//   node scripts/purge-orphelines.js            # COMPTAGE A BLANC, aucune ecriture
//   node scripts/purge-orphelines.js --apply    # supprime
//
// ⚠ NE SUPPRIME QUE les lignes dont l'UUID ne correspond a AUCUN bien, meme
// supprime en cascade. Une valeur rattachable a un bien existant est laissee
// intacte et signalee : c'est un cas de rattachement, pas de purge
// (cf. scripts/diagnostic-orphelines.js).

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
  const { data: props } = await supabase.from('properties').select('id, provider_property_id, name')
  const connus = new Set()
  ;(props || []).forEach(p => {
    connus.add(String(p.id))
    if (p.provider_property_id != null) connus.add(String(p.provider_property_id))
  })

  console.log(APPLY ? '=== PURGE (--apply) ===' : '=== COMPTAGE A BLANC (aucune ecriture) ===')
  console.log(`${(props || []).length} biens connus\n`)

  let total = 0, supprimees = 0
  for (const t of TABLES) {
    const { data, error } = await lireTout(supabase, t, 'id, property_id')
    if (error) continue

    const aPurger = {}, aVerifier = {}
    ;(data || []).forEach(r => {
      const v = r.property_id == null ? null : String(r.property_id)
      if (v === null || connus.has(v)) return
      // Seules les valeurs au format UUID sont purgeables : un propId numerique
      // inconnu de `properties` peut designer un bien Beds24 vivant, pas encore
      // materialise par le cron.
      if (UUID_RE.test(v)) (aPurger[v] = aPurger[v] || []).push(r.id)
      else (aVerifier[v] = aVerifier[v] || []).push(r.id)
    })

    for (const [v, ids] of Object.entries(aVerifier)) {
      console.log(`${t.padEnd(22)} ${v}  ${String(ids.length).padStart(3)} ligne(s)  ⚠ NON PURGEABLE (identifiant non-UUID : bien Beds24 peut-etre non materialise)`)
    }

    for (const [v, ids] of Object.entries(aPurger)) {
      total += ids.length
      console.log(`${t.padEnd(22)} ${v}  ${String(ids.length).padStart(3)} ligne(s)`)
      if (APPLY) {
        const { error: e } = await supabase.from(t).delete().eq('property_id', v)
        if (e) console.log(`   ECHEC : ${e.message.slice(0, 60)}`)
        else { supprimees += ids.length; console.log(`   supprimees : ${ids.length}`) }
      }
    }
  }

  console.log('\n' + '─'.repeat(60))
  console.log(`lignes rattachees a un bien inconnu : ${total}`)
  if (APPLY) console.log(`SUPPRIMEES : ${supprimees}`)
  else if (total) console.log('Relancer avec --apply pour supprimer.')
  else console.log('Rien a purger.')
}
main().catch(e => { console.error(e.message); process.exit(1) })
