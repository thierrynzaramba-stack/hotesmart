// shared/yield-motifs.js
// LA TRADUCTION DES MOTIFS DU MOTEUR EN FRANÇAIS D'HÔTE.
// DOC : docs/kb/restitution-yield.md (modif = MÊME COMMIT)
//
// ⚠ POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST TESTÉ.
// Tout le chantier YieldFlow repose sur une règle : un indicateur qui vaut
// `null` doit dire « je ne sais pas » ET POURQUOI, jamais 0 ni un tiret muet.
// Les six modules du moteur portent donc une quarantaine de motifs. S'il en
// manque un ici, l'écran affiche `aucune_nuit_avec_occupants` à un hôte — ce
// qui est pire qu'un tiret : c'est illisible ET ça a l'air d'une panne.
//
// `tests/yield-motifs.test.js` DÉRIVE la liste depuis les modules du moteur et
// échoue si un motif n'a pas sa traduction. Ne jamais recopier cette liste à la
// main : c'est la règle 13 du dépôt (« ne jamais recopier une liste de
// référence » — le département 72 avait été classé en zone A pour ça).

// `titre` : ce qui s'affiche à la place du chiffre. Court, sans jargon.
// `quoi`  : l'explication, une phrase. Elle dit la CAUSE, pas la conséquence.
export const MOTIFS = {
  // ─── Capacité : la mémoire d'intention de l'hôte ───────────────────────────
  capacite_non_calculable: {
    titre: 'Capacité inconnue',
    quoi: 'Le calendrier de cette période n’a jamais été enregistré : impossible de savoir combien de nuits étaient ouvertes à la vente.'
  },
  aucun_jour_ouvert: {
    titre: 'Fermé à la vente',
    quoi: 'Aucune nuit n’était ouverte sur cette période. Un taux d’occupation n’existe pas : ce n’est pas 0 %, il n’y a rien à occuper.'
  },
  provider_sans_memoire_intention: {
    titre: 'Capacité inconnue',
    quoi: 'Ce logement n’est pas relié au canal de distribution : nous n’avons aucune trace de ce qui était ouvert.'
  },
  memoire_non_amorcee: {
    titre: 'Capacité inconnue',
    quoi: 'Aucune ligne de calendrier sur cette période.'
  },
  futur_sans_memoire_intention: {
    titre: 'Calendrier à venir non renseigné',
    quoi: 'Cette période est dans le futur et son calendrier n’a pas encore été enregistré. Nous n’estimons jamais l’avenir.'
  },
  parametres_invalides: {
    titre: 'Période invalide',
    quoi: 'Les dates demandées ne forment pas une période valide.'
  },
  periode_trop_longue: {
    titre: 'Période trop longue',
    quoi: 'La période dépasse ce que le moteur sait traiter en une fois.'
  },
  base_price_non_selectionne: {
    titre: 'Configuration incomplète',
    quoi: 'Le prix de base du logement n’a pas été lu : sans lui, impossible de dire si une nuit sans tarif était vendable.'
  },

  // ─── Indicateurs : « calculable » n'est pas « divisible » ──────────────────
  aucune_nuit_a_prix_connu: {
    titre: 'Aucune nuit tarifée',
    quoi: 'Aucune des nuits vendues ne porte de prix exploitable : un prix moyen n’aurait aucun sens.'
  },
  aucune_date_de_vente_fiable: {
    titre: 'Dates de vente non fiables',
    quoi: 'Aucune réservation de cette période ne porte une date de vente exploitable — souvent des lignes recréées lors d’une migration de canal.'
  },
  capacite_en_personnes_inconnue: {
    titre: 'Capacité en personnes inconnue',
    quoi: 'La capacité d’accueil du logement n’est pas renseignée.'
  },
  aucune_nuit_avec_occupants: {
    titre: 'Nombre de voyageurs inconnu',
    quoi: 'Aucune nuit ne porte le nombre de voyageurs : le canal ne l’a pas transmis. Afficher 0 % laisserait croire à un logement vide.'
  },
  aucune_nuit_avec_occupants_partiel: {
    titre: 'Voyageurs connus en partie',
    quoi: 'Une partie des nuits ne porte pas le nombre de voyageurs : l’occupation en personnes est sous-estimée.'
  },
  revpar_sur_ca_partiel: {
    titre: 'RevPAR sous-estimé',
    quoi: 'Des nuits vendues n’ont pas de prix connu : elles comptent au taux d’occupation mais pas au chiffre d’affaires, donc le RevPAR est un minimum.'
  },

  // ─── Comparaison N-1 ──────────────────────────────────────────────────────
  periode_n1_absente: {
    titre: 'Pas de N-1',
    quoi: 'Cette période n’existe pas dans l’historique. Le logement n’a pas « fait zéro » l’an dernier : il n’y a rien à comparer.'
  },
  n1_hors_perimetre: {
    titre: 'N-1 hors période affichée',
    quoi: 'L’année précédente n’est pas dans la fenêtre demandée. Élargissez la période pour la comparer.'
  },
  n1_non_calculable: {
    titre: 'N-1 non calculable',
    quoi: 'La période existe l’an dernier, mais cet indicateur-là n’y est pas calculable.'
  },
  valeur_non_calculable: {
    titre: 'Non calculable cette année',
    quoi: 'L’indicateur de l’année en cours n’est pas calculable : la comparaison ne l’est donc pas non plus.'
  },

  // ─── Pickup « à date » ────────────────────────────────────────────────────
  portefeuille_n1_reconstruit: {
    titre: 'N-1 reconstruit',
    quoi: 'Le portefeuille de l’an dernier n’a pas été observé à cette date : il est reconstitué depuis l’état d’aujourd’hui. Les réservations annulées depuis ont disparu, donc le N-1 est sous-estimé et la progression affichée est flattée.'
  },
  aveugle_avant_bascule: {
    titre: 'Historique non visible',
    quoi: 'Rien n’est lisible avant cette date l’an dernier — historique non repris lors d’une migration, ou dates de vente inexploitables. Le zéro veut dire « on ne sait pas », pas « rien vendu ».'
  },
  periode_fermee_a_la_vente: {
    titre: 'Fermé à la vente',
    quoi: 'Le calendrier de cette période est fermé. N’avoir rien vendu n’est pas un échec commercial : c’est une décision.'
  },
  periode_n1_fermee_a_la_vente: {
    titre: 'N-1 fermé à la vente',
    quoi: 'L’an dernier, le logement ne POUVAIT pas vendre sur cette période. Se comparer à cette fermeture donnerait une progression imaginaire.'
  },
  capacite_de_la_periode_non_amorcee: {
    titre: 'Calendrier non renseigné',
    quoi: 'Le calendrier de cette période n’a jamais été enregistré : le zéro ne se compare à rien.'
  },
  capacite_n1_non_amorcee: {
    titre: 'Calendrier N-1 non renseigné',
    quoi: 'Le calendrier de l’an dernier n’est pas connu sur cette période.'
  },
  dates_de_vente_incompletes: {
    titre: 'Dates de vente incomplètes',
    quoi: 'Des réservations de cette année n’ont pas de date de vente exploitable : elles sont écartées du « à date ».'
  },
  dates_de_vente_incompletes_n1: {
    titre: 'Dates de vente N-1 incomplètes',
    quoi: 'Des réservations de l’an dernier n’ont pas de date de vente exploitable : le portefeuille de comparaison est amputé.'
  },
  vendue_apres_le_pivot: {
    titre: 'Vendue après la date d’observation',
    quoi: 'Réservation prise après la date à laquelle on observe : normal, elle n’existait pas encore.'
  },
  sans_date_de_vente: {
    titre: 'Sans date de vente',
    quoi: 'Le canal n’a pas transmis de date de réservation.'
  },
  date_de_vente_non_fiable: {
    titre: 'Date de vente non fiable',
    quoi: 'La date connue est celle d’une migration, pas celle de la vente réelle : la retenir ferait apparaître tout le portefeuille au même jour.'
  },

  // ─── Référence et projection ──────────────────────────────────────────────
  echantillon_sous_le_seuil: {
    titre: 'Trop peu d’historique',
    quoi: 'Pas assez de nuits, ou pas assez de réservations distinctes, sur ce type de période : une médiane calculée là-dessus serait un accident, pas une norme. Les seuils exacts sont rappelés sous le tableau de référence.'
  },
  aucun_historique: {
    titre: 'Aucun historique',
    quoi: 'Aucune vente passée ne permet d’établir une référence.'
  },
  date_invalide: {
    titre: 'Date invalide',
    quoi: 'La date demandée n’existe pas.'
  },
  hors_fenetre_du_contexte: {
    titre: 'Hors période chargée',
    quoi: 'Ce jour est en dehors de la fenêtre chargée : le calendrier scolaire et les jours fériés n’y sont pas connus.'
  },
  fenetre_invalide: {
    titre: 'Période invalide',
    quoi: 'Les bornes demandées ne forment pas une période valide.'
  },
  jours_sans_reference: {
    titre: 'Jours sans référence',
    quoi: 'Certains jours n’ont pas assez d’historique comparable pour qu’un prix attendu soit calculé.'
  },
  periode_deja_commencee: {
    titre: 'Période déjà commencée',
    quoi: 'La trajectoire de réservation se lit AVANT le début d’une période. Celle-ci a commencé : la question ne se pose plus.'
  },
  aucune_courbe_fiable: {
    titre: 'Rythme de vente inconnu',
    quoi: 'Aucun segment de cette période n’a assez d’historique pour établir un rythme de réservation.'
  },
  trajectoire_partielle: {
    titre: 'Trajectoire partielle',
    quoi: 'Une partie des jours n’a pas de rythme de réservation connu : l’attente porte sur les autres.'
  },
  trajectoire_non_calculable: {
    titre: 'Trajectoire non calculable',
    quoi: 'Il manque le rythme de réservation ou la date d’observation.'
  },
  rien_ne_se_vend_a_ce_delai: {
    titre: 'Trop tôt pour comparer',
    quoi: 'À ce délai, l’historique n’avait jamais rien vendu sur ce segment : il n’y a pas de rythme à rattraper.'
  },
  delai_au_dela_du_dernier_palier: {
    titre: 'Trop loin pour projeter',
    quoi: 'Cette période est plus éloignée que le plus long délai observé dans votre historique : aucun rythme de vente connu ne s’y applique.'
  },
  borne_haute_non_calculable: {
    titre: 'Fourchette ouverte vers le haut',
    quoi: 'À ce délai, l’historique n’avait jamais rien vendu sur une partie des jours : la borne haute de la fourchette n’a pas de limite connue.'
  },
  extrapolation_au_dela_de_la_capacite: {
    titre: 'Plafonné à la capacité',
    quoi: 'Au rythme observé, la projection dépasserait le nombre de nuits ouvertes — ce qui est impossible. Le chiffre est ramené au maximum vendable, et le rythme ne s’applique visiblement pas à cette période.'
  },
  intervalle_trop_large: {
    titre: 'Fourchette trop large',
    quoi: 'À ce délai, le rythme de vente historique est trop dispersé pour resserrer la prévision : la fourchette va du simple au double, elle ne permet pas de décider.'
  },
  segment_non_reconnu: {
    titre: 'Type de période inconnu',
    quoi: 'Ce jour n’a pas pu être rattaché à un type de période (vacances, férié, pont) : le calendrier scolaire ne le couvre pas.'
  },
  occupation_de_reference_absente: {
    titre: 'Pas de référence d’occupation',
    quoi: 'Sans taux d’occupation de l’an dernier, dire « en avance » ou « en retard » serait une invention.'
  }
}

