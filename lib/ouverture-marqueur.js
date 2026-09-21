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

// Le marqueur porte, dans `errors` (jsonb), le BILAN du dernier passage et la
// FENETRE avec laquelle il a tourne : { fenetre, ouvertes, comptes }.
async function lireMarqueur (supabase, propertyId) {
  const { data } = await supabase.from('cron_logs').select('last_run, errors').eq('id', PREFIXE_MARQUEUR + propertyId).maybeSingle()
  if (!data || !data.last_run) return null
  const bilan = Array.isArray(data.errors) && data.errors.length ? data.errors[0] : null
  return { derniere: data.last_run, bilan }
}

// ⚠ « A TOURNE AUJOURD'HUI » = le meme jour a Paris ET la meme fenetre — releve
// en review. Effacer le marqueur a l'activation ne suffisait pas : un tick deja
// en train d'ouvrir ce bien reposait le marqueur apres l'effacement, et une
// fenetre elargie attendait le lendemain. Comparer la fenetre memorisee rend
// le changement de fenetre visible quel que soit l'ordre des ecritures.
async function aTourneAujourdhui (supabase, propertyId, aujourdHui, fenetre) {
  const m = await lireMarqueur(supabase, propertyId)
  if (!m || jourParis(new Date(m.derniere)) !== aujourdHui) return false
  if (fenetre && m.bilan && m.bilan.fenetre) {
    return m.bilan.fenetre.type === fenetre.type && m.bilan.fenetre.valeur === fenetre.valeur
  }
  return true
}

// Pose APRES le travail : un passage en echec se retente au tick suivant.
async function poserMarqueur (supabase, propertyId, maintenantMs, bilan = null) {
  const { error } = await supabase.from('cron_logs').upsert({
    id: PREFIXE_MARQUEUR + propertyId, last_run: new Date(maintenantMs).toISOString(),
    total_messages: 0, total_replies: 0, errors: bilan ? [bilan] : []
  })
  if (error) console.error('[ouverture] marqueur non pose', propertyId, error.message)
  return { error }
}

async function effacerMarqueur (supabase, propertyId) {
  return supabase.from('cron_logs').delete().eq('id', PREFIXE_MARQUEUR + propertyId)
}

module.exports = { PREFIXE_MARQUEUR, jourParis, lireMarqueur, aTourneAujourdhui, poserMarqueur, effacerMarqueur }
