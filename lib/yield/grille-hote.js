// lib/yield/grille-hote.js — LA GRILLE FIXEE PAR L'HOTE, NIVEAU PAR NIVEAU
// (lot 4.6.7, decisions de Thierry du 30 septembre 2026).
// SEUL WRITER AUTORISE des tables `grille_hote` et `grille_hote_journal`.
// Migration : migrations/2026-09-30-grille-hote.sql
//
// CE QUE C'EST. Sur la page « Prédiction de prix », l'hote remplace le montant
// CALCULE d'un niveau (Base … Exceptionnel) par le sien. Le montant fixe tient
// jusqu'a ce qu'il le remette « au calcul » (decision 1).
//
// ⚠ CE N'EST PAS `prix_hote`. `prix_hote` fige une NUIT : le moteur la saute,
// sans plancher ni prime. Un niveau fixe ne fige AUCUNE nuit : il remplace un
// montant de la grille, et TOUS les ajustements (jour de semaine, evenements,
// plancher N-1, primes, fourchette) s'appliquent PAR-DESSUS (decision 3).
//
// ⚠ UN SEUL POINT D'APPLICATION : `preparerContexte` (lib/yield/contexte-du-
// bien.js), juste apres le calcul de la grille — l'ecran et le moteur passent
// par la, la parite ecran / moteur tient (dette 17).
// ⚠ APRES LE POSITIONNEMENT, JAMAIS AVANT. La grille positionne chaque contexte
// sur un niveau a partir des medianes MESUREES (`construireGrille`) ; elle en
// garde le NOM et l'indice. Remplacer les montants apres coup ne deplace aucun
// contexte : « Moyen fixe a 120 € » fait couter 120 € aux nuits Moyen, il ne
// fait pas glisser les vacances vers un autre niveau.
//
// ⚠ TABLE ABSENTE = AUCUN NIVEAU FIXE (comme prix_hote) : une base deployee
// avant la migration ne bloque rien. Une vraie panne de lecture LEVE : un vide
// par erreur remettrait la grille calculee sans un mot.

const { NIVEAUX } = require('./suggestion')

const NOMS = NIVEAUX.map(n => n.nom)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CENTIMES_MAX = 10000000   // 100 000 € — garde-fou de saisie
const TABLE_ABSENTE_RE = /PGRST205|42P01|schema cache|does not exist/i
const tableAbsente = error => !!error && (error.code === 'PGRST205' || error.code === '42P01' ||
  (TABLE_ABSENTE_RE.test(error.message || '') && /grille_hote/.test(error.message || '')))
let absenceDite = false

/** Les niveaux fixes d'un bien : Map nom -> { rate_cents, recommended_rate_cents, updated_at }. */
async function grilleHoteDuBien (supabase, propertyId) {
  if (!supabase || !UUID_RE.test(String(propertyId || ''))) throw new Error('[grille_hote] supabase et propertyId (uuid) requis')
  const { data, error } = await supabase.from('grille_hote')
    .select('niveau, rate_cents, recommended_rate_cents, updated_at').eq('property_id', propertyId)
  if (tableAbsente(error)) {
    if (!absenceDite) { absenceDite = true; console.warn('[grille_hote] table absente : la migration 2026-09-30-grille-hote.sql n est pas appliquee — aucun niveau fixe') }
    return new Map()
  }
  if (error) throw new Error(`[grille_hote] lecture : ${error.message}`)
  return new Map((data || []).filter(l => NOMS.includes(l.niveau)).map(l => [l.niveau, {
    rate_cents: Number(l.rate_cents), recommended_rate_cents: l.recommended_rate_cents == null ? null : Number(l.recommended_rate_cents), updated_at: l.updated_at }]))
}

/**
 * PUR. La grille avec les montants fixes par l'hote. Ne modifie pas l'entree.
 * Chaque niveau fixe porte `fixe_par_hote: true` et `prix_calcule` (le montant
 * que le calcul donnait) ; les autres portent `prix_calcule` = `prix`.
 * Le plafond de la fourchette Exceptionnel n'existe que s'il depasse le niveau :
 * un Exceptionnel fixe au-dessus le fait disparaitre (c'est le prix de l'hote
 * qui fait foi).
 */
function appliquerGrilleHote (grille, fixes) {
  if (!grille || !grille.base || !Array.isArray(grille.base.niveaux) || !fixes || !fixes.size) return grille
  const niveaux = grille.base.niveaux.map(n => {
    const f = fixes.get(n.nom)
    if (!f) return { ...n, prix_calcule: n.prix }
    return { ...n, prix_calcule: n.prix, prix: f.rate_cents / 100, fixe_par_hote: true, etire: false, confondu_avec: undefined }
  })
  const dernier = niveaux[niveaux.length - 1].prix
  const plafond = grille.base.plafond != null && grille.base.plafond > dernier ? grille.base.plafond : null
  return { ...grille, base: { ...grille.base, niveaux, plafond } }
}