// ─── Les refus de l'endpoint d'écriture, en français d'hôte ─────────────────
// ⚠ `api/yield-exceptions.js` rend des CODES (`periode_invalide`,
// `exception_introuvable`…), pas des phrases. Sans cette table, l'hôte lirait
// `exception_introuvable` — ce qui est exactement ce que tout ce fichier
// combat, cette fois sur le seul écran de l'app qui écrit.
export const REFUS_ECRITURE = {
  periode_invalide: 'Les dates ne forment pas une période valide.',
  periode_future: 'Une période hors référence porte sur le passé. Pour l’avenir, '
    + 'fermez les dates au calendrier ou ajustez le prix : retirer de la référence '
    + 'un jour encore vendable créerait deux vérités pour la même nuit.',
  id_requis: 'Aucune période désignée.',
  id_invalide: 'Cette période n’existe pas.',
  exception_introuvable: 'Cette période a déjà été supprimée, ou appartient à un autre logement.',
  bien_requis: 'Aucun logement désigné.',
  lecture_impossible: 'Lecture impossible pour le moment. Réessayez dans un instant.',
  ecriture_impossible: 'Enregistrement impossible pour le moment. Rien n’a été modifié.',
  suppression_impossible: 'Suppression impossible pour le moment. Rien n’a été modifié.',
  methode_non_supportee: 'Opération non prise en charge.'
}

