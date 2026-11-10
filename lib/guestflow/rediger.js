// lib/guestflow/rediger.js — « Information manquante » : l'hôte répond par
// Oui / Non / Autre, ou tape une réponse brute, et l'IA rédige la réponse au
// voyageur (spec docs/specs/spec-info-manquante-choix.md, étape 1).
//
// Ce module ne fait QUE des règles pures : quelles tâches portent des
// questions, quels choix sont valides, quel texte part au modèle, quel texte en
// revient. L'appel, les gardes et les lectures vivent dans
// api/guestflow-rediger.js.
//
// ⚠ RIEN N'EST ENVOYÉ AU VOYAGEUR ICI. Le texte rédigé arrive dans la zone de
// saisie de l'hôte, qui le relit, le modifie et l'envoie par le chemin d'envoi
// existant.

const { MOTIF_PAUSE } = require('../gardes-des-fils')

// ⚠ COPIE DE `MOTIF_ARRET` (lib/cron-classify.js), TENUE PAR UN TEST : la
// constante n'est pas exportée, et ce module ne doit pas charger le cron.
// Deux tâches `info_unknown` ne portent PAS de question : « reçu pendant la
// pause » et « l'agent s'est arrêté ». Leur sous-tâche reprend le message entier
// du voyageur ; une carte Oui / Non / Autre n'y a pas de sens, et l'IA y est
// coupée (pause) ou plafonnée (arrêt).
const MOTIF_ARRET = 'L’agent IA s’est arrêté sur ce fil (3 appels en 24 h) : répondez au voyageur à la main.'
const MOTIFS_SANS_QUESTION = [MOTIF_PAUSE, MOTIF_ARRET]

const REPONSES = ['oui', 'non', 'autre']
const MAX_QUESTIONS = 10
const MAX_QUESTION = 500
const MAX_PRECISION = 300
const MAX_BROUILLON = 4000
const MAX_TEXTE = 4000
// Le fil donné au modèle : les plus récents. Une réponse se rédige sur la fin
// de la conversation, pas sur son histoire entière (et le coût suit la taille).
const MESSAGES_DU_FIL = 30

// ⚠ LE PLAFOND DE L'HÔTE N'EST PAS CELUI DE L'AGENT (décision de Thierry du
// 10 novembre 2026 : « 3 est trop petit de toute façon »). Les rédactions
// demandées par l'hôte se comptent dans le journal `ia_appels` sous leur propre
// étiquette, et ne touchent JAMAIS `guestflow_appels_ia` : sinon trois clics de
// l'hôte arrêteraient l'agent sur ce fil (MOTIF_ARRET) et réveilleraient le
// fondateur pour un geste voulu.
const FONCTION_IA = 'guestflow_rediger'
const PLAFOND_REDACTION = 10
const FENETRE_REDACTION_MS = 24 * 3600 * 1000

/**
 * Les questions d'une tâche « information manquante », dans l'ordre.
 * [] si la tâche n'en porte pas : autre type (une INTERVENTION garde son
 * alerte, décision de Thierry du 10 novembre 2026), déjà traitée, ou tâche
 * système (pause, arrêt).
 */
function questionsDe (tache) {
  if (!tache || tache.task_type !== 'info_unknown' || tache.status !== 'pending') return []
  if (MOTIFS_SANS_QUESTION.includes(String(tache.summary || ''))) return []
  const sous = Array.isArray(tache.sub_tasks) ? tache.sub_tasks : []
  const questions = sous
    .map(s => (s && typeof s.question === 'string') ? s.question.trim() : '')
    .filter(Boolean)
    .map(q => q.slice(0, MAX_QUESTION))
  return questions.slice(0, MAX_QUESTIONS)
}

/**
 * Valide les choix de l'hôte contre les questions de la tâche.
 * Entrée : [{ question, reponse: 'oui'|'non'|'autre', precision? }], UN par
 * question, dans l'ordre des questions. « Autre » exige une précision.
 * Rend { ok: true, choix: [{ question, reponse, precision }] } ou
 * { ok: false, erreur }.
 *
 * ⚠ LA QUESTION REVIENT DU CLIENT, ET ELLE DOIT ÊTRE CELLE DE LA BASE. Le cron
 * COMPLÈTE la tâche quand le voyageur écrit encore (nouvelles `sub_tasks`) :
 * des choix pris sur l'ancienne carte, appliqués par position, répondraient
 * « oui » à une question que l'hôte n'a jamais lue. Le nombre ne suffit pas à
 * le voir — deux questions peuvent en remplacer deux autres.
 */
