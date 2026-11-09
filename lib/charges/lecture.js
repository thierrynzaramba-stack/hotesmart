// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/lecture.js — LA LECTURE D'UNE FACTURE PAR L'IA
// Spec : docs/specs/spec-compte-de-charges.md §2, §6 (« La lecture »)
//
// Une demande à Haiku par document (image ou PDF), réponse JSON imposée,
// normalisée par `lib/charges/regles.js`. Trois issues, et elles ne se
// confondent jamais :
//   · { ok: true, lu, brut }   la lecture a eu lieu et a rendu quelque chose ;
//   · { echec: true, motif }   la lecture a eu lieu et n'a RIEN rendu
//                              d'exploitable — elle COMPTE pour `tentatives` ;
//   · { panne: true, motif }   le fournisseur d'IA n'a pas répondu (réseau,
//                              surcharge, crédit épuisé, clé) — elle NE COMPTE
//                              PAS : un quart d'heure de panne ne doit pas
//                              rendre toutes les factures « illisibles » (§7).
//
// ⚠ UN SEUL CLIENT ANTHROPIC DANS LE DÉPÔT, celui de `lib/cron-shared.js`, et
// l'appel est étiqueté par `avecContexteIA` (tests/ia-journal-garde.test.js).
// Le client est chargé à la demande : ce module se teste sans lui.
// ═══════════════════════════════════════════════════════════════════════════

const { avecContexteIA } = require('../ia/journal')
const { CATEGORIES, TYPES, normaliserLecture } = require('./regles')

const MODELE = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 900

const CONSIGNE = `Tu lis UNE facture reçue par un loueur de meublés de tourisme.
Réponds UNIQUEMENT par un objet JSON, sans texte autour, avec ces clés :
{
  "fournisseur_nom": texte ou null,
  "fournisseur_siret": texte ou null,
  "numero_facture": texte ou null,
  "date_facture": "AAAA-MM-JJ" ou null,
  "date_echeance": "AAAA-MM-JJ" ou null,
  "montant_ht": nombre en euros ou null,
  "montant_tva": nombre en euros ou null,
  "montant_ttc": nombre en euros ou null,
  "destinataire_nom": texte ou null,
  "destinataire_siret": texte ou null,
  "categorie": une clé de la liste ou null,
  "confiance": { "<clé>": nombre entre 0 et 1, ... }
}
Règles :
- N'INVENTE RIEN. Une valeur absente ou illisible vaut null.
- Une TVA écrite à 0 (par exemple « TVA non applicable, art. 293 B du CGI ») vaut 0, pas null.
- Les montants sont ceux du TOTAL de la facture, pas d'une ligne.
- Le destinataire est le client facturé (le loueur), pas le fournisseur.
- Catégories possibles : ${CATEGORIES.map(c => `${c.cle} (${c.libelle})`).join(', ')}.`

// ─── Les issues d'une erreur du SDK ─────────────────────────────────────────
function statutDe (e) {
  const n = Number(e && (e.status ?? e.statusCode ?? (e.response && e.response.status)))
  return Number.isFinite(n) ? n : null
}
const texteDe = e => String((e && (e.message || (e.error && e.error.message))) || '')

/**
 * ⚠ UNE PANNE N'EST PAS UN ÉCHEC DE LECTURE. Est une panne : pas de statut
 * (réseau), 401/403 (clé), 408/409/429, 5xx dont 529 (surcharge), et le
 * crédit épuisé — qui arrive en 400 avec un texte explicite (incident du
 * 8 septembre 2026). Le reste des 4xx dit que CE document ne passe pas.
 */
function estPanne (e) {
  const s = statutDe(e)
  if (s == null) return true
  if ([401, 402, 403, 408, 409, 429].includes(s) || s >= 500) return true
  if (/credit balance|billing|insufficient/i.test(texteDe(e))) return true
  return false
}

/** Le premier objet JSON d'un texte, ou `null`. */
function extraireJson (texte) {
  const t = String(texte || '')
  const debut = t.indexOf('{')
  const fin = t.lastIndexOf('}')
  if (debut < 0 || fin <= debut) return null
  try { return JSON.parse(t.slice(debut, fin + 1)) } catch { return null }
}

// Au moins un champ utile : un objet tout `null` est une lecture qui n'a rien
// vu, donc un ÉCHEC — pas une facture vide à faire valider.
const CHAMPS_UTILES = ['fournisseur_nom', 'numero_facture', 'date_facture',
  'montant_ht_cents', 'montant_tva_cents', 'montant_ttc_cents']

/**
 * Lit un document. `octets` : Buffer ; `type` : son type RÉEL (déjà vérifié).
 * `deps.client` : un client Anthropic (les tests passent un double).
 */
async function lireDocument ({ octets, type, compte }, deps = {}) {
  const bloc = TYPES[type] && TYPES[type].bloc
  if (!bloc || !octets || !octets.length) return { echec: true, motif: 'type_non_lisible' }
  const client = deps.client || require('../cron-shared').anthropic
  const source = { type: 'base64', media_type: type, data: Buffer.from(octets).toString('base64') }
  let reponse
  try {
    // ⚠ PAS DE `bookingId` : le journal le lit comme un SÉJOUR, et une charge
    // n'en est pas un.
    reponse = await avecContexteIA({ fonction: 'charges-lecture', userId: compte },
      () => client.messages.create({
        model: MODELE,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: bloc, source },
            { type: 'text', text: CONSIGNE }
          ]
        }]
      }))
  } catch (e) {
    if (estPanne(e)) return { panne: true, motif: `ia_${statutDe(e) ?? 'reseau'}` }
    return { echec: true, motif: `ia_refus_${statutDe(e)}` }
  }
  const texte = ((reponse && reponse.content) || []).filter(b => b && b.type === 'text').map(b => b.text).join('')
  const brut = extraireJson(texte)
  if (!brut) return { echec: true, motif: 'reponse_illisible' }
  const lu = normaliserLecture(brut)
  if (!CHAMPS_UTILES.some(k => lu[k] !== null)) return { echec: true, motif: 'rien_lu' }
  return { ok: true, lu, modele: (reponse && reponse.model) || MODELE }
}

module.exports = { lireDocument, estPanne, extraireJson, MODELE, CONSIGNE }