// Un refus se lit toujours : code connu → phrase, sinon le message brut du
// serveur (le writer, lui, rend déjà des phrases lisibles).
export function refus (code) {
  if (!code) return 'Opération impossible.'
  return REFUS_ECRITURE[code] || String(code)
}

// ─── Drapeaux posés par l'ÉCRAN, pas par le moteur ──────────────────────────
// ⚠ Le moteur est PUR : il n'a pas d'horloge, donc il ne peut pas savoir qu'une
// période n'a pas encore commencé. Il calcule donc un CA de 0 et une variation
// de −100 % sur décembre vu en septembre — à bon droit, mais l'écran, lui, sait
// la date et doit le dire. Relevé en review : la fenêtre par défaut étant
// l'année civile, TOUT hôte voyait les mois à venir dans « ce qui s'est vendu ».
// Ces drapeaux ne sont pas dans MOTIFS : ils ne désignent aucun motif du
// moteur, et le test des traductions orphelines a raison de les y refuser.
export const DRAPEAUX_ECRAN = {
  periode_a_venir: {
    titre: 'À venir',
    quoi: 'Cette période n’a pas commencé. Ce qui est vendu s’y lit dans « À date », jamais dans le réalisé : comparer un mois non commencé à un mois complet donnerait toujours une chute.'
  },
  periode_en_cours: {
    titre: 'En cours',
    quoi: 'Cette période a commencé mais n’est pas finie : le réalisé y est partiel, et la comparaison avec l’an dernier porte sur un mois complet.'
  },
  comparaison_estimee: {
    titre: 'Comparaison estimée',
    quoi: 'L’un des deux termes repose sur une capacité estimée : l’écart est un ordre de grandeur, pas une mesure.'
  },
  capacite_estimee: {
    titre: 'Estimé',
    quoi: 'Avant la mise en service du calendrier, un jour passé sans trace d’intention est réputé ouvert, sauf exception déclarée. Ce chiffre est une estimation, pas une mesure.'
  }
}