/**
 * PUR. La grille qui RESULTERAIT d'un geste (niveaux fixes et calcules meles)
 * tient-elle les bornes (decision 2) ? Strictement croissante, et aucun niveau
 * sous le prix minimum du bien.
 * @param niveaux   [{ nom, prix }] — en euros, dans l'ordre Base → Exceptionnel
 * @param prixMinimumCents  properties.prix_minimum (centimes) ou null
 * @returns { ok } | { ok: false, code, message }
 */
function validerGrille (niveaux, prixMinimumCents) {
  for (let i = 0; i < niveaux.length; i++) {
    const p = niveaux[i].prix
    if (!Number.isFinite(p) || p <= 0) return { ok: false, code: 'niveau_invalide', message: `${niveaux[i].nom} : montant invalide.` }
    if (prixMinimumCents != null && Math.round(p * 100) < Number(prixMinimumCents)) {
      return { ok: false, code: 'sous_prix_minimum', message: `${niveaux[i].nom} (${p} €) serait sous le prix minimum du logement (${Number(prixMinimumCents) / 100} €).` }
    }
    if (i > 0 && !(p > niveaux[i - 1].prix)) {
      return { ok: false, code: 'ordre', message: `${niveaux[i].nom} (${p} €) doit être au-dessus de ${niveaux[i - 1].nom} (${niveaux[i - 1].prix} €).` }
    }
  }
  return { ok: true }
}

async function tracer (supabase, l) {
  const { error } = await supabase.from('grille_hote_journal').insert(l)
  if (error) console.error(`[grille_hote] TRACE PERDUE (${l.evenement} ${l.niveau}, bien ${l.property_id}) : ${error.message}`)
  return !error
}

/**
 * Fixer (ou remplacer) le montant d'un niveau.
 * @returns { ok, avant } | { ok: false, raison, message }
 */
async function fixerNiveau (supabase, { userId, propertyId, niveau, cents, recommandeCents = null }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  if (!NOMS.includes(niveau)) return { ok: false, raison: 'niveau_inconnu', message: 'Niveau inconnu.' }
  const c = Math.round(Number(cents))
  if (!Number.isInteger(c) || c <= 0 || c > CENTIMES_MAX) return { ok: false, raison: 'montant_invalide', message: 'Montant invalide.' }
  const r = recommandeCents == null ? null : Math.round(Number(recommandeCents))
  const { data: exist, error: eLu } = await supabase.from('grille_hote').select('rate_cents')
    .eq('user_id', userId).eq('property_id', propertyId).eq('niveau', niveau).maybeSingle()
  if (eLu) return { ok: false, raison: 'ecriture_impossible', message: `Enregistrement impossible : ${eLu.message}` }
  const { error } = await supabase.from('grille_hote').upsert({
    user_id: userId, property_id: propertyId, niveau, rate_cents: c,
    recommended_rate_cents: Number.isInteger(r) && r > 0 ? r : null, updated_at: new Date().toISOString()
  }, { onConflict: 'property_id,niveau' })
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Enregistrement impossible : ${error.message}` }
  await tracer(supabase, { user_id: userId, property_id: propertyId, niveau, evenement: exist ? 'remplacee' : 'posee',
    rate_cents: c, rate_cents_avant: exist ? Number(exist.rate_cents) : null, recommended_rate_cents: Number.isInteger(r) && r > 0 ? r : null })
  return { ok: true, avant: exist ? Number(exist.rate_cents) : null }
}

/** Remettre un niveau « au calcul » (decision 1) : la ligne est retiree. */
async function remettreAuCalcul (supabase, { userId, propertyId, niveau }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  if (!NOMS.includes(niveau)) return { ok: false, raison: 'niveau_inconnu', message: 'Niveau inconnu.' }
  const { data, error } = await supabase.from('grille_hote').delete()
    .eq('user_id', userId).eq('property_id', propertyId).eq('niveau', niveau).select('rate_cents')
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Retrait impossible : ${error.message}` }
  const avant = (data || [])[0]
  if (avant) await tracer(supabase, { user_id: userId, property_id: propertyId, niveau, evenement: 'retiree', rate_cents: null, rate_cents_avant: Number(avant.rate_cents), recommended_rate_cents: null })
  return { ok: true, retire: !!avant }
}

module.exports = { NOMS, grilleHoteDuBien, appliquerGrilleHote, validerGrille, fixerNiveau, remettreAuCalcul }
