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
// ⚠ GEL PROFOND, PAS `Object.freeze` SEUL. Constat de review : un freeze de
// surface laisse `criteres` et chaque niveau mutables. Un ecran de reglages qui
// charge la grille effective et la modifie « sur place » changerait la CONSTANTE
// pour toute la duree de vie du processus — et sur une fonction serverless
// chaude, toutes les evaluations suivantes seraient notees sur la grille
// bricolee d'un autre.
//
// ⚠ ET LE GEL EST LA SEULE PROTECTION : `grilleDe` rend GRILLE_DEFAUT LUI-MEME
// quand le compte n'a rien cree, et partage ses objets `critere` avec
// l'appelant sinon. La phrase « grilleDe rend une copie » etait fausse, dans
// les deux branches. Constat de review. Un ecran qui veut modifier la grille
// effective en fait sa propre copie — en CommonJS non strict, une mutation sur
// un objet gele echoue EN SILENCE, et ses changements disparaitraient sans une
// seule erreur.
const gelerProfond = (o) => {
  if (o && typeof o === 'object') { Object.values(o).forEach(gelerProfond); Object.freeze(o) }
  return o
}
const GRILLE_DEFAUT = gelerProfond({
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
  // ⚠ `actif` SE FILTRE ICI, ET C'EST LA SEULE FACON SURE. Constat de review :
  // un critere desactive laisse par l'appelant serait EXIGE de l'hote
  // (`niveauCoche` refuse une reponse manquante) et compterait dans la note.
  // Pire : une grille de bien dont tous les criteres sont desactives est
  // NON VIDE — elle remplacerait la grille du compte par rien du tout.
  const vivants = (l) => (l || []).filter(c => c && c.actif !== false)
  const bien = vivants(duBien), compte = vivants(duCompte)
  const criteres = bien.length ? bien : compte.length ? compte : null

  // ⚠ « AUCUNE LIGNE » ET « TOUTES ETEINTES » NE SONT PAS LA MEME CHOSE.
  // Second constat de review sur cette fonction. Un compte sans aucun critere
  // n'a rien decide : la grille par defaut s'applique, c'est le cas de tous les
  // comptes a l'ouverture (§4.5, et aucune grille n'est pre-inseree).
  //
  // Mais un compte qui a cree des criteres PUIS les a tous eteints a decide
  // quelque chose, et ce n'est pas « remettez les votres ». Lui rendre
  // GRILLE_DEFAUT ferait partir chez Airbnb des notes de proprete, de
  // communication et de reglement qu'il n'a jamais voulu donner.
  //
  // On rend donc une grille VIDE et explicite. `validerGrille` la refuse, et
  // la publication s'arrete sur un motif nomme au lieu de publier autre chose.
  if (!criteres) {
    const existent = (duBien || []).length || (duCompte || []).length
    if (existent) return { defaut: false, criteres: [] }
    return GRILLE_DEFAUT
  }
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
        // ⚠ `recommande` N'A DE SENS QUE POUR « recommandation ». Ailleurs, il
        // rendrait l'avis negatif (estNegatif le lit) sans jamais atteindre la
        // charge envoyee a l'OTA : une evaluation bloquee pour un motif
        // invisible. Constat de review.
        if (v.recommande !== undefined && v.recommande !== null) throw new Error(`[avis] « ${c.cle} / ${v.cle} » porte « recommande » alors que sa categorie est ${c.categorie} : ce drapeau n appartient qu a la categorie recommandation`)
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
      // ⚠ UN DRAPEAU ABSENT NE VAUT PAS « OUI ». Constat de review, exactement
      // symetrique de celui sur la note ci-dessous : une grille figee d'avant
      // les contraintes peut porter un niveau « Non » sans `recommande: false`.
      // Le test `!== false` le lisait alors comme un OUI, et Airbnb recevait
      // « is_reviewee_recommended: true » sur un refus — le jugement le plus
      // lourd qu'un hote porte, inverse, et irrattrapable.
      if (typeof niv.recommande !== 'boolean') {
        throw new Error(`[avis] « ${c.cle} / ${niv.cle} » ne dit pas s il recommande : ${niv.recommande}`)
      }
      // Plusieurs criteres de recommandation : un seul « non » suffit.
      recommande = recommande === undefined ? niv.recommande : (recommande && niv.recommande)
      continue
    }
    // ⚠ LE PLUS SEVERE, jamais la moyenne : (5 + 1 + 5) / 3 arrondi a 4
    // donnerait « plutot bien » pour un logement abime.
    // ⚠ UNE NOTE ABSENTE NE PASSE PAS. Constat de review : une grille figee
    // d'avant les contraintes peut porter `note: null` dans une categorie
    // notee. La comparaison `null < 5` etant fausse, ce null gagnait, et
    // `scores[]` partait chez Airbnb avec « rating: null ». `estNegatif` avait
    // ete durci contre ces vieilles grilles, `noter` non — or c'est `noter` qui
    // atteint l'OTA.
    if (!Number.isInteger(niv.note) || niv.note < 1 || niv.note > 5) {
      throw new Error(`[avis] « ${c.cle} / ${niv.cle} » (${c.categorie}) n a pas de note utilisable : ${niv.note}`)
    }
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
    // ⚠ « JE NE SAIS PAS » SE TRAITE COMME UN NEGATIF, JAMAIS COMME UN OUI.
    // Un critere de recommandation dont le niveau ne porte pas de booleen vient
    // d'une grille figee anterieure aux contraintes. `noter()` refusera de
    // calculer, mais ce garde-fou passe AVANT : il envoie l'evaluation a
    // l'hote au lieu de la laisser filer sur le pouvoir de la prestataire.
    if (c.categorie === 'recommandation' && typeof niv.recommande !== 'boolean') return true
  }
  return false
}

