// lib/avis/notes-evaluation.js
// DOC : docs/specs/spec-evaluation-voyageur.md §4 (modif = MEME COMMIT)
//
// LA GRILLE EST CONFIGURABLE, LES NOTES SE CALCULENT, L'IA N'Y TOUCHE PAS.
//
// Amendement du 30 septembre 2026 : l'hote compose sa grille (criteres,
// niveaux, notes, drapeaux). La grille d'origine reste ici comme GRILLE_DEFAUT
// — une CONSTANTE DU CODE, jamais inseree en base : la base ne recoit des
// lignes que le jour ou l'hote modifie sa grille.
//
// ⚠ CE QUI RESTE HORS DE PORTEE DE L'HOTE (spec §4.2), et pourquoi :
//   - une note 1 est TOUJOURS negative ;
//   - un refus de recommander est TOUJOURS negatif.
// La base les tient par contrainte. Ce module les tient AUSSI, et ce n'est pas
// une redondance : une grille FIGEE (guest_evaluations.grille_figee) peut venir
// d'avant la contrainte, ou d'un import. On ne la croit pas sur parole.
//
// ⚠ AUCUNE HORLOGE, AUCUNE BASE, AUCUN RESEAU. Fonctions pures : la meme grille
// et les memes reponses rendent la meme note, aujourd'hui et dans six mois.

// Les quatre seules categories publiables (etape 0, API Channex, 24/09/2026).
// « recommandation » ne porte PAS de note : Airbnb attend un booleen.
const CATEGORIES_NOTEES = ['cleanliness', 'communication', 'respect_house_rules']
const CATEGORIES = [...CATEGORIES_NOTEES, 'recommandation']
const REMPLI_PAR = ['prestataire', 'hote', 'les_deux']

// ─── La grille par defaut ───────────────────────────────────────────────────
// ⚠ LES CLES SONT UN CONTRAT. `etat`, `degats`, `poubelles`… sont stockees dans
// les reponses et dans les grilles figees : les renommer casserait les
// evaluations deja remplies. Les LIBELLES, eux, se changent librement.
const n = (cle, libelle, rang, note, negatif = false, extra = {}) => ({ cle, libelle, rang, note, negatif, ...extra })
const GRILLE_DEFAUT = Object.freeze({
  defaut: true,
  criteres: [
    { cle: 'etat', libelle: 'État du logement', categorie: 'cleanliness', rempli_par: 'prestataire', rang: 1,
      niveaux: [n('impeccable', 'Impeccable', 1, 5), n('correct', 'Correct', 2, 4),
                n('sale', 'Sale', 3, 2, true), n('tres_sale', 'Très sale', 4, 1, true)] },
    { cle: 'degats', libelle: 'Dégâts', categorie: 'cleanliness', rempli_par: 'prestataire', rang: 2,
      niveaux: [n('aucun', 'Aucun', 1, 5), n('mineurs', 'Mineurs', 2, 3), n('importants', 'Importants', 3, 1, true)] },
    { cle: 'poubelles', libelle: 'Poubelles & vaisselle', categorie: 'cleanliness', rempli_par: 'prestataire', rang: 3,
      niveaux: [n('fait', 'Fait', 1, 5), n('partiel', 'Partiel', 2, 4), n('pas_fait', 'Pas fait', 3, 3)] },
    { cle: 'communication', libelle: 'Communication', categorie: 'communication', rempli_par: 'hote', rang: 4,
      // « Difficile » vaut 2, pas 1 : la spec ne le tient pas pour negatif, et
      // la note 1 va de pair avec la validation obligatoire par l'hote.
      niveaux: [n('excellente', 'Excellente', 1, 5), n('correcte', 'Correcte', 2, 4), n('difficile', 'Difficile', 3, 2)] },
    { cle: 'regles', libelle: 'Respect des règles & horaires', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 5,
      niveaux: [n('oui', 'Oui', 1, 5), n('partiellement', 'Partiellement', 2, 3), n('non', 'Non', 3, 1, true)] },
    { cle: 'recommande', libelle: 'Recommandez-vous ce voyageur ?', categorie: 'recommandation', rempli_par: 'hote', rang: 6,
      niveaux: [n('oui', 'Oui', 1, null, false, { recommande: true }),
                n('non', 'Non', 2, null, true, { recommande: false })] },
  ],
})

