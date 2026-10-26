// scripts/verifier-migration-messages-origine.js — forme de la migration
// 2026-10-12-messages-origine : la colonne lisible PAR SON NOM, et la
// contrainte qui ferme la liste (un INSERT hors liste doit etre refuse —
// on le prouve sans rien ecrire de durable : insert volontairement
// invalide, dont on attend le REFUS).
// Usage : node --env-file=<.env> scripts/verifier-migration-messages-origine.js
const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
async function main () {
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  const { count } = await supabase.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Base ${base} · biens = ${count}`)
  // ⚠ CE SCRIPT INSERE UNE LIGNE FACTICE pour prouver que la contrainte la
  // refuse, et il n'avait AUCUNE garde de base (constat de la review du
  // 26 octobre 2026) : sur une base non reconnue, il aurait sonde en silence.
  if (base === 'INCONNUE') {
    console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging. Aucune sonde.`)
    process.exit(1)
  }
  const { error: eL } = await supabase.from('messages').select('origine').limit(1)
  if (eL) { console.error('✗ colonne origine illisible :', eL.message); process.exit(1) }
  console.log('  ✔ messages.origine lisible par son nom')
  // La contrainte, PROUVEE : un insert COMPLET (les NOT NULL servis par des
  // valeurs factices) dont la seule faute est l'origine hors liste. Sans ces
  // valeurs, le NOT NULL de user_id refusait TOUJOURS et le script disait
  // « fermee » sur une base sans contrainte — le faux vert exact de la regle
  // feedback-verificateur-faux-vert (releve en review de 658d758).
  const factice = {
    user_id: '00000000-0000-0000-0000-000000000000',
    provider: 'channex', property_id: 'verif-origine-preuve',
    direction: 'outbound', sender: 'host', body: '',
    origine: 'hors_liste_preuve'
  }
  const { data: inseree, error: eI } = await supabase.from('messages').insert(factice).select('id')
  if (!eI) {
    // Accepte = contrainte ABSENTE. On efface la ligne de preuve et on echoue.
    if (inseree && inseree[0]) await supabase.from('messages').delete().eq('id', inseree[0].id)
    console.error('✗ un INSERT origine=hors_liste a ETE ACCEPTE — contrainte absente (ligne de preuve supprimee)')
    process.exit(1)
  }
  if (/messages_origine_fermee/i.test(eI.message)) {
    console.log('  ✔ la liste est fermee (insert hors liste refuse PAR LA CONTRAINTE)')
  } else {
    console.error('✗ insert refuse pour une AUTRE raison (' + eI.message.slice(0, 120) + ') — la contrainte n\'est PAS prouvee')
    process.exit(1)
  }
  console.log('Migration 2026-10-12-messages-origine : conforme sur ce que l API permet de prouver.')
}
main().catch(e => { console.error('✗', e.message); process.exit(1) })
