// scripts/supprimer-resa-figee.js
// Supprime du COEUR une reservation figee d'un bien migre.
//
// ⚠ NE TOUCHE RIEN CHEZ LE PROVIDER. La reservation reste chez Beds24 : ce
// script ne parle qu'a Supabase.
//
// POURQUOI CE CAS EXISTE. Un bien migre reste dans le compte Beds24 (filet de
// rollback), mais sa cle est enregistree comme migree : le cron ne le
// synchronise plus. Une reservation creee MANUELLEMENT dans Beds24 apres la
// migration est donc FIGEE dans le coeur — plus rien ne la met a jour, ni ne la
// supprime si elle est annulee cote provider. Elle continue pourtant a occuper
// le calendrier et a fermer des nuits chez le canal.
//
// ⚠ CE QUE LA SUPPRESSION IMPLIQUE, ET QU'IL FAUT AVOIR VERIFIE :
// les nuits qu'elle occupait redeviennent vendables. Si un VRAI voyageur vient,
// c'est une surreservation. Le script affiche donc tout ce qui permet de
// trancher — nom, contact, montant, statut brut — et exige --go.
//
// USAGE : node scripts/supprimer-resa-figee.js --booking=<id> [--go]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BOOKING = (process.argv.find(a => a.startsWith('--booking=')) || '').split('=')[1] || null
const GO = process.argv.includes('--go')

function nuits (arrivee, depart) {
  const out = []
  const f = new Date(`${depart}T00:00:00Z`)
  for (const d = new Date(`${arrivee}T00:00:00Z`); d < f; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
    if (out.length > 400) break
  }
  return out
}

async function main () {
  if (!BOOKING) throw new Error('--booking=<id> requis')

  const { data: r, error } = await supabase
    .from('bookings_snapshot').select('*').eq('booking_id', BOOKING).maybeSingle()
  if (error) throw new Error(`lecture : ${error.message}`)
  if (!r) { console.log('Reservation absente du coeur — rien a faire.'); return }

  const s = r.snapshot || {}
  const raw = r.raw || {}
  const { data: bien } = await supabase
    .from('properties').select('id, name, provider')
    .eq('provider_property_id', r.property_id).maybeSingle()

  console.log(`Bien       : ${bien ? bien.name : '(inconnu)'} [${bien ? bien.provider : '?'}]`)
  console.log(`Sejour     : ${s.arrival} → ${s.departure}  (${nuits(s.arrival, s.departure).length} nuits)`)
  console.log(`Voyageur   : ${(s.firstName || '') + ' ' + (s.lastName || '')}`.trimEnd())
  console.log(`Canal      : ${s.source}   provider : ${s.provider}   statut : ${s.status} (brut : ${s.statusRaw})`)
  console.log(`Contact    : tel ${raw.phone || '(aucun)'} — email ${raw.email || '(aucun)'}`)
  console.log(`Montant    : ${s.amount != null ? s.amount + ' ' + (s.currency || '') : '(aucun)'}`)
  console.log(`Derniere maj du coeur : ${String(r.updated_at).slice(0, 16)}`)

  // ⚠ LE SIGNAL QUI COMPTE : est-ce un vrai client, ou un blocage personnel ?
  const indices = []
  if (!raw.phone || String(raw.phone) === '0') indices.push('aucun telephone')
  if (!raw.email) indices.push('aucun email')
  if (s.amount == null) indices.push('aucun montant')
  if (String(s.source).toLowerCase() === 'direct') indices.push('canal direct')
  console.log(`\nIndices « blocage personnel » : ${indices.length ? indices.join(', ') : 'AUCUN — cela ressemble a un VRAI client'}`)
  if (indices.length < 3) {
    console.log('⚠ PEU D INDICES : verifier chez le provider avant de supprimer.')
  }

  const occupees = nuits(s.arrival, s.departure)
  console.log(`\nNuits qui redeviendront vendables : ${occupees.join(', ')}`)

  if (!GO) { console.log('\nDRY-RUN — aucune ecriture. Relancer avec --go.'); return }

  // Sauvegarde AVANT suppression, dans la meme table que les transferts.
  const { error: bkErr } = await supabase.from('rekeying_backup').insert({
    bien_id: bien ? bien.id : '00000000-0000-4000-8000-000000000000',
    source: String(r.property_id),
    cible: '(suppression d une resa figee, aucune cible)',
    nom_table: 'bookings_snapshot (resa figee supprimee)',
    lignes: [r]
  })
  if (bkErr) throw new Error(`sauvegarde impossible, on NE supprime pas : ${bkErr.message}`)
  console.log('\nSauvegarde ecrite dans rekeying_backup')

  const { error: delErr } = await supabase
    .from('bookings_snapshot').delete().eq('booking_id', BOOKING).eq('user_id', r.user_id)
  if (delErr) throw new Error(`suppression : ${delErr.message}`)

  const { data: reste } = await supabase
    .from('bookings_snapshot').select('booking_id').eq('booking_id', BOOKING).maybeSingle()
  console.log(reste ? 'ECHEC : la ligne est toujours la' : 'Reservation supprimee du coeur')
  console.log('\n⚠ ELLE RESTE CHEZ BEDS24 : la supprimer aussi la-bas si elle n a plus lieu d etre.')
  console.log('⚠ Les nuits ne se rouvriront chez le canal qu a la prochaine poussee')
  console.log('  de disponibilite (publication du bien, ou ouverture explicite des dates).')
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1) })
