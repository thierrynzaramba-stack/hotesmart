// lib/ouverture-marqueur.js — LE MARQUEUR QUOTIDIEN DU MOTEUR D'OUVERTURE.
// Lot 4.6.3. Partage par le moteur (lib/moteur-ouverture.js, qui le POSE) et
// par l'endpoint du pilote (api/yield-pilote.js, qui l'EFFACE a l'activation
// et a tout changement de fenetre).
//
// ⚠ POURQUOI UN MODULE A PART, SI PETIT. Le moteur importe le canal interne ;
// l'endpoint ne doit rien connaitre du canal (tests/canal-calendrier.test.js :
// aucun handler de l'hote ne le touche, meme par transitivite). Le marqueur
// est la seule chose que les deux se partagent : il vit donc seul.
//
// `cron_logs` sert de marqueur comme pour le poll des avis et la purge des
// tentatives : une ligne `ouverture:<bien>`, `last_run` = dernier passage.
// Le jour se compare A PARIS : le cron tourne en UTC, l'hote vit en France.

const PREFIXE_MARQUEUR = 'ouverture:'
const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)

async function aTourneAujourdhui (supabase, propertyId, aujourdHui) {
  const { data } = await supabase.from('cron_logs').select('last_run').eq('id', PREFIXE_MARQUEUR + propertyId).maybeSingle()
  return !!(data && data.last_run && jourParis(new Date(data.last_run)) === aujourdHui)
}

// Pose APRES le travail : un passage en echec se retente au tick suivant.
async function poserMarqueur (supabase, propertyId, maintenantMs) {
  const { error } = await supabase.from('cron_logs').upsert({
    id: PREFIXE_MARQUEUR + propertyId, last_run: new Date(maintenantMs).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  })
  if (error) console.error('[ouverture] marqueur non pose', propertyId, error.message)
  return { error }
}

async function effacerMarqueur (supabase, propertyId) {
  return supabase.from('cron_logs').delete().eq('id', PREFIXE_MARQUEUR + propertyId)
}

module.exports = { PREFIXE_MARQUEUR, jourParis, aTourneAujourdhui, poserMarqueur, effacerMarqueur }
