// ═══════════════════════════════════════════════════════════════════════════
// Les marqueurs `agent_tasks.guest_message` des taches du CODE D'ACCES dont
// l'envoi automatique n'a pas abouti.
//
// UN SEUL ENDROIT, parce qu'ils ont deux lecteurs qui doivent dire la meme
// chose : l'ECRIVAIN (lib/cron-arrival-code.js, qui pose la tache) et l'etat
// des envois que lit l'agent IA (`etatDuModele`, lib/cron-classify.js). Un
// marqueur recopie dans l'un et oublie dans l'autre fait mentir l'agent sans
// qu'aucun ecran ne le montre.
//
// ⚠ DEUX ISSUES, PAS UNE (dette 144, decision de Thierry du 18 novembre 2026) :
//   · IMPOSSIBLE : le canal a refuse, ou il n'y a pas de messagerie — le code
//     n'est PAS parti, c'est sur ;
//   · INCERTAIN  : coupure PENDANT l'envoi (Channex `network_error`, exception
//     Beds24, Brevo injoignable pendant le POST) — le voyageur l'a PEUT-ETRE.
// Sans dependance : ce module est charge par les tests de l'un et de l'autre.
// ═══════════════════════════════════════════════════════════════════════════

const MARQUEUR_CODE_IMPOSSIBLE = '[AUTO: arrival_code — envoi impossible]'
const MARQUEUR_CODE_INCERTAIN = '[AUTO: arrival_code — envoi incertain]'

module.exports = { MARQUEUR_CODE_IMPOSSIBLE, MARQUEUR_CODE_INCERTAIN }