function validerChoix (choix, questions) {
  if (!Array.isArray(questions) || !questions.length) return { ok: false, erreur: 'aucune_question' }
  if (!Array.isArray(choix)) return { ok: false, erreur: 'choix_incomplets' }
  const memeQuestion = (c, q) => c && typeof c.question === 'string' && c.question.trim().slice(0, MAX_QUESTION) === q
  if (choix.length !== questions.length) {
    // Une carte d'avant le complément : on le dit, l'écran relit la tâche.
    return { ok: false, erreur: choix.length && choix.every(c => c && typeof c.question === 'string') ? 'questions_changees' : 'choix_incomplets' }
  }
  if (!questions.every((q, i) => memeQuestion(choix[i], q))) return { ok: false, erreur: 'questions_changees' }
  const sortie = []
  for (let i = 0; i < questions.length; i++) {
    const c = choix[i] || {}
    const reponse = typeof c.reponse === 'string' ? c.reponse : ''
    if (!REPONSES.includes(reponse)) return { ok: false, erreur: 'choix_invalide' }
    const precision = typeof c.precision === 'string' ? c.precision.trim() : ''
    if (precision.length > MAX_PRECISION) return { ok: false, erreur: 'precision_trop_longue' }
    if (reponse === 'autre' && !precision) return { ok: false, erreur: 'precision_requise' }
    sortie.push({ question: questions[i], reponse, precision })
  }
  return { ok: true, choix: sortie }
}

function validerBrouillon (brouillon) {
  const b = typeof brouillon === 'string' ? brouillon.trim() : ''
  if (!b) return { ok: false, erreur: 'brouillon_vide' }
  if (b.length > MAX_BROUILLON) return { ok: false, erreur: 'brouillon_trop_long' }
  return { ok: true, brouillon: b }
}

const LIBELLE = { oui: 'OUI', non: 'NON', autre: 'AUTRE' }

// Le fil, du plus ancien au plus récent : qui parle, et quoi.
function filEnTexte (fil) {
  return (fil || []).map(m => {
    const qui = m.source === 'guest' ? 'VOYAGEUR' : (m.source === 'auto' ? 'MESSAGE AUTOMATIQUE' : 'HÔTE')
    return `[${qui}] ${String(m.message || '').trim()}`
  }).join('\n')
}

/**
 * Le texte envoyé au modèle. Deux entrées possibles, exclusives : les CHOIX
 * de l'hôte (carte Oui / Non / Autre), ou son BROUILLON (bouton « IA »).
 */
function promptRedaction ({ guestName, bienNom, fil, knowledgeText, consignes, choix = null, brouillon = null }) {
  const decisions = choix
    ? choix.map((c, i) => `${i + 1}. Question du voyageur : « ${c.question} »\n   Décision de l'hôte : ${LIBELLE[c.reponse]}${c.precision ? ` — ${c.precision}` : ''}`).join('\n')
    : null
  return `Tu rédiges, pour l'hôte d'une location de vacances, sa réponse au voyageur ${guestName || ''} (logement : ${bienNom || 'le logement'}).

RÈGLES :
- Écris dans la langue du voyageur : celle de ses derniers messages.
- Un message court, chaleureux et clair, prêt à envoyer tel quel.
- ${choix
    ? 'Réponds à CHAQUE question avec la DÉCISION DE L\'HÔTE ci-dessous, et rien d\'autre. Une décision « AUTRE » se transmet avec sa précision.'
    : 'Le BROUILLON DE L\'HÔTE ci-dessous dit ce qu\'il veut répondre : garde EXACTEMENT son sens, ses oui et ses non, et mets-le en forme.'}
- N'invente RIEN : aucune information, aucun prix, aucun horaire, aucune promesse qui ne soit ni dans ${choix ? 'les décisions de l\'hôte' : 'le brouillon de l\'hôte'} ni dans la base de connaissance.
- Pas de guillemets autour du message, pas d'objet, pas de note pour l'hôte : seulement le texte du message.
${consignes ? `\nCONSIGNES DE L'HÔTE (ton, signature) :\n${consignes}\n` : ''}
BASE DE CONNAISSANCE DU LOGEMENT :
${knowledgeText || '(vide)'}

CONVERSATION (du plus ancien au plus récent) :
${filEnTexte(fil) || '(vide)'}

${choix ? `DÉCISIONS DE L'HÔTE :\n${decisions}` : `BROUILLON DE L'HÔTE :\n${brouillon}`}

Réponds UNIQUEMENT avec le texte du message au voyageur.`
}

/** Le texte du message, depuis la réponse du modèle ; '' si rien d'utilisable. */
function texteDe (response) {
  const blocs = Array.isArray(response?.content) ? response.content : []
  let t = blocs.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
  // Des guillemets autour du message entier : le modèle a cité au lieu d'écrire.
  const paires = [['"', '"'], ['«', '»'], ['“', '”']]
  for (const [a, z] of paires) {
    if (t.startsWith(a) && t.endsWith(z) && t.length > 2) { t = t.slice(a.length, t.length - z.length).trim(); break }
  }
  return t.slice(0, MAX_TEXTE)
}

module.exports = {
  questionsDe, validerChoix, validerBrouillon, promptRedaction, texteDe, filEnTexte,
  MOTIF_ARRET, MOTIFS_SANS_QUESTION, REPONSES,
  MAX_QUESTIONS, MAX_PRECISION, MAX_BROUILLON, MAX_TEXTE, MESSAGES_DU_FIL,
  FONCTION_IA, PLAFOND_REDACTION, FENETRE_REDACTION_MS
}
