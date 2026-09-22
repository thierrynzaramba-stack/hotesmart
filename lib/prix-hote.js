// lib/prix-hote.js — LE PRIX DE L'HOTE SUR UN BIEN PILOTE (lot 4.6.4 bis).
// SEUL WRITER AUTORISE de la table `prix_hote`.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, arbitrage A bis (22 sept. 2026).
// Migration : migrations/2026-09-22-prix-hote.sql
// DOC : docs/kb/coeur-de-donnees.md (modif = MEME COMMIT)
//
// CE QUE C'EST. Sur un bien pilote par YieldFlow, l'hote fixe lui-meme le prix
// d'une nuit depuis « Prix jour par jour ». Ce prix devient le prix retenu
// (ecrit par le writer du calendrier, journalise source 'host'), et LE MOTEUR
// NE L'ECRASE PAS : il saute ces nuits, a l'ouverture comme a l'entretien.
//
// ⚠ CE N'EST PAS UNE SECONDE MEMOIRE DU PRIX. Le prix affiche vit dans
// `calendar_inventory`, ecrit par le writer unique. Cette table dit QUELLES
// nuits portent la main de l'hote, et a quel prix il l'a posee — pour que
// l'ecran montre « votre prix » a cote de ce que YieldFlow proposait.
//
// JUSQU'A QUAND. Un prix de l'hote tient jusqu'a ce que la nuit soit passee
// (purge quotidienne) ou que l'hote le retire (« revenir au prix YieldFlow »).
// Il n'expire jamais seul : une main posee est une decision, pas un essai.
//
// ⚠ TABLE ABSENTE = AUCUN PRIX DE L'HOTE, comme pour les fermetures : une base
// deployee avant la migration ne bloque rien. Une vraie panne de lecture LEVE :
// un vide par erreur ferait ecraser un prix de l'hote par le moteur.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
const estJour = v => JOUR_RE.test(String(v || '')) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

const TABLE_ABSENTE_RE = /PGRST205|42P01|schema cache|does not exist/i
function tableAbsente (error) {
  return !!error && (error.code === 'PGRST205' || error.code === '42P01' ||
    (TABLE_ABSENTE_RE.test(error.message || '') && /prix_hote/.test(error.message || '')))
}
let absenceDite = false

// Les nuits de [debut, fin] dont l'hote a fixe le prix : Map date -> centimes.
async function prixHoteDuBien (supabase, propertyId, debut, fin) {
  if (!supabase || !UUID_RE.test(String(propertyId || ''))) throw new Error('[prix_hote] supabase et propertyId (uuid) requis')
  if (!estJour(debut) || !estJour(fin) || fin < debut) throw new Error('[prix_hote] periode invalide')
  const { data, error } = await supabase.from('prix_hote')
    .select('stay_date, rate_cents').eq('property_id', propertyId).gte('stay_date', debut).lte('stay_date', fin)
  if (tableAbsente(error)) {
    if (!absenceDite) { absenceDite = true; console.warn('[prix_hote] table absente : la migration 2026-09-22-prix-hote.sql n est pas appliquee — aucun prix de l hote') }
    return new Map()
  }
  if (error) throw new Error(`[prix_hote] lecture : ${error.message}`)
  return new Map((data || []).map(l => [l.stay_date, Number(l.rate_cents)]))
}

// Poser (ou remplacer) le prix de l'hote sur des nuits. `nuits` :
// [{ date, cents }]. Rend { ok } ou { ok: false, raison, message }.
async function poserPrixHote (supabase, { userId, propertyId, nuits }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) {
    return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  }
  const lignes = []
  for (const n of nuits || []) {
    const cents = Math.round(Number(n && n.cents))
    if (!n || !estJour(n.date) || !Number.isInteger(cents) || cents <= 0) {
      return { ok: false, raison: 'nuit_invalide', message: `Nuit ou prix invalide : ${n && n.date} / ${n && n.cents}.` }
    }
    lignes.push({ user_id: userId, property_id: propertyId, stay_date: n.date, rate_cents: cents, updated_at: new Date().toISOString() })
  }
  if (!lignes.length) return { ok: true, posees: 0 }
  const { error } = await supabase.from('prix_hote').upsert(lignes, { onConflict: 'property_id,stay_date' })
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Enregistrement impossible : ${error.message}` }
  return { ok: true, posees: lignes.length }
}

// Retirer la main de l'hote sur des nuits : le moteur les reprendra au
// passage suivant. Le compte et le bien sont dans le WHERE.
async function retirerPrixHote (supabase, { userId, propertyId, dates }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) {
    return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  }
  const jours = [...new Set((dates || []).filter(estJour))]
  if (!jours.length) return { ok: false, raison: 'nuit_invalide', message: 'Aucune nuit valide.' }
  const { data, error } = await supabase.from('prix_hote').delete()
    .eq('user_id', userId).eq('property_id', propertyId).in('stay_date', jours).select('stay_date')
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Retrait impossible : ${error.message}` }
  return { ok: true, retirees: (data || []).map(l => l.stay_date) }
}

// Les nuits passees ne portent plus de main : purge, par le pilote quotidien.
async function purgerPrixHotePasses (supabase, propertyId, aujourdHui) {
  if (!UUID_RE.test(String(propertyId || '')) || !estJour(aujourdHui)) return { ok: false }
  const { error } = await supabase.from('prix_hote').delete().eq('property_id', propertyId).lt('stay_date', aujourdHui)
  if (error && !tableAbsente(error)) console.error('[prix_hote] purge', propertyId, error.message)
  return { ok: !error }
}

module.exports = { prixHoteDuBien, poserPrixHote, retirerPrixHote, purgerPrixHotePasses }
