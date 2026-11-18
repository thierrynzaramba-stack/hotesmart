// lib/guestflow/reponse-prete.js — « Information manquante », étape 2 (C) :
// après l'envoi d'une réponse de l'hôte, l'IA propose d'ENREGISTRER une
// nouvelle réponse prête, ou de METTRE À JOUR une réponse prête existante,
// pour que l'assistant sache répondre seul la prochaine fois
// (spec docs/specs/spec-info-manquante-choix.md §2 C).
//
// Ce module ne fait QUE des règles pures : quelles questions, quel texte part
// au modèle, quelles propositions on accepte de ce qui en revient. L'appel,
// les gardes et les lectures vivent dans api/guestflow-rediger.js (action
// `base`).
//
// ⚠ RIEN N'EST ÉCRIT ICI, NI PAR L'ACTION `base`. Une proposition n'est qu'une
// proposition : seul le geste « Enregistrer » de l'hôte écrit, et il passe par
// le writer UNIQUE de la base (`api/ecran/connaissance.js`), avec ses gardes.

const R = require('./rediger')

// Les bornes du writer de la base (api/ecran/connaissance.js) : une
// proposition qui les dépasse serait refusée au geste, autant ne pas l'offrir.
const MAX_SUJET = 200
const MAX_TEXTE = 4000
// La base d'un logement lue pour le rapprochement : bien moins que cela en
// pratique. Au-delà, on ne propose rien plutôt que de rapprocher sur une base
// TRONQUÉE — une « nouvelle » réponse prête doublerait alors une existante.
const MAX_REPONSES_LUES = 300
// Une réponse existante plus longue n'est PAS montrée au modèle (review 1,
// constat 3) : on ne peut pas lui demander de rendre « le texte complet » d'une
// réponse qu'il n'a vue qu'en partie — « Enregistrer » en effacerait la fin.
// Son sujet est réservé, comme celui d'une réponse « Hors IA ».
const MAX_TEXTE_EXISTANT = 1500
// Ce qui remplace le prénom et le nom du voyageur dans ce qui part au modèle.
const VOYAGEUR = '[voyageur]'

/**
 * Les questions d'une tâche « information manquante » pour la proposition.
 * Mêmes règles que la carte (`questionsDe`) — pas d'intervention, pas de tâche
 * système, pas de sous-tâche de secours — mais la tâche peut être CLOSE :
 * l'envoi depuis la carte vient de la passer à `done`, et c'est justement
 * après cet envoi que la proposition se calcule.
 */
function questionsPourLaBase (tache) {
  if (!tache || !['pending', 'done'].includes(tache.status)) return []
  // `questionsDe` n'accepte que `pending` : on lui présente la tâche telle
  // qu'elle était au moment de la carte. Ses autres règles s'appliquent toutes.
  return R.questionsDe({ ...tache, status: 'pending' })
}

