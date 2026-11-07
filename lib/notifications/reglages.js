// lib/notifications/reglages.js — LE SEUL MODULE QUI ÉCRIT dans `notifications_reglages`.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §6 et §15.1 · KB : docs/kb/pwa.md §9
//
// Une ligne = UNE PERSONNE (un utilisateur), pas un couple compte-membre : ses
// heures calmes et sa langue sont les siennes, les mêmes pour tous les comptes
// dont elle est membre. C'est aussi pourquoi la langue vit ici et pas sur
// `profiles`, qui porte une ligne par compte.
//
// ⚠ UNE PERSONNE SANS LIGNE A LES DÉFAUTS (décision Q23) : notification et
// e-mail cochés, SMS décoché, urgent pour a, b, h, j, aucune plage, français. La
// ligne ne s'écrit qu'au premier « Enregistrer ». Un événement ajouté plus tard
// au catalogue prend ses défauts chez tout le monde, sans migration : la ligne ne
// range que les événements que la personne a enregistrés.
//
// ⚠ TOUT SE VALIDE À L'ÉCRITURE, et un refus n'écrit rien : un code inconnu, un
// canal inconnu, une valeur qui n'est pas un booléen, une plage fautive. Le
// navigateur ne lit ni n'écrit cette table (RLS sans politique).
const catalogue = require('./catalogue')
const { validerPlages } = require('./plages')
const LANGUES = require('../../shared/i18n/langues.json').map(l => l.code)

const CLES_REGLAGE = [...catalogue.CANAUX, 'urgent']

function client () {
  return require('../cron-shared').supabase
}

// Les réglages d'une personne tels qu'ils s'appliquent : sa ligne par-dessus les
// défauts, événement par événement et canal par canal.
function effectifs (ligne) {
  const ranges = (ligne && ligne.evenements && typeof ligne.evenements === 'object') ? ligne.evenements : {}
  const evenements = {}
  for (const e of catalogue.EVENEMENTS) {
    const defaut = catalogue.reglageParDefaut(e.code)
    const brut = ranges[e.code] && typeof ranges[e.code] === 'object' ? ranges[e.code] : {}
    const r = {}
    for (const k of CLES_REGLAGE) r[k] = typeof brut[k] === 'boolean' ? brut[k] : defaut[k]
    evenements[e.code] = r
  }
  const plages = Array.isArray(ligne && ligne.plages) ? ligne.plages : []
  const langue = ligne && LANGUES.includes(ligne.langue) ? ligne.langue : null
  return { evenements, plages, langue, maj_le: (ligne && ligne.maj_le) || null }
}

// Le tableau envoyé par l'écran. Rend { ok, evenements } | { ok: false, motif, code? }.
function validerEvenements (brut) {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return { ok: false, motif: 'evenements_illisibles' }
  const evenements = {}
  for (const [code, valeur] of Object.entries(brut)) {
    if (!catalogue.evenement(code)) return { ok: false, motif: 'evenement_inconnu', code }
    if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return { ok: false, motif: 'reglage_illisible', code }
    const cles = Object.keys(valeur)
    if (cles.some(k => !CLES_REGLAGE.includes(k))) return { ok: false, motif: 'canal_inconnu', code }
    if (!CLES_REGLAGE.every(k => typeof valeur[k] === 'boolean')) return { ok: false, motif: 'valeur_illisible', code }
    evenements[code] = Object.fromEntries(CLES_REGLAGE.map(k => [k, valeur[k]]))
  }
  return { ok: true, evenements }
}

async function lire ({ userId, db = client() }) {
  const { data, error } = await db.from('notifications_reglages')
    .select('evenements, plages, langue, maj_le')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { ok: false, motif: 'lecture_impossible' }
  return { ok: true, reglages: effectifs(data) }
}

// Enregistrer le tableau ET les plages (le bouton « Enregistrer » de l'écran).
// La langue n'est pas touchée : l'upsert ne met à jour que les colonnes envoyées.
async function enregistrer ({ userId, evenements, plages, db = client() }) {
  const ev = validerEvenements(evenements)
  if (!ev.ok) return ev
  const pl = validerPlages(plages)
  if (!pl.ok) return pl
  const ligne = { user_id: userId, evenements: ev.evenements, plages: pl.plages, maj_le: new Date().toISOString() }
  const { error } = await db.from('notifications_reglages').upsert(ligne, { onConflict: 'user_id' })
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true, reglages: effectifs(ligne) }
}

// La langue choisie au menu ≡. Le tableau et les plages ne sont pas touchés.
async function enregistrerLangue ({ userId, langue, db = client() }) {
  if (!LANGUES.includes(langue)) return { ok: false, motif: 'langue_inconnue' }
  const { error } = await db.from('notifications_reglages')
    .upsert({ user_id: userId, langue, maj_le: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true, langue }
}

module.exports = {
  LANGUES,
  effectifs,
  validerEvenements,
  lire,
  enregistrer,
  enregistrerLangue
}
