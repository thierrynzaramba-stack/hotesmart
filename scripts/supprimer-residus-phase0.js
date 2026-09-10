// scripts/supprimer-residus-phase0.js
// Supprime les proprietes Channex creees par la phase 0 et devenues des
// FANTOMES apres le changement de plan.
//
// ⚠ POURQUOI ELLES SONT DANGEREUSES, ET CE QUE CA A COUTE.
// La phase 0 avait cree une propriete Channex CIBLE par bien, pour un re-keying
// qui n'a pas eu lieu : Thierry a retenu le plan « fiche neuve ». Ces
// proprietes portent le nom D'ORIGINE du bien — « Cœur de vie « La bulle » » —
// alors que la vraie porte le nom saisi a la creation, « La bulle ».
//
// Le 10 septembre 2026 a minuit, Thierry a ouvert « Cœur de vie « La bulle » »
// dans Channex, l'a vue NON MAPPEE, et a cru que le canal Booking recree
// venait de disparaitre a nouveau. Le fantome porte meme ses trois rate plans,
// ce qui le rend credible. Une frayeur, et une demi-heure de verification.
//
// ⚠ ON NE SUPPRIME QU'APRES AVOIR PROUVE QUE RIEN N'Y RENVOIE.
// Le balayage des 54 tables du schema a trouve :
//   - `3197fbfc` (La bulle)  : 2 incidents historiques, aucune reference vive ;
//   - `038e195f` (le 23)     : `properties.migration_target_property_id` de
//     l'ANCIENNE fiche Beds24 du 23, qui ne l'a pas encore transferee.
//
// Cette colonne est PERIMEE — le plan a change, la cible du 23 est
// `1655ab32` via sa fiche neuve — mais tant qu'elle pointe le fantome,
// `proprieteChezLeProvider` (lib/rate-sync.js) rend le fantome, et une poussee
// pour cette fiche VISERAIT une propriete supprimee. On la vide donc d'abord.
// `transferer_bien` l'efface de toute facon a la fin du transfert : la vider
// maintenant n'enleve rien a demain.
//
// Les incidents sont RE-KEYES vers la bonne propriete, pas supprimes :
// l'historique d'incident appartient au logement.
//
// DRY RUN par defaut.
// USAGE : node scripts/supprimer-residus-phase0.js [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')
const dodo = (ms) => new Promise(r => setTimeout(r, ms))

async function appel (m, p, b, n = 4) {
  for (let i = 1; i <= n; i++) {
    try {
      const r = await fetch(`${BASE}${p}`, {
        method: m,
        headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
        ...(b ? { body: JSON.stringify(b) } : {})
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { j = null }
      return { ok: r.ok, status: r.status, json: j, texte: t.slice(0, 200) }
    } catch (e) {
      console.log(`      reseau KO (${i}/${n}) : ${e.cause?.code || e.message}`)
      if (i === n) throw e
      await dodo(3000 * i)
    }
  }
}

const RESIDUS = [
  { fantome: '3197fbfc-8418-4db5-8767-b8f942801226', nom: 'Cœur de vie « La bulle »',
    bonneCle: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4' },
  { fantome: '038e195f-9601-41c7-8508-bee2b7b753dd', nom: 'coeur de vie 23',
    bonneCle: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66' }
]

async function main () {
  console.log(ECRIRE ? 'MODE ECRITURE' : 'DRY RUN — rien ne sera supprime')

  for (const R of RESIDUS) {
    console.log(`\n══ ${R.nom}  (${R.fantome})`)

    // ⚠ REFUS 1 : un fantome qui porte un CANAL n'est pas un fantome.
    const ch = await appel('GET', '/channels?pagination[limit]=100')
    const canaux = ((ch.json && ch.json.data) || [])
      .filter(c => (c.attributes.properties || []).includes(R.fantome))
    if (canaux.length) {
      console.log(`   ⛔ ${canaux.length} canal/canaux accroche(s) — CE N'EST PAS UN FANTOME, on saute`)
      for (const c of canaux) console.log(`      ${c.attributes.channel} ${JSON.stringify(c.attributes.title)}`)
      continue
    }
    console.log('   ✓ aucun canal accroche')

    // ⚠ REFUS 2 : une reservation chez le provider sous cette propriete.
    const bk = await appel('GET', `/bookings?filter[property_id]=${R.fantome}&pagination[limit]=10`)
    const resas = ((bk.json && bk.json.data) || []).length
    if (resas) { console.log(`   ⛔ ${resas} reservation(s) chez le provider — on saute`); continue }
    console.log('   ✓ aucune reservation chez le provider')

    // ⚠ REFUS 3 : la colonne de migration doit etre libre. Sinon
    // `proprieteChezLeProvider` renverrait une propriete supprimee.
    const { data: pointe } = await supabase.from('properties')
      .select('id, name, provider, provider_property_id, rate_sync_mode')
      .eq('migration_target_property_id', R.fantome)
    if ((pointe || []).length) {
      console.log(`   ⚠ ${pointe.length} fiche(s) le declarent encore comme cible de migration :`)
      for (const p of pointe) console.log(`      ${p.name} (${p.provider}/${p.provider_property_id}, mode ${p.rate_sync_mode})`)
      if (!ECRIRE) console.log('      -> la colonne serait VIDEE avant la suppression')
      else {
        for (const p of pointe) {
          const { error } = await supabase.from('properties')
            .update({ migration_target_property_id: null, migration_target_at: null }).eq('id', p.id)
          console.log(`      ${error ? 'ECHEC ' + error.message : `cible de migration videe sur ${p.name}`}`)
        }
      }
    } else console.log('   ✓ aucune fiche ne le declare comme cible')

    // Les incidents : re-keyes, jamais supprimes.
    const { data: inc } = await supabase.from('automation_incidents')
      .select('id, type, created_at').eq('property_id', R.fantome)
    if ((inc || []).length) {
      console.log(`   ${inc.length} incident(s) historique(s) a re-keyer vers ${R.bonneCle} :`)
      for (const x of inc) console.log(`      #${x.id} ${x.type} du ${String(x.created_at).slice(0, 10)}`)
      if (ECRIRE) {
        const { error } = await supabase.from('automation_incidents')
          .update({ property_id: R.bonneCle }).eq('property_id', R.fantome)
        console.log(`      ${error ? 'ECHEC ' + error.message : 're-keyes'}`)
      }
    }

    if (!ECRIRE) { console.log('   -> serait SUPPRIMEE chez Channex'); continue }

    // Les rate plans du fantome partent avec la propriete (cascade Channex).
    const d = await appel('DELETE', `/properties/${R.fantome}`)
    console.log(`   DELETE /properties/${R.fantome} -> HTTP ${d.status}  ${d.ok ? '' : d.texte}`)
    await dodo(3000)
    const g = await appel('GET', `/properties/${R.fantome}`)
    console.log(`   ${g.status === 404 || !g.json?.data ? '✓ SUPPRIMEE' : '⚠ TOUJOURS LA (HTTP ' + g.status + ')'}`)
  }

  console.log('\n══ ETAT FINAL DES PROPRIETES CHEZ CHANNEX')
  const props = await appel('GET', '/properties?pagination[limit]=50')
  const ch2 = await appel('GET', '/channels?pagination[limit]=100')
  for (const p of ((props.json && props.json.data) || [])) {
    const n = ((ch2.json && ch2.json.data) || [])
      .filter(c => (c.attributes.properties || []).includes(p.id)).length
    console.log(`   ${p.id}  ${String(p.attributes.title).padEnd(28)} ${n} canal/canaux`)
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