// ─── Les tags de l'OTA (liste FERMEE, relevee le 24/09/2026) ───────────────
// ⚠ NON CONFIGURABLES (v1, spec §4.4). Chaque tag appartient a une categorie
// chez Airbnb ; laisser l'hote les associer permettrait de cocher « a sorti les
// poubelles » sur un critere qui dit le contraire. Ils ne valent que pour les
// criteres de la grille par defaut, reconnus par leur cle : un critere invente
// par l'hote n'en porte aucun. Limite assumee.
const TAGS = {
  cleanliness: [
    'host_review_guest_positive_neat_and_tidy', 'host_review_guest_positive_kept_in_good_condition',
    'host_review_guest_positive_took_care_of_garbage', 'host_review_guest_negative_ignored_checkout_directions',
    'host_review_guest_negative_garbage', 'host_review_guest_negative_messy_kitchen',
    'host_review_guest_negative_damage', 'host_review_guest_negative_ruined_bed_linens',
  ],
  communication: [
    'host_review_guest_positive_helpful_messages', 'host_review_guest_positive_respectful',
    'host_review_guest_positive_always_responded', 'host_review_guest_negative_unhelpful_messages',
    'host_review_guest_negative_disrespectful', 'host_review_guest_negative_unreachable',
    'host_review_guest_negative_slow_responses',
  ],
  respect_house_rules: [
    'host_review_guest_negative_arrived_early', 'host_review_guest_negative_stayed_past_checkout',
    'host_review_guest_negative_unapproved_guests', 'host_review_guest_negative_unapproved_pet',
    'host_review_guest_negative_did_not_respect_quiet_hours', 'host_review_guest_negative_unapproved_filming',
    'host_review_guest_negative_unapproved_event', 'host_review_guest_negative_smoking',
  ],
}
const TAGS_PAR_REPONSE = {
  etat: { impeccable: ['host_review_guest_positive_neat_and_tidy'], correct: ['host_review_guest_positive_kept_in_good_condition'],
          sale: ['host_review_guest_negative_ignored_checkout_directions'], tres_sale: ['host_review_guest_negative_ignored_checkout_directions'] },
  degats: { aucun: ['host_review_guest_positive_kept_in_good_condition'], mineurs: [], importants: ['host_review_guest_negative_damage'] },
  poubelles: { fait: ['host_review_guest_positive_took_care_of_garbage'], partiel: [], pas_fait: ['host_review_guest_negative_garbage'] },
  communication: { excellente: ['host_review_guest_positive_always_responded'], correcte: ['host_review_guest_positive_respectful'],
                   difficile: ['host_review_guest_negative_slow_responses'] },
  regles: { oui: [], partiellement: [], non: [] },
  recommande: { oui: [], non: [] },
}

// ─── D'ou vient la grille ───────────────────────────────────────────────────
/**
 * La grille qui s'applique. Une grille de BIEN remplace celle du COMPTE, elle
 * ne s'y ajoute pas : une fusion ligne a ligne rendrait illisible ce que
 * l'hote voit a l'ecran. Aucune ligne nulle part => grille par defaut.
 */
function grilleDe ({ duBien = [], duCompte = [] } = {}) {
  const criteres = (duBien && duBien.length) ? duBien : (duCompte && duCompte.length) ? duCompte : null
  if (!criteres) return GRILLE_DEFAUT
  return { defaut: false, criteres: [...criteres].sort((a, b) => (a.rang || 0) - (b.rang || 0)) }
}

// ─── Validation d'une grille (avant de l'ecrire) ───────────────────────────
function validerGrille (grille) {
  const criteres = (grille && grille.criteres) || []
  if (!criteres.length) throw new Error('[avis] une grille sans critere ne publie rien')
  const clesVues = new Set()
  for (const c of criteres) {
    if (!c.cle || !String(c.cle).trim()) throw new Error('[avis] critere sans cle')
    if (clesVues.has(c.cle)) throw new Error(`[avis] deux criteres portent la cle « ${c.cle} »`)
    clesVues.add(c.cle)
    if (!CATEGORIES.includes(c.categorie)) throw new Error(`[avis] categorie inconnue : « ${c.categorie} » (attendu : ${CATEGORIES.join(' | ')})`)
    if (c.rempli_par && !REMPLI_PAR.includes(c.rempli_par)) throw new Error(`[avis] « qui remplit » inconnu : « ${c.rempli_par} »`)
    const niveaux = c.niveaux || []
    if (!niveaux.length) throw new Error(`[avis] le critere « ${c.cle} » n a aucun niveau`)
    const clesNiv = new Set()
    for (const v of niveaux) {
      if (!v.cle || !String(v.cle).trim()) throw new Error(`[avis] niveau sans cle dans « ${c.cle} »`)
      if (clesNiv.has(v.cle)) throw new Error(`[avis] deux niveaux « ${v.cle} » dans « ${c.cle} »`)
      clesNiv.add(v.cle)
      if (c.categorie === 'recommandation') {
        if (v.note !== null && v.note !== undefined) throw new Error(`[avis] « ${c.cle} » est de categorie recommandation : ses niveaux ne portent pas de note (Airbnb attend un booleen)`)
        if (typeof v.recommande !== 'boolean') throw new Error(`[avis] le niveau « ${v.cle} » de « ${c.cle} » doit dire s il recommande (true/false)`)
        // ⚠ REGLE FORCEE : un refus de recommander est toujours negatif.
        if (v.recommande === false && !v.negatif) throw new Error(`[avis] « ${c.cle} / ${v.cle} » refuse de recommander sans etre negatif — un refus de recommandation repasse toujours par l hote`)
      } else {
        if (!Number.isInteger(v.note) || v.note < 1 || v.note > 5) throw new Error(`[avis] note invalide dans « ${c.cle} / ${v.cle} » : ${v.note} (attendu : entier de 1 a 5)`)
        // ⚠ REGLE FORCEE : une note 1 est toujours negative.
        if (v.note === 1 && !v.negatif) throw new Error(`[avis] « ${c.cle} / ${v.cle} » porte la note 1 sans etre negatif — un 1/5 repasse toujours par l hote`)
      }
    }
  }
  return true
}

