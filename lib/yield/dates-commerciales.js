// lib/yield/dates-commerciales.js — LES DATES QUE LE CALENDRIER OFFICIEL IGNORE.
// Etape 4 de YieldFlow. Spec : docs/specs/spec-yieldflow-v1.md §6 quater.
// DOC : docs/kb/evenements-yield.md (modif = MEME COMMIT)
//
// ⚠ CALCULEES, JAMAIS STOCKEES — meme traitement que les jours feries.
// Elles reviennent a date fixe chaque annee : les ecrire en base creerait une
// table a maintenir pour une information qu'une fonction rend en trois lignes,
// et un oubli d'import se traduirait par un segment disparu en silence.
//
// ⚠ POURQUOI ELLES EXISTENT. Le calendrier scolaire et les jours feries sont
// deux calendriers PUBLICS : ni l'un ni l'autre ne connait la Saint-Valentin,
// et aucun ne distingue le 31 decembre (qui n'est pas ferie) du 1er janvier
// (qui l'est). Or pour un gite, le reveillon est souvent la nuit la plus chere
// de l'annee, et la Saint-Valentin la deuxieme. Les laisser en « vacances de
// Noel » ou en « hors vacances » revient a noyer les deux nuits qui portent le
// plus de valeur dans la moyenne de celles qui en portent le moins.
//
// ⚠ ACTIVES PAR DEFAUT, DESACTIVABLES PAR BIEN. Un gite de montagne vit sa
// Saint-Valentin ; un meuble d'affaires en centre-ville, non. L'hote tranche,
// et son choix vit dans `yield_segment_reglages`.
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge.

const { estJourISO } = require('./capacite')
const { jourDeSemaine, JOURS_SEMAINE } = require('./reference')

const PREFIXE = 'commercial'

/**
 * ⚠ LA REGLE DU WEEK-END, EN UNE PHRASE :
 *
 *   Une date commerciale se fete la nuit de la DATE ELLE-MEME ; et si cette
 *   date tombe du LUNDI AU JEUDI, elle se fete AUSSI le samedi le plus proche.
 *
 * Pourquoi celle-la, et pas une autre. Un gite se vend a la nuit, et une
 * Saint-Valentin un mardi ne se fete pas un mardi : les voyageurs prennent le
 * samedi d'a cote. Mais le 14 lui-meme garde de la valeur — certains le fetent
 * le jour dit. On retient donc les DEUX nuits plutot que de choisir a la place
 * de l'hote.
 *
 * ⚠ LE SAMEDI LE PLUS PROCHE EST UNIQUE, on l'a verifie : depuis un lundi il
 * est a -2, depuis un mardi a -3, depuis un mercredi a +3, depuis un jeudi a
 * +2. Aucune egalite possible, donc aucune regle d'arbitrage a inventer — et
 * un moteur de prix se doit d'etre deterministe.
 *
 * ⚠ VENDREDI, SAMEDI, DIMANCHE : LA DATE SE SUFFIT. Elle est deja une nuit de
 * week-end ; lui adjoindre un second samedi etendrait l'evenement a deux
 * week-ends, ce qu'aucun voyageur ne fait.
 *
 * ⚠ ET ELLE NE VAUT PAS POUR LES REVEILLONS. Un 31 decembre se fete le
 * 31 decembre, quel que soit le jour de la semaine — c'est la date qui EST
 * l'evenement. Le drapeau `weekend_proche` le dit date par date.
 */
function samediLePlusProche (iso) {
  // ⚠ `JOURS_SEMAINE` COMMENCE AU DIMANCHE (indice 0), PAS AU LUNDI.
  // Ma premiere version supposait l'inverse et rendait des VENDREDIS : un
  // dimanche etait traite comme un lundi, un lundi comme un mardi. Verifie
  // dans la table plutot que suppose — c'est exactement le genre d'hypothese
  // qu'un test sur une seule annee n'aurait pas attrapee.
  const SAMEDI = JOURS_SEMAINE.indexOf('samedi')   // 6
  const j = JOURS_SEMAINE.indexOf(jourDeSemaine(iso))
  if (j < 0) return null
  // Du lundi (1) au jeudi (4) seulement : vendredi, samedi et dimanche sont
  // deja des nuits de week-end, la date s'y suffit.
  if (j < 1 || j > 4) return null
  const apres = SAMEDI - j          // lundi +5, mardi +4, mercredi +3, jeudi +2
  const avant = apres - 7           // lundi -2, mardi -3, mercredi -4, jeudi -5
  const pas = Math.abs(avant) <= apres ? avant : apres
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + pas)
  return d.toISOString().slice(0, 10)
}