// Une lettre, accents compris : « e » vaut « é », « è », « ê », « ë »…
const ACCENTS = { a: 'aàáâäãå', c: 'cç', e: 'eéèêë', i: 'iíìîï', n: 'nñ', o: 'oóòôöõ', u: 'uúùûü', y: 'yýÿ' }
const lettreSansAccent = (l) => {
  const base = l.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return ACCENTS[base] ? `[${ACCENTS[base]}]` : base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// Les mots d'un nom (« Jean-Pierre Le Gall » → Jean, Pierre, Le, Gall) : deux
// lettres au moins — un nom de deux lettres (« Li ») reste un nom.
const motsDuNom = (noms) => [...new Set((noms || [])
  .flatMap(n => String(n || '').split(/[^\p{L}]+/u))
  .filter(m => m.length >= 2))]

/**
 * Le texte sans le prénom ni le nom du voyageur (review 1, constat 1) : la
 * décision est que le modèle de l'étape 2 ne les reçoit pas, et le texte
 * envoyé commence presque toujours par « Bonjour {prénom} ». Mot entier,
 * sans accent ni casse ; chaque partie d'un nom composé.
 */
function anonymiser (texte, noms) {
  let t = String(texte || '')
  for (const mot of motsDuNom(noms)) {
    const motif = [...mot].map(lettreSansAccent).join('')
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${motif}(?![\\p{L}\\p{N}])`, 'giu'), VOYAGEUR)
  }
  return t
}

// Ce qui ressemble à un code, un mot de passe, un lien ou un numéro (review 1,
// constat 2) : un lien, une adresse e-mail, quatre chiffres de suite ou plus
// qui ne sont pas un montant, un numéro de téléphone. Une réponse prête est
// lue par l'IA pour TOUS les voyageurs : un code n'y a pas sa place (il vit
// dans les faits du logement, avec ses balises).
function elementsSensibles (texte) {
  const t = String(texte || '')
  const vus = new Set()
  for (const m of t.matchAll(/\b(?:https?:\/\/|www\.)\S+/gi)) vus.add(m[0].toLowerCase())
  for (const m of t.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) vus.add(m[0].toLowerCase())
  for (const m of t.matchAll(/(?:\+?\d[\s.-]?){8,}/g)) vus.add(m[0].replace(/\D/g, ''))
  for (const m of t.matchAll(/\d{4,}(?!\s?(?:€|eur|euros?\b))/gi)) vus.add(m[0])
  return vus
}

function validerEnvoye (envoye) {
  const e = typeof envoye === 'string' ? envoye.trim() : ''
  if (!e) return { ok: false, erreur: 'envoye_vide' }
  if (e.length > R.MAX_TEXTE) return { ok: false, erreur: 'envoye_trop_long' }
  return { ok: true, envoye: e }
}

/**
 * Le texte envoyé au modèle.
 * ⚠ NI LA CONVERSATION, NI LE NOM DU VOYAGEUR : une réponse prête est faite
 * pour TOUS les voyageurs. Le modèle reçoit les questions, le message que
 * l'hôte vient d'envoyer, et les réponses prêtes du logement (numérotées : il
 * désigne une réponse existante par son NUMÉRO, jamais par un identifiant de
 * la base — un identifiant inventé ne doit pas pouvoir viser une autre ligne).
 */
function promptReponsesPretes ({ questions, envoye, existantes, bienNom }) {
  const qs = questions.map((q, i) => `${i + 1}. « ${q} »`).join('\n')
  // Les réponses montrées ont TOUTES moins de MAX_TEXTE_EXISTANT caractères
  // (les autres sont réservées en amont) : rien n'est coupé ici.
  const ex = existantes.length
    ? existantes.map((r, i) => `[${i + 1}] Sujet : ${r.sujet}\n    Texte : ${String(r.texte || '')}`).join('\n')
    : '(aucune)'
  return `Tu aides l'hôte d'une location de vacances (logement : ${bienNom || 'le logement'}) à tenir sa base de « réponses prêtes » : des réponses GÉNÉRIQUES, valables pour tous les voyageurs, que l'assistant lit pour répondre seul la prochaine fois.

QUESTIONS QU'UN VOYAGEUR VIENT DE POSER :
${qs}

MESSAGE QUE L'HÔTE VIENT DE LUI ENVOYER (c'est la seule source des décisions) :
${envoye}

RÉPONSES PRÊTES DÉJÀ ENREGISTRÉES POUR CE LOGEMENT :
${ex}

CE QUE TU FAIS :
- Pour chaque question à laquelle le message de l'hôte apporte une réponse claire (oui, non, ou une précision), propose UNE réponse prête.
- Si une réponse prête existante traite déjà ce sujet : action « modifier », avec son numéro dans « ref » et, dans « texte », son texte COMPLET mis à jour — garde ce qui y reste vrai et intègre la décision de l'hôte.
- Sinon : action « creer », avec un « sujet » court (2 à 5 mots, comme « Animaux » ou « Stationnement moto ») et un « texte ».
- Deux questions sur le même sujet donnent UNE seule proposition.
- Si le message ne tranche pas une question, ou si la réponse ne vaut que pour ce séjour (une date, une heure d'arrivée, un cas particulier), ne propose rien pour elle.

RÈGLES DU TEXTE :
- Générique : aucun prénom, aucun nom, aucune date, aucun nombre de personnes, rien de propre à ce voyageur ou à ce séjour.
- N'ajoute AUCUNE information — code, mot de passe, horaire, adresse, prix, numéro, lien, promesse — qui ne soit ni dans le message de l'hôte, ni dans la réponse prête que tu modifies.
- Ne recopie JAMAIS un code d'accès, un digicode, un mot de passe, un lien ou un numéro de téléphone, même s'il est dans le message de l'hôte : ces informations vivent dans la fiche du logement, pas dans une réponse prête. Garde telles quelles les balises entre accolades, comme {code_wifi}.
- « [voyageur] » remplace le nom du voyageur : ne l'écris jamais dans une réponse prête.
- Écris en français, même si le message de l'hôte est dans une autre langue, comme une consigne que l'assistant transmettra au voyageur.

RÉPONDS UNIQUEMENT avec un objet JSON, sans texte autour :
{"propositions":[{"question":1,"action":"creer","sujet":"…","texte":"…"},{"question":2,"action":"modifier","ref":3,"texte":"…"}]}
Aucune proposition : {"propositions":[]}`
}

// Le premier objet JSON de la réponse du modèle ; null si rien de lisible.
function jsonDe (response) {
  const blocs = Array.isArray(response?.content) ? response.content : []
  const t = blocs.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  const debut = t.indexOf('{')
  const fin = t.lastIndexOf('}')
  if (debut < 0 || fin <= debut) return null
  try { return JSON.parse(t.slice(debut, fin + 1)) } catch (_) { return null }
}

const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Les propositions acceptées, depuis la réponse du modèle.
 * `existantes` : [{ id, sujet, texte }] — la base LUE, dans l'ordre montré au
 * modèle. `noms` : le prénom et le nom du voyageur, qu'aucune réponse prête ne
 * doit porter. `sujetsReserves` : les sujets que le modèle n'a PAS vus — les
 * réponses « Hors IA » (l'hôte les a cachées à l'IA) et les réponses trop
 * longues pour être montrées entières — : on ne crée rien sous leur sujet, le
 * writer refuserait (sujet unique), et la proposition ne peut pas devenir leur
 * modification sans montrer leur texte.
 * Rend [{ action: 'creer', sujet, texte }
 *     | { action: 'modifier', id, sujet, avant, texte }].
 *
 * ⚠ TOUT CE QUI VIENT DU MODÈLE EST VÉRIFIÉ, RIEN N'EST CRU :
 *  - « ref » désigne une réponse MONTRÉE, par son numéro : l'identifiant et le
 *    texte « avant » viennent de la base, jamais du modèle ;
 *  - le sujet d'une modification reste celui de la base : le modèle ne renomme
 *    pas une réponse que l'hôte a nommée ;
 *  - une « création » dont le sujet existe déjà devient une MODIFICATION de
 *    cette réponse (le writer refuserait la création : sujet unique) ;
 *  - une proposition qui nomme le voyageur est écartée : la règle « générique »
 *    du prompt est une consigne, ceci en est le contrôle (chaque partie d'un
 *    nom composé ; pour une modification, un mot DÉJÀ dans le texte d'avant ne
 *    compte pas — « rue Victor Hugo » n'est pas le voyageur Hugo) ;
 *  - une proposition qui porte un code, un lien ou un numéro absent du texte
 *    d'avant est écartée (review 1, constat 2) ;
 *  - une modification qui ne change rien est écartée ;
 *  - une seule proposition par réponse visée, et par sujet créé.
 */
function propositionsDe (brut, { existantes = [], noms = [], sujetsReserves = [], maxPropositions = R.MAX_QUESTIONS } = {}) {
  const liste = brut && Array.isArray(brut.propositions) ? brut.propositions : []
  const nomsSurs = motsDuNom(noms).map(normal).filter(n => n.length >= 3)
  const contient = (s, n) => new RegExp(`(^|[^a-z0-9])${echapper(n)}([^a-z0-9]|$)`).test(normal(s))
  const nommeLeVoyageur = (s, avant = '') => nomsSurs.some(n => contient(s, n) && !contient(avant, n)) || normal(s).includes(normal(VOYAGEUR))
  const sensible = (texte, avant = '') => { const a = elementsSensibles(avant); return [...elementsSensibles(texte)].some(x => !a.has(x)) }
  const parSujet = new Map(existantes.map(r => [normal(r.sujet), r]))
  const reserves = new Set((sujetsReserves || []).map(normal))
  const vues = new Set()
  const sortie = []
  for (const p of liste) {
    if (sortie.length >= maxPropositions) break
    if (!p || typeof p !== 'object') continue
    const texte = typeof p.texte === 'string' ? p.texte.trim() : ''
    if (!texte || texte.length > MAX_TEXTE) continue
    let cible = null
    if (p.action === 'modifier') {
      const n = Number(p.ref)
      if (!Number.isInteger(n) || n < 1 || n > existantes.length) continue
      cible = existantes[n - 1]
    } else if (p.action === 'creer') {
      const sujet = typeof p.sujet === 'string' ? p.sujet.trim() : ''
      if (!sujet || sujet.length > MAX_SUJET) continue
      cible = parSujet.get(normal(sujet)) || null
      if (!cible) {
        const cle = `creer:${normal(sujet)}`
        if (vues.has(cle) || reserves.has(normal(sujet)) || nommeLeVoyageur(sujet) || nommeLeVoyageur(texte) || sensible(sujet) || sensible(texte)) continue
        vues.add(cle)
        sortie.push({ action: 'creer', sujet, texte })
        continue
      }
    } else continue
    // Une MODIFICATION (demandée, ou une création sur un sujet existant).
    const cle = `modifier:${cible.id}`
    if (vues.has(cle) || nommeLeVoyageur(texte, cible.texte) || sensible(texte, cible.texte)) continue
    if (normal(texte) === normal(cible.texte)) continue
    vues.add(cle)
    sortie.push({ action: 'modifier', id: cible.id, sujet: cible.sujet, avant: cible.texte, texte })
  }
  return sortie
}

module.exports = {
  questionsPourLaBase, validerEnvoye, promptReponsesPretes, jsonDe, propositionsDe, anonymiser, elementsSensibles,
  MAX_SUJET, MAX_TEXTE, MAX_REPONSES_LUES, MAX_TEXTE_EXISTANT, VOYAGEUR
}