// ─── Lire une reponse dans la grille ───────────────────────────────────────
// ⚠ UNE REPONSE HORS GRILLE EST REFUSEE, JAMAIS IGNOREE. Un niveau mal
// orthographie qui vaudrait 5 par defaut publierait un avis elogieux sur un
// logement sale.
function niveauCoche (reponses, critere) {
  const v = reponses ? reponses[critere.cle] : undefined
  if (v === undefined || v === null || v === '') throw new Error(`[avis] reponse manquante : ${critere.cle}`)
  const niv = (critere.niveaux || []).find(x => x.cle === v)
  if (!niv) throw new Error(`[avis] niveau inconnu pour ${critere.cle} : « ${v} » (attendu : ${(critere.niveaux || []).map(x => x.cle).join(' | ')})`)
  return niv
}

/**
 * Les notes de l'OTA, derivees des boutons et de la grille.
 * Une categorie SANS critere n'est pas publiee (Airbnb accepte un scores[]
 * partiel) : publier un 5 par defaut dirait ce que l'hote n'a pas dit.
 */
function noter (reponses, grille = GRILLE_DEFAUT) {
  const criteres = (grille && grille.criteres) || []
  const parCategorie = new Map()
  let recommande
  for (const c of criteres) {
    const niv = niveauCoche(reponses, c)
    if (c.categorie === 'recommandation') {
      // Plusieurs criteres de recommandation : un seul « non » suffit.
      recommande = recommande === undefined ? niv.recommande !== false : (recommande && niv.recommande !== false)
      continue
    }
    // ⚠ LE PLUS SEVERE, jamais la moyenne : (5 + 1 + 5) / 3 arrondi a 4
    // donnerait « plutot bien » pour un logement abime.
    const actuel = parCategorie.get(c.categorie)
    if (actuel === undefined || niv.note < actuel) parCategorie.set(c.categorie, niv.note)
  }
  const scores = CATEGORIES_NOTEES.filter(k => parCategorie.has(k)).map(k => ({ category: k, rating: parCategorie.get(k) }))
  return recommande === undefined ? { scores } : { scores, is_reviewee_recommended: recommande }
}

/**
 * L'avis est-il NEGATIF (garde-fou §3) ?
 * Le drapeau de la grille, PLUS les deux regles que l'hote ne peut pas defaire
 * — verifiees ici aussi, parce qu'une grille figee peut venir d'avant elles.
 */
function estNegatif (reponses, grille = GRILLE_DEFAUT) {
  for (const c of (grille && grille.criteres) || []) {
    const niv = niveauCoche(reponses, c)
    if (niv.negatif) return true
    if (niv.note === 1) return true
    if (niv.recommande === false) return true
  }
  return false
}

/** Les tags de l'OTA que les boutons justifient. Grille par defaut seulement. */
function tagsDe (reponses, grille = GRILLE_DEFAUT) {
  const vus = new Set()
  for (const c of (grille && grille.criteres) || []) {
    const table = TAGS_PAR_REPONSE[c.cle]
    if (!table) continue                       // critere invente par l'hote : aucun tag
    const niv = niveauCoche(reponses, c)
    for (const t of table[niv.cle] || []) vus.add(t)
  }
  const liste = [...vus]
  // Un tag positif ne survit pas a un bouton qui le contredit.
  return liste.some(t => t.includes('_negative_')) ? liste.filter(t => !t.includes('_positive_')) : liste
}

module.exports = {
  GRILLE_DEFAUT, CATEGORIES, CATEGORIES_NOTEES, REMPLI_PAR, TAGS,
  grilleDe, validerGrille, noter, estNegatif, tagsDe,
}