// ⚠ LA LISTE EST COURTE ET NOMMEE, ET ELLE LE RESTE. Chaque ajout doit se
// justifier par « le calendrier officiel l'ignore ET cette nuit se vend
// autrement ». Tout le reste releve des evenements declares par l'hote.
const DATES = [
  {
    cle: 'saint_valentin',
    nom: 'Saint-Valentin',
    mois: 2,
    jour: 14,
    // La seule des trois ou la date se deplace dans l'usage.
    weekend_proche: true,
    quoi: 'Le calendrier officiel ne la voit pas, et pour un gite c’est souvent la nuit la plus chère de l’année après le réveillon.'
  },
  {
    cle: 'reveillon_nouvel_an',
    nom: 'Réveillon du Nouvel An',
    mois: 12,
    jour: 31,
    weekend_proche: false,
    quoi: 'Le 31 décembre n’est PAS un jour férié — c’est le 1er janvier qui l’est. Sans cette date, la nuit la plus chère de l’année compterait comme une nuit de vacances de Noël ordinaire.'
  },
  {
    cle: 'reveillon_noel',
    nom: 'Réveillon de Noël',
    mois: 12,
    jour: 24,
    weekend_proche: false,
    quoi: 'Le 24 au soir, pas le 25 : c’est la nuit du réveillon qui se vend, le jour de Noël étant déjà férié.'
  }
]

const cleSegment = cle => `${PREFIXE}:${cle}`

/**
 * Les occurrences d'une date commerciale sur une fenetre.
 * @returns {Array} [{ date, cle, segment, nom, principale }]
 *   `principale: false` designe le samedi rattache, pas la date elle-meme.
 */
function occurrences (definition, debut, fin) {
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) return []
  const out = []
  const a1 = Number(debut.slice(0, 4))
  const a2 = Number(fin.slice(0, 4))
  // Garde-fou : une fenetre de plus de deux siecles vient d'une erreur d'appel.
  if (a2 - a1 > 200) return []
  for (let a = a1; a <= a2; a++) {
    const iso = `${a}-${String(definition.mois).padStart(2, '0')}-${String(definition.jour).padStart(2, '0')}`
    if (!estJourISO(iso)) continue
    const dates = [{ date: iso, principale: true }]
    if (definition.weekend_proche) {
      const s = samediLePlusProche(iso)
      if (s) dates.push({ date: s, principale: false })
    }
    for (const d of dates) {
      if (d.date < debut || d.date > fin) continue
      out.push({
        date: d.date,
        cle: definition.cle,
        segment: cleSegment(definition.cle),
        nom: definition.nom,
        principale: d.principale
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * TOUTES les dates commerciales d'une fenetre, sous la forme que le contexte
 * de segmentation attend — les memes champs qu'un evenement de l'hote.
 *
 * @param {Object} options
 *   - desactivees  Set|Array des cles que l'hote a coupees pour ce bien
 */
function datesCommerciales (debut, fin, options = {}) {
  const { desactivees = null } = options
  const coupees = desactivees instanceof Set ? desactivees
    : new Set(Array.isArray(desactivees) ? desactivees : [])
  const out = []
  for (const d of DATES) {
    if (coupees.has(d.cle) || coupees.has(cleSegment(d.cle))) continue
    for (const o of occurrences(d, debut, fin)) {
      // ⚠ MEME FORME QU'UN EVENEMENT DE L'HOTE : le moteur traite les trois
      // familles a l'identique. Une seconde forme aurait fait une seconde
      // branche dans `segmenterJour`, donc deux regles a tenir d'accord.
      out.push({
        nom: o.nom,
        segment: o.segment,
        date_debut: o.date,
        date_fin: o.date,
        // ⚠ AUCUN PARENT PAR DEFAUT. Une date commerciale sans historique
        // garde le niveau que sa nuit aurait sans elle (le repli de
        // `suggerer`) : c'est plus juste qu'un parent decrete, qui perdrait
        // le jour de semaine.
        parent_segment: null,
        origine: 'commercial',
        cle: o.cle,
        principale: o.principale
      })
    }
  }
  return out.sort((a, b) => a.date_debut.localeCompare(b.date_debut))
}

module.exports = {
  PREFIXE,
  DATES,
  cleSegment,
  samediLePlusProche,
  occurrences,
  datesCommerciales
}
