// scripts/verifier-parite-templates.js — PARITÉ CHAMP À CHAMP entre
// l'ancienne app templates (apps/agent-ai/messages.html) et le volet
// « Messages programmés » de /messages (recette 2, 12 octobre 2026).
//
// LECTURE SEULE. Usage :
//   node --env-file=/home/thierry/hotesmart/.env.local scripts/verifier-parite-templates.js
//
// Ce qui est prouvé, template RÉEL par template RÉEL :
//   1. le volet lit les MÊMES lignes (même table, mêmes colonnes) ;
//   2. chaque valeur en base est REPRÉSENTABLE par les listes du volet
//      (une valeur hors liste serait PERDUE à la première sauvegarde) ;
//   3. le moment affiché par le volet = celui de l'ancienne page
//      (formatTiming recalculé ici selon les DEUX formes) ;
//   4. la référence dérivée de l'événement est celle de l'ancienne page ;
//   5. une serrure posée existe bien dans property_locks du bien.
// Règle du dépôt (feedback-verificateur-faux-vert) : un script qui n'a RIEN
// lu échoue — zéro template comparé n'est pas une parité prouvée.

const { createClient } = require('@supabase/supabase-js')

async function main () {
  const { EVENEMENTS_PROGRAMMES, ecartsDeRepresentation, referenceDe, libelleJour, libelleHeure, libelleDelai } =
    await import('../shared/messages-programmes.js')
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  // L'affichage de l'ANCIENNE page : ses LABELS litteraux, en temoin (jamais
  // les fonctions du volet — un temoin qui traverse le writer ne detecte
  // rien, regle feedback-verificateur-faux-vert, releve en review).
  const LABELS_ANCIENS = {
    '0min': 'Immédiatement', '5min': '5 min après', '10min': '10 min après', '15min': '15 min après',
    '30min': '30 min après', '1h': '1h après', '2h': '2h après', '4h': '4h après', '8h': '8h après', '24h': '24h après'
  }
  function momentAncien (t) {
    const type = (t.event_type === 'booking_confirmed' || t.event_type === 'menage_done') ? 'after' : 'days'
    if (type === 'after') return t.offset_value ? (LABELS_ANCIENS[t.offset_value] || t.offset_value) : 'immédiatement'
    const jour = t.offset_days === 0 ? 'Jour J' : t.offset_days > 0 ? `J+${t.offset_days}` : `J${t.offset_days}`
    return `${jour} à ${String(t.send_time || '10:00').replace(':00', 'h')}`
  }
  // L'affichage du VOLET : ses propres fonctions, importees du module.
  const TEXTES_FR = { apres: 'après', immediatement: 'Immédiatement' }
  function momentNouveau (t) {
    const ev = EVENEMENTS_PROGRAMMES[t.event_type]
    if (!ev) return '(événement inconnu)'
    if (ev.type === 'apres') return t.offset_value ? libelleDelai(t.offset_value, TEXTES_FR) : 'immédiatement'
    return `${libelleJour(t.offset_days, 'Jour J')} à ${libelleHeure(t.send_time || '10:00')}`
  }
  const referenceAncienne = (e) => e === 'departure' ? 'departure' : e === 'booking_confirmed' ? 'booking' : 'arrival'

  const { data: biens, error: eB } = await supabase.from('properties')
    .select('id, name, user_id, provider_property_id')
    .not('provider_property_id', 'is', null)
  if (eB) { console.error('✗ properties illisible :', eB.message); process.exit(1) }

  let compares = 0
  const ecarts = []
  for (const bien of biens || []) {
    const ref = String(bien.provider_property_id)
    const [tpl, verrous] = await Promise.all([
      supabase.from('message_templates').select('*')
        .eq('user_id', bien.user_id).eq('property_id', ref).order('created_at'),
      supabase.from('property_locks').select('lock_id').eq('property_id', ref)
    ])
    if (tpl.error) { console.error(`✗ ${bien.name} : templates illisibles — ${tpl.error.message}`); process.exit(1) }
    const serrures = new Set((verrous.data || []).map(v => String(v.lock_id)))
    for (const x of tpl.data || []) {
      compares++
      const ou = `${bien.name} / ${x.event_type} (${String(x.id).slice(0, 8)})`
      for (const e of ecartsDeRepresentation(x)) ecarts.push(`${ou} : ${e}`)
      const ancien = momentAncien(x); const nouveau = momentNouveau(x)
      if (ancien !== nouveau) ecarts.push(`${ou} : moment « ${ancien} » (ancienne page) ≠ « ${nouveau} » (volet)`)
      if (EVENEMENTS_PROGRAMMES[x.event_type]
        && referenceDe(x.event_type) !== referenceAncienne(x.event_type)) {
        ecarts.push(`${ou} : reference divergente`)
      }
      if (x.lock_id && !serrures.has(String(x.lock_id))) {
        ecarts.push(`${ou} : lock_id ${x.lock_id} absent des serrures du bien`)
      }
      console.log(`  · ${bien.name} | ${x.event_type} | ${nouveau} | ${x.active ? 'actif' : 'inactif'}`
        + ` | send_anyway=${x.send_anyway === true} | serrure=${x.lock_id || '—'} | texte ${String(x.template_text || '').length} car.`)
    }
  }

  console.log(`\n${compares} message(s) programmé(s) comparé(s) sur ${(biens || []).length} bien(s).`)
  if (!compares) { console.error('✗ RIEN LU : zéro template — la parité n’est pas prouvée.'); process.exit(1) }
  if (ecarts.length) {
    console.error(`✗ ${ecarts.length} écart(s) :`)
    for (const e of ecarts) console.error('  - ' + e)
    process.exit(1)
  }
  console.log('✓ 0 écart : chaque template réel se réaffiche à l’identique dans le volet.')
}

main().catch(e => { console.error('✗', e.message); process.exit(1) })
