// scripts/verifier-migration-messages-origine.js — forme de la migration
// 2026-10-12-messages-origine : la colonne lisible PAR SON NOM, et la
// contrainte qui ferme la liste (un INSERT hors liste doit etre refuse —
// on le prouve sans rien ecrire de durable : insert volontairement
// invalide, dont on attend le REFUS).
// Usage : node --env-file=<.env> scripts/verifier-migration-messages-origine.js
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
async function main () {
  const { count } = await supabase.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Projet ${String(process.env.SUPABASE_URL).match(/\/\/([^.]+)/)[1]} · biens = ${count} (5 = production, 3 = staging)`)
  const { error: eL } = await supabase.from('messages').select('origine').limit(1)
  if (eL) { console.error('✗ colonne origine illisible :', eL.message); process.exit(1) }
  console.log('  ✔ messages.origine lisible par son nom')
  // La contrainte : un insert hors liste doit ECHOUER (rien n'est ecrit).
  const { error: eI } = await supabase.from('messages').insert({ origine: 'hors_liste_preuve' })
  if (!eI) { console.error('✗ un INSERT origine=hors_liste a ETE ACCEPTE — contrainte absente ; ligne parasite a supprimer !'); process.exit(1) }
  if (!/messages_origine_fermee|check constraint/i.test(eI.message) && !/violates/i.test(eI.message)) {
    // refus pour une AUTRE raison (not-null d'une autre colonne) : la
    // contrainte n'est pas prouvee, on le dit.
    console.log('  ⚠ insert refuse pour une autre raison (' + eI.message.slice(0, 80) + ') — contrainte non prouvee par ce chemin')
  } else {
    console.log('  ✔ la liste est fermee (insert hors liste refuse par la contrainte)')
  }
  console.log('Migration 2026-10-12-messages-origine : conforme sur ce que l API permet de prouver.')
}
main().catch(e => { console.error('✗', e.message); process.exit(1) })