// Les quatre niveaux de la cascade de repli de la référence, du plus fin au
// plus grossier. ⚠ « Replié » n'est pas une erreur : c'est une réponse PLUS
// FAIBLE, et l'écran doit la distinguer d'une mesure directe.
export const NIVEAUX_REFERENCE = {
  segment_detaille_x_jour: {
    titre: 'Mesure directe',
    quoi: 'Calculé sur ce type de période précis et ce jour de semaine.'
  },
  segment_x_jour: {
    titre: 'Référence élargie',
    quoi: 'Pas assez d’historique sur ce type de période précis : élargi à la saison et au jour de semaine.'
  },
  segment: {
    titre: 'Référence élargie à la saison',
    quoi: 'Élargi à toute la saison, tous jours de semaine confondus.'
  },
  jour_de_semaine: {
    titre: 'Référence minimale',
    quoi: 'Plus assez d’historique saisonnier : il ne reste que l’effet du jour de semaine, le signal le plus stable.'
  }
}

// Les segments du moteur, en clair.
export const SEGMENTS = {
  ferie: 'Jour férié',
  pont: 'Pont',
  vacances_zone_du_bien: 'Vacances de la zone du logement',
  vacances_autre_zone: 'Vacances d’une autre zone',
  hors_vacances: 'Hors vacances'
}

// Un motif inconnu est DIT, jamais masqué : mieux vaut un code brut visible
// qu'une case vide dont personne ne saura qu'elle cachait quelque chose.
export function motif (code) {
  if (!code) return null
  const m = MOTIFS[code] || DRAPEAUX_ECRAN[code]
  if (m) return { code, ...m }
  return { code, titre: 'Non calculable', quoi: `Motif non traduit : ${code}`, inconnu: true }
}

// Nom lisible d'un segment, y compris ses variantes détaillées
// (`vacances_zone_du_bien:hiver`).
export function nomSegment (code) {
  if (!code) return '—'
  const [base, detail] = String(code).split(':')
  const nom = SEGMENTS[base] || base
  if (!detail) return nom
  const propre = detail.replace(/_/g, ' ')
  return `${nom} — ${propre.charAt(0).toUpperCase()}${propre.slice(1)}`
}
