// lib/gardes-des-fils.js
// LES VALEURS DES TROIS GARDES D'UN FIL, ET RIEN D'AUTRE.
//
// Elles vivaient dans lib/cron-classify.js, qui les exportait pour que le
// verificateur de migration et le script de parite interrogent les fonctions
// SQL avec EXACTEMENT ce que le cron leur passe. Mais charger cron-classify
// construit le client Anthropic de lib/cron-shared.js : un script de LECTURE
// SEULE n'a aucune raison d'exiger `CLAUDE_API_KEY`, qui est en production la
// cle FACTURABLE. Constat 15 de la review du 22 octobre 2026.
//
// Ce module n'a donc aucun effet de bord, et aucune dependance.
//
// ⚠ UNE SEULE SOURCE DE VERITE, DES DEUX COTES DE LA FRONTIERE SQL. Les
// recopier dans migrations/2026-10-22-gardes-des-fils.sql ferait deux verites,
// et la copie SQL ne rougirait nulle part le jour ou l'une change ici. Elles
// voyagent donc en PARAMETRES jusqu'aux fonctions.

// Les types de tache que la classification produit elle-meme. Une tache
// `auto_message` (modele, code d'acces) n'est PAS un traitement du fil.
const TYPES_CLASSIFICATION = ['sympathy', 'info_known', 'info_unknown', 'intervention']

// Le marqueur d'un message de modele automatique dans `conversations`. Un
// modele n'est jamais une reponse de l'hote (decision du 2 octobre 2026).
const PREFIXE_AUTO = '[AUTO:'

// Les deux fenetres des lectures par fil, reproduites a l'identique par les
// fonctions SQL : une garde groupee doit rendre le MEME verdict, pas un
// meilleur.
const FENETRE_CONVERSATIONS = 20
const FENETRE_TACHES_PAUSE = 20

// Le nombre de lignes au-dela duquel PostgREST rend une reponse COUPEE sans le
// dire. `cron_taches_pause_ouvertes` peut l'atteindre — elle rend jusqu'a
// FENETRE_TACHES_PAUSE lignes PAR reservation — donc sa reponse se CONSTATE.
const PLAFOND_POSTGREST = 1000

// Le motif de la tache « recu pendant la pause », qui se ferme d'elle-meme
// quand une reponse part (decision du 9 octobre 2026).
const MOTIF_PAUSE = 'Reçu pendant la pause : aucune réponse automatique n’est partie. Répondez au voyageur si besoin.'

module.exports = {
  TYPES_CLASSIFICATION,
  PREFIXE_AUTO,
  FENETRE_CONVERSATIONS,
  FENETRE_TACHES_PAUSE,
  PLAFOND_POSTGREST,
  MOTIF_PAUSE
}
