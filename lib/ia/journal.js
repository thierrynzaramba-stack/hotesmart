// lib/ia/journal.js
//
// LE JOURNAL UNIQUE DES APPELS IA (spec docs/specs/spec-journal-ia.md, validee
// par Thierry le 9 octobre 2026, apres l'incident du 8 : une boucle GuestFlow a
// epuise le credit Anthropic sans que rien ne dise combien d'appels partaient,
// ni pour quoi).
//
// Une ligne par appel a l'API dans `ia_appels` : fonction, compte, bien,
// sejour, modele servi, tokens, cout estime, duree, succes ou echec. JAMAIS le
// texte envoye ni la reponse — de la mesure, pas du contenu.
//
// ⚠ AUCUN APPEL N'Y ECHAPPE : l'ecriture est faite par l'enveloppe du client
// partage (`lib/cron-shared.js`), pas par les appelants. Un appelant ne fait
// que DECRIRE son appel (`avecContexteIA`) ; s'il l'oublie, l'appel est quand
// meme journalise, sous la fonction `inconnue` — visible, donc reparable.
// tests/ia-journal-garde.test.js refuse tout client Anthropic hors du partage.
//
// ⚠ LE JOURNAL NE CASSE JAMAIS L'APPEL : une ecriture en echec se dit en
// console et l'appel rend sa reponse (ou son erreur) intacte. L'ecriture est
// ATTENDUE, pas lancee en arriere-plan : Vercel gele la fonction apres la
// reponse, une promesse pendante serait perdue.

const { AsyncLocalStorage } = require('node:async_hooks')

const TABLE = 'ia_appels'
// Une ecriture lente (PostgREST degrade) ne fait pas pendre l'appel : au-dela,
// on rend la reponse et on le dit (revue de 3a9c75d).
const ECRITURE_MAX_MS = 2000
// Le masquage des cles de lib/incident-facturation.js (sk-…, xkeysib-…), tronque
// a 300 caracteres : un secret ne passe jamais par le journal.
const { extrait } = require('../incident-facturation')

// ─── Tarifs ─────────────────────────────────────────────────────────────────
// USD par MILLION de tokens, tarifs Anthropic premiere partie releves le
// 9 octobre 2026. Ecriture du cache = 1,25 x l'entree (cache 5 min).
// Le prefixe suffit : `response.model` porte parfois une date
// (claude-haiku-4-5-20251001).
// ⚠ Un modele ABSENT d'ici n'a pas de cout (null), jamais 0 : la page le dit,
// et l'alerte en nombre d'appels le couvre.
const TARIFS = [
  { prefixe: 'claude-haiku-4-5', entree: 1, sortie: 5, lectureCache: 0.10, ecritureCache: 1.25 },
  { prefixe: 'claude-sonnet-5-5', entree: 2, sortie: 10, lectureCache: 0.20, ecritureCache: 2.50 },
]

function tarifDe (modele) {
  const m = String(modele || '')
  return TARIFS.find(t => m.startsWith(t.prefixe)) || null
}

const entier = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0)

/** Cout en USD d'un appel, ou null si le modele n'est pas tarife. */
function coutUsd (modele, usage) {
  const t = tarifDe(modele)
  if (!t || !usage) return null
  const c = (entier(usage.input_tokens) * t.entree
    + entier(usage.output_tokens) * t.sortie
    + entier(usage.cache_read_input_tokens) * t.lectureCache
    + entier(usage.cache_creation_input_tokens) * t.ecritureCache) / 1e6
  return Math.round(c * 1e6) / 1e6
}

// ─── Contexte de l'appel ────────────────────────────────────────────────────
// Porte par AsyncLocalStorage : la signature de `messages.create` ne change
// pas, et le contexte suit l'appel a travers les `await`. Les contextes
// s'EMBOITENT : l'appelant pose le compte et le bien, la fonction feuille pose
// son etiquette ; une valeur absente (null/undefined) n'efface pas celle du
// parent.
const stockage = new AsyncLocalStorage()

function avecContexteIA (contexte, fn) {
  const fusion = { ...(stockage.getStore() || {}) }
  for (const [k, v] of Object.entries(contexte || {})) if (v !== undefined && v !== null && v !== '') fusion[k] = v
  return stockage.run(fusion, fn)
}

