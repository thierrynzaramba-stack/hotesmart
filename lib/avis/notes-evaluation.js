// lib/avis/notes-evaluation.js
// DOC : docs/specs/spec-evaluation-voyageur.md §3, §4 (modif = MEME COMMIT)
//
// LES NOTES SE CALCULENT. L'IA NE LES TOUCHE PAS.
// Spec §3 : « Notes = calcul deterministe depuis les boutons, sans IA. L'IA ne
// redige que le texte. » Un avis publie chez Airbnb ne se reprend pas : la note
// part une fois, et elle doit etre EXACTEMENT ce que les boutons disaient.
//
// L'echelle et les categories ne sont pas les notres : ce sont celles de l'OTA,
// relevees sur l'API Channex le 24 septembre 2026 (etape 0).
//   POST /reviews/:review_id/guest_review
//   scores[] : { category, rating } — rating de 1 a 5
//   categories : cleanliness | communication | respect_house_rules
//   is_reviewee_recommended : booleen
//   tags[] : liste FERMEE, une categorie par tag.
//
// ⚠ AUCUNE HORLOGE, AUCUNE BASE, AUCUN RESEAU ICI. Fonctions pures : les memes
// boutons rendent la meme note, aujourd'hui et dans six mois.

// ─── Le vocabulaire des boutons (spec §4) ───────────────────────────────────
// Ordre = du meilleur au pire. C'est cet ordre qui porte la severite.
const NIVEAUX = {
  etat:          ['impeccable', 'correct', 'sale', 'tres_sale'],
  degats:        ['aucun', 'mineurs', 'importants'],
  poubelles:     ['fait', 'partiel', 'pas_fait'],
  communication: ['excellente', 'correcte', 'difficile'],
  regles:        ['oui', 'partiellement', 'non'],
  recommande:    ['oui', 'non'],
}

const CATEGORIES = ['cleanliness', 'communication', 'respect_house_rules']

// ─── Des boutons aux notes ──────────────────────────────────────────────────
// ⚠ LA PROPRETE COMBINE TROIS BOUTONS, ET PREND LE PLUS SEVERE — jamais la
// moyenne. Une moyenne noierait un degat important sous deux reponses
// parfaites : (5 + 1 + 5) / 3 = 3,7, arrondi a 4, soit « plutot bien » pour un
// logement abime. La note d'une categorie est la pire de ses composantes.
// ⚠ LA NOTE 1 EST RESERVEE AUX NIVEAUX QUE LA SPEC TIENT POUR NEGATIFS (§3) :
// tres sale, degats importants, regles non. C'est la note la plus punitive
// qu'Airbnb affiche sur un voyageur, et elle va de pair avec la validation
// obligatoire par l'hote. « Communication difficile » n'est pas dans cette
// liste limitative : il vaut 2, pas 1 — sinon un avis partirait avec un 1/5
// sans que l'hote ait eu a le valider. `tests/avis-notes-evaluation.test.js`
// verifie ce lien dans les deux sens.
// Arbitrage du 30 septembre 2026, la spec laissant les valeurs a fixer apres
// l'etape 0. Se renverse d'une ligne ici.
const NOTES = {
  etat:          { impeccable: 5, correct: 4, sale: 2, tres_sale: 1 },
  degats:        { aucun: 5, mineurs: 3, importants: 1 },
  poubelles:     { fait: 5, partiel: 4, pas_fait: 3 },
  communication: { excellente: 5, correcte: 4, difficile: 2 },
  regles:        { oui: 5, partiellement: 3, non: 1 },
}

// ─── Les tags, liste FERMEE de l'OTA (relevee le 24 septembre 2026) ─────────
// Un tag hors de cette liste est refuse par Airbnb : on n'en invente aucun.
const TAGS = {
  cleanliness: [
    'host_review_guest_positive_neat_and_tidy',
    'host_review_guest_positive_kept_in_good_condition',
    'host_review_guest_positive_took_care_of_garbage',
    'host_review_guest_negative_ignored_checkout_directions',
    'host_review_guest_negative_garbage',
    'host_review_guest_negative_messy_kitchen',
    'host_review_guest_negative_damage',
    'host_review_guest_negative_ruined_bed_linens',
  ],
  communication: [
    'host_review_guest_positive_helpful_messages',
    'host_review_guest_positive_respectful',
    'host_review_guest_positive_always_responded',
    'host_review_guest_negative_unhelpful_messages',
    'host_review_guest_negative_disrespectful',
    'host_review_guest_negative_unreachable',
    'host_review_guest_negative_slow_responses',
  ],
  respect_house_rules: [
    'host_review_guest_negative_arrived_early',
    'host_review_guest_negative_stayed_past_checkout',
    'host_review_guest_negative_unapproved_guests',
    'host_review_guest_negative_unapproved_pet',
    'host_review_guest_negative_did_not_respect_quiet_hours',
    'host_review_guest_negative_unapproved_filming',
    'host_review_guest_negative_unapproved_event',
    'host_review_guest_negative_smoking',
  ],
}