/** Les tags de l'OTA que les boutons justifient. Grille par defaut seulement. */
function tagsDe (reponses, grille = GRILLE_DEFAUT) {
  const vus = new Set()
  for (const c of (grille && grille.criteres) || []) {
    // ⚠ LA CLE NE SUFFIT PAS : ON EXIGE AUSSI LA CATEGORIE D'ORIGINE.
    // Constat de review : un critere de l'hote qui reprend une cle du defaut
    // (plausible si l'ecran derive les cles des libelles) mais la range dans
    // une AUTRE categorie emettait quand meme les tags de cette cle — par
    // exemple « toujours reactif » sur un critere de reglement interieur.
    const origine = GRILLE_DEFAUT.criteres.find(d => d.cle === c.cle)
    const table = origine && origine.categorie === c.categorie ? TAGS_PAR_REPONSE[c.cle] : null
    if (!table) continue                       // critere invente par l'hote : aucun tag
    const niv = niveauCoche(reponses, c)

    // ⚠ ET LE NIVEAU DOIT DIRE LA MEME CHOSE QUE CELUI D'ORIGINE.
    // Deuxieme constat de review sur la meme fonction : la cle et la categorie
    // ne disent rien du SENS. Un hote qui garde la cle `impeccable` mais lui
    // met la note 1 et le drapeau negatif faisait partir
    // « host_review_guest_positive_neat_and_tidy » sur un avis severe. Et
    // l'inverse — garder `pas_fait` en le notant 5 — emettait un tag negatif
    // qui, par la regle de la derniere ligne, effacait tous les tags positifs
    // legitimes d'un avis flatteur.
    //
    // On compare donc le niveau de l'hote a celui du defaut : meme drapeau
    // negatif, et meme note. Au moindre ecart, ce critere n'emet aucun tag —
    // l'avis part sans etiquette plutot qu'avec une etiquette fausse.
    const nivOrigine = (origine.niveaux || []).find(n => n.cle === niv.cle)
    if (!nivOrigine) continue
    if (Boolean(nivOrigine.negatif) !== Boolean(niv.negatif)) continue
    if (nivOrigine.note !== niv.note) continue

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