const contexteIA = () => stockage.getStore() || {}

// ─── La ligne ───────────────────────────────────────────────────────────────
/** Pure : la ligne de `ia_appels` pour un appel termine. */
function ligneDAppel ({ contexte = {}, demande = {}, reponse = null, erreur = null, dureeMs = null }) {
  const usage = (reponse && reponse.usage) || null
  const modele = (reponse && reponse.model) || (demande && demande.model) || null
  const str = v => (v === undefined || v === null || v === '' ? null : String(v))
  return {
    fonction: str(contexte.fonction) || 'inconnue',
    user_id: str(contexte.userId),
    property_id: str(contexte.propertyId),
    booking_id: str(contexte.bookingId),
    modele,
    input_tokens: usage ? entier(usage.input_tokens) : null,
    output_tokens: usage ? entier(usage.output_tokens) : null,
    cache_read_tokens: usage ? entier(usage.cache_read_input_tokens) : null,
    cache_write_tokens: usage ? entier(usage.cache_creation_input_tokens) : null,
    cout_usd: usage ? coutUsd(modele, usage) : null,
    duree_ms: Number.isFinite(dureeMs) ? Math.round(dureeMs) : null,
    stop_reason: (reponse && reponse.stop_reason) || null,
    ok: !erreur,
    erreur: erreur ? extrait(erreur.message || erreur) : null,
  }
}

const tableAbsente = (e) => /ia_appels/.test(String(e && e.message)) && /(does not exist|schema cache)/i.test(String(e && e.message))
let absenceDite = false

/** Ecrit une ligne. Fail-safe : ne leve jamais, et n'attend pas plus de `delaiMs`. */
async function noterAppelIA (sb, ligne, { delaiMs = ECRITURE_MAX_MS } = {}) {
  let minuteur
  try {
    const enRetard = new Promise(resolve => { minuteur = setTimeout(() => resolve({ enRetard: true }), delaiMs) })
    const r = await Promise.race([sb.from(TABLE).insert(ligne), enRetard])
    if (r && r.enRetard) { console.error(`[ia-journal] ecriture en retard (> ${delaiMs} ms) : l appel continue sans l attendre`); return }
    const { error } = r || {}
    if (!error) return
    if (tableAbsente(error)) {
      // Migration en retard : dit une fois par instance, jamais a chaque appel.
      if (!absenceDite) { absenceDite = true; console.error('[ia-journal] table ia_appels absente : migration 2026-10-09-ia-appels non appliquee') }
      return
    }
    console.error('[ia-journal] appel non journalise :', error.message)
  } catch (e) { console.error('[ia-journal] appel non journalise :', e.message) } finally { clearTimeout(minuteur) }
}

// ─── L'enveloppe ────────────────────────────────────────────────────────────
// Enveloppe `messages.create` d'un client Anthropic : mesure, journalise, et
// laisse `surErreur` observer l'echec (alerte de facturation). L'erreur est
// RELANCEE telle quelle — cette enveloppe observe, elle n'avale rien.
function envelopper (client, { sb, surErreur = null, horloge = Date.now } = {}) {
  return new Proxy(client, {
    get (cible, prop) {
      if (prop !== 'messages') return Reflect.get(cible, prop)
      const messages = Reflect.get(cible, prop)
      return new Proxy(messages, {
        get (m, nom) {
          const valeur = Reflect.get(m, nom)
          if (nom !== 'create' || typeof valeur !== 'function') return valeur
          return async function (...args) {
            const contexte = contexteIA()
            const debut = horloge()
            let reponse
            try {
              reponse = await valeur.apply(m, args)
            } catch (e) {
              await noterAppelIA(sb, ligneDAppel({ contexte, demande: args[0], erreur: e, dureeMs: horloge() - debut }))
              if (typeof surErreur === 'function') {
                try { await surErreur(e) } catch (x) { console.error('[ia-journal] surErreur :', x.message) }
              }
              throw e
            }
            await noterAppelIA(sb, ligneDAppel({ contexte, demande: args[0], reponse, dureeMs: horloge() - debut }))
            return reponse
          }
        }
      })
    }
  })
}

module.exports = { avecContexteIA, contexteIA, ligneDAppel, noterAppelIA, envelopper, coutUsd, tarifDe, TARIFS, TABLE }