// Ce qu'un bouton pose comme tag. Volontairement CONSERVATEUR : on ne coche que
// ce que la question demandait. « Arrive trop tot » ou « fete non autorisee »
// existent chez Airbnb, mais aucun bouton ne les pose — les inventer depuis un
// « regles : non » ferait dire au tag ce que l'hote n'a pas dit.
const TAGS_PAR_REPONSE = {
  etat: {
    impeccable: ['host_review_guest_positive_neat_and_tidy'],
    correct:    ['host_review_guest_positive_kept_in_good_condition'],
    sale:       ['host_review_guest_negative_ignored_checkout_directions'],
    tres_sale:  ['host_review_guest_negative_ignored_checkout_directions'],
  },
  degats: {
    aucun:      ['host_review_guest_positive_kept_in_good_condition'],
    mineurs:    [],
    importants: ['host_review_guest_negative_damage'],
  },
  poubelles: {
    fait:     ['host_review_guest_positive_took_care_of_garbage'],
    partiel:  [],
    pas_fait: ['host_review_guest_negative_garbage'],
  },
  communication: {
    excellente: ['host_review_guest_positive_always_responded'],
    correcte:   ['host_review_guest_positive_respectful'],
    difficile:  ['host_review_guest_negative_slow_responses'],
  },
  regles: { oui: [], partiellement: [], non: [] },
  recommande: { oui: [], non: [] },
}

// ─── Lecture des reponses ───────────────────────────────────────────────────
// ⚠ UN NIVEAU INCONNU EST REFUSE, JAMAIS INTERPRETE. Un « sale » mal
// orthographie qui vaudrait 5 par defaut publierait un avis elogieux sur un
// logement sale, sans que personne ne s'en apercoive avant l'OTA.
function niveau (reponses, champ) {
  const v = reponses ? reponses[champ] : undefined
  if (v === undefined || v === null || v === '') throw new Error(`[avis] reponse manquante : ${champ}`)
  if (!NIVEAUX[champ].includes(v)) {
    throw new Error(`[avis] niveau inconnu pour ${champ} : « ${v} » (attendu : ${NIVEAUX[champ].join(' | ')})`)
  }
  return v
}

/** Les notes de l'OTA, derivees des boutons. Deterministe. */
function noter (reponses) {
  const r = Object.fromEntries(Object.keys(NIVEAUX).map(c => [c, niveau(reponses, c)]))
  const proprete = Math.min(NOTES.etat[r.etat], NOTES.degats[r.degats], NOTES.poubelles[r.poubelles])
  return {
    scores: [
      { category: 'cleanliness', rating: proprete },
      { category: 'communication', rating: NOTES.communication[r.communication] },
      { category: 'respect_house_rules', rating: NOTES.regles[r.regles] },
    ],
    is_reviewee_recommended: r.recommande === 'oui',
  }
}

/**
 * L'avis est-il NEGATIF au sens du garde-fou (spec §3) ?
 * Liste LIMITATIVE : recommandation « non », proprete « sale » ou « tres sale »,
 * degats « importants », regles « non ».
 *
 * ⚠ NE PAS L'ELARGIR EN DOUCE. « correct », « mineurs », « partiel »,
 * « difficile », « partiellement » genent, mais ne declenchent pas la
 * validation obligatoire par l'hote : chaque ajout retire a la prestataire un
 * pouvoir que Thierry lui a donne (`eval_power = valider`).
 */
function estNegatif (reponses) {
  const r = Object.fromEntries(Object.keys(NIVEAUX).map(c => [c, niveau(reponses, c)]))
  return r.recommande === 'non'
      || r.etat === 'sale' || r.etat === 'tres_sale'
      || r.degats === 'importants'
      || r.regles === 'non'
}

/** Les tags de l'OTA que les boutons justifient. Sans doublon, ordre stable. */
function tagsDe (reponses) {
  const vus = new Set()
  for (const champ of Object.keys(NIVEAUX)) {
    for (const t of TAGS_PAR_REPONSE[champ][niveau(reponses, champ)] || []) vus.add(t)
  }
  // ⚠ Un tag positif ne survit pas a un bouton qui le contredit : « propre » et
  // « degats importants » cochés ensemble ne laissent que le negatif.
  const liste = [...vus]
  const aDuNegatif = liste.some(t => t.includes('_negative_'))
  return aDuNegatif ? liste.filter(t => !t.includes('_positive_')) : liste
}

module.exports = { NIVEAUX, CATEGORIES, TAGS, NOTES, noter, estNegatif, tagsDe }
