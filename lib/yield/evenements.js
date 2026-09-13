// lib/yield/evenements.js — LES EVENEMENTS DECLARES PAR L'HOTE.
// Etape 4 de YieldFlow. Spec : docs/specs/spec-yieldflow-v1.md §6 ter.
// DOC : docs/kb/evenements-yield.md (modif = MEME COMMIT)
// SEUL WRITER AUTORISE de la table `yield_events`.
//
// A QUOI CA SERT. Le moteur connait les vacances scolaires et les jours
// feries — deux calendriers publics, les memes pour tout le monde. Il ignore
// tout de ce qui remplit CE logement-la : une saison thermale, un festival, un
// salon, une course cycliste. L'hote, lui, le sait depuis des annees.
//
// ⚠ UN EVENEMENT HOTE EST UN SEGMENT A PART ENTIERE, pas une etiquette.
// Il a sa propre reference des qu'il a l'historique, et il EMPRUNTE a son
// parent designe sinon — exactement la regle des ponts (spec §6 bis).
//
// ⚠ AUCUNE RECONDUCTION SILENCIEUSE — arbitrage de Thierry, 13 septembre 2026.
// Ce module PROPOSE la reconduction d'une annee sur l'autre ; il ne l'ecrit
// jamais de lui-meme. Un evenement mal date fausse le segment, et un segment
// faux est pire qu'un segment absent : absent, le moteur se tait et le dit ;
// faux, il suggere un prix avec aplomb.

const { estJourISO } = require('./capacite')
const { jourDeSemaine } = require('./reference')

const TABLE = 'yield_events'
const NOM_MAX = 80

// Les memes valeurs que la contrainte CHECK de la table : la regle vit aux
// deux endroits, pour qu'elle tienne meme si un jour un autre chemin ecrit.
const RECURRENCES = {
  FIXE: 'annuelle_fixe',
  AJUSTABLE: 'annuelle_ajustable',
  PONCTUELLE: 'ponctuelle'
}
const PARENTS_AUTORISES = ['ferie', 'pont', 'vacances_zone_du_bien',
  'vacances_autre_zone', 'hors_vacances']

// ⚠ UN EVENEMENT NE DURE PAS UN AN. Sans plafond, une saisie erronee
// (2026 → 2036) ferait de dix ans un seul segment, et toute la reference du
// bien basculerait dedans sans qu'aucun chiffre ne paraisse faux.
const DUREE_MAX_JOURS = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function ecartJours (a, b) {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/**
 * La cle de segment d'un evenement : stable d'une annee sur l'autre.
 *
 * ⚠ C'EST LE NOM QUI FAIT LE SEGMENT, PAS LA LIGNE. « Saison thermale 2025 »
 * et « Saison thermale 2026 » doivent alimenter LE MEME echantillon, sinon
 * chaque occurrence repartirait de zero et aucune n'atteindrait jamais le
 * seuil. On normalise donc le nom, et deux occurrences du meme evenement
 * partagent leur reference.
 */
function cleSegment (nom) {
  const propre = String(nom || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return propre ? `evenement:${propre}` : null
}

// ─── Validation, la meme des deux cotes ──────────────────────────────────────
function valider (e) {
  const nom = String(e?.nom ?? '').trim()
  if (!nom) throw new Error('[yield-events] nom requis')
  if (nom.length > NOM_MAX) {
    throw new Error(`[yield-events] nom trop long (${NOM_MAX} caracteres maximum)`)
  }
  if (!estJourISO(e?.debut) || !estJourISO(e?.fin) || e.fin < e.debut) {
    throw new Error(`[yield-events] periode invalide : ${e?.debut} -> ${e?.fin}`)
  }
  const duree = ecartJours(e.debut, e.fin) + 1
  if (duree > DUREE_MAX_JOURS) {
    throw new Error(`[yield-events] periode trop longue : ${duree} jours` +
      ` (${DUREE_MAX_JOURS} au maximum — un evenement n'est pas une saison entiere)`)
  }
  const rec = String(e?.recurrence ?? RECURRENCES.PONCTUELLE)
  if (!Object.values(RECURRENCES).includes(rec)) {
    throw new Error(`[yield-events] recurrence inconnue : ${rec}`)
  }
  const parent = e?.parent_segment ? String(e.parent_segment) : null
  if (parent && !PARENTS_AUTORISES.includes(parent)) {
    throw new Error(`[yield-events] parent inconnu : ${parent}`)
  }
  return { nom, debut: e.debut, fin: e.fin, recurrence: rec, parent }
}

// ─── Lecture : les evenements qui CROISENT une periode ───────────────────────
// ⚠ CROISEMENT, PAS INCLUSION — meme raison qu'aux exceptions. Un evenement de
// juin doit ressortir quand le moteur interroge la seule semaine du 15 au 21.
async function evenementsDuBien (supabase, propertyId, debut, fin) {
  if (!supabase || !propertyId) {
    throw new Error('[yield-events] supabase et propertyId requis')
  }
  // ⚠ UNE FENETRE INVALIDE LEVE, ELLE NE REND PAS UNE LISTE VIDE.
  // Rendre `[]` sur une borne mal formee ferait disparaitre les segments de
  // l'hote en silence : le moteur retomberait sur « hors vacances » et
  // suggererait des prix de basse saison en pleine saison thermale.
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) {
    throw new Error(`[yield-events] periode invalide : ${debut} -> ${fin}`)
  }
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, nom, date_debut, date_fin, recurrence, parent_segment, reconduit_de')
    .eq('property_id', propertyId)
    .lte('date_debut', fin)
    .gte('date_fin', debut)
    .order('date_debut')
  if (error) throw new Error(`[yield-events] lecture : ${error.message}`)
  return (data || []).map(l => ({ ...l, segment: cleSegment(l.nom) }))
}

/** TOUTES les occurrences d'un bien — pour proposer les reconductions. */
async function toutesLesOccurrences (supabase, propertyId) {
  if (!supabase || !propertyId) {
    throw new Error('[yield-events] supabase et propertyId requis')
  }
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, nom, date_debut, date_fin, recurrence, parent_segment, reconduit_de')
    .eq('property_id', propertyId)
    .order('date_debut')
  if (error) throw new Error(`[yield-events] lecture : ${error.message}`)
  return (data || []).map(l => ({ ...l, segment: cleSegment(l.nom) }))
}

// ─── Ecriture ────────────────────────────────────────────────────────────────
/**
 * ⚠ LE WRITER VERIFIE QUE LE BIEN APPARTIENT AU COMPTE — releve en review,
 * 13 septembre 2026, avant meme qu'un appelant existe.
 *
 * Le defaut n'etait pas theorique : `user_id` et `property_id` etaient ecrits
 * tels quels, et RIEN dans la base ne les relie — ni cle etrangere, ni
 * contrainte. Or les deux chemins de lecture ne se cadrent pas sur la meme
 * colonne : la policy RLS cadre le CLIENT sur `user_id`, tandis que le moteur
 * lit en service key en cadrant sur `property_id` seul. Une ligne dont les deux
 * divergent serait donc INVISIBLE du proprietaire legitime et pourtant utilisee
 * pour calculer ses prix. C'est exactement le genre d'incoherence qu'on ne
 * remarque jamais parce qu'aucun ecran ne la montre.
 *
 * ⚠ ET L'APPELANT NE CHOISIT NI L'UN NI L'AUTRE. L'endpoint devra prendre
 * `propertyId` dans `garde.bien.id` et `userId` dans `garde.accountUserId`,
 * jamais dans `req.body` — la garde a deja tranche a qui appartient le bien.
 * Cette verification-ci est la seconde barriere, pas la premiere.
 */
async function creerEvenement (supabase, options = {}) {
  const { userId, propertyId } = options
  if (!supabase) throw new Error('[yield-events] supabase requis')
  if (!userId || !propertyId) {
    throw new Error('[yield-events] userId et propertyId requis')
  }
  if (!UUID_RE.test(String(propertyId))) {
    throw new Error('[yield-events] propertyId invalide')
  }
  const { data: bien, error: eBien } = await supabase
    .from('properties').select('id, user_id').eq('id', propertyId).maybeSingle()
  if (eBien) throw new Error(`[yield-events] lecture du bien : ${eBien.message}`)
  if (!bien) throw new Error('[yield-events] bien introuvable')
  if (String(bien.user_id) !== String(userId)) {
    // Ni le message ni le code ne disent A QUI appartient le bien : ce serait
    // renseigner un appelant qui n'a rien a y faire.
    throw new Error('[yield-events] bien hors du compte')
  }
  const v = valider(options)
  const ligne = {
    user_id: userId,
    property_id: propertyId,
    nom: v.nom,
    date_debut: v.debut,
    date_fin: v.fin,
    recurrence: v.recurrence,
    parent_segment: v.parent,
    reconduit_de: options.reconduitDe && UUID_RE.test(String(options.reconduitDe))
      ? options.reconduitDe : null
  }
  const { data, error } = await supabase.from(TABLE).insert(ligne).select().single()
  if (error) {
    // ⚠ LE DOUBLON EST UNE ERREUR D'APPELANT, PAS UNE PANNE. Deux
    // confirmations de la meme reconduction sont un geste plausible : l'hote
    // doit lire « cet evenement existe deja », pas « service indisponible ».
    if (String(error.code) === '23505') {
      throw new Error(`[yield-events] doublon : « ${v.nom} » commence deja le ${v.debut}`)
    }
    throw new Error(`[yield-events] ecriture : ${error.message}`)
  }
  return { ...data, segment: cleSegment(data.nom) }
}

async function supprimerEvenement (supabase, { propertyId, id }) {
  if (!supabase || !propertyId || !id) {
    throw new Error('[yield-events] supabase, propertyId et id requis')
  }
  // ⚠ LA SUPPRESSION EST BORNEE AU BIEN DE LA GARDE. Sans `property_id`, un id
  // devine suffirait a effacer l'evenement d'un autre compte : la garde de
  // l'endpoint verifie le BIEN, c'est donc lui qui doit filtrer.
  const { data, error } = await supabase
    .from(TABLE).delete().eq('property_id', propertyId).eq('id', id).select('id')
  if (error) throw new Error(`[yield-events] suppression : ${error.message}`)
  return { supprimees: (data || []).length }
}

// ─── LA RECONDUCTION : PROPOSEE, JAMAIS ECRITE ───────────────────────────────

/**
 * Le n-ieme <jour de semaine> du mois d'une date — sa POSITION, pas sa date.
 * C'est ce qui se conserve pour un evenement « annuelle_ajustable » : un
 * festival du deuxieme week-end de juillet reste le deuxieme week-end.
 */
function positionDansLeMois (iso) {
  const jour = jourDeSemaine(iso)
  const premier = `${iso.slice(0, 7)}-01`
  let rang = 0
  for (let j = premier; j <= iso; j = decaler(j, 1)) {
    if (jourDeSemaine(j) === jour) rang++
  }
  return { jour, rang, mois: Number(iso.slice(5, 7)) }
}

/** La date de meme position l'annee suivante, ou null si elle n'existe pas. */
function memePositionAnneeSuivante (iso) {
  const { jour, rang, mois } = positionDansLeMois(iso)
  const an = Number(iso.slice(0, 4)) + 1
  const debut = `${an}-${String(mois).padStart(2, '0')}-01`
  const fin = new Date(Date.UTC(an, mois, 0)).toISOString().slice(0, 10)
  let vus = 0
  for (let j = debut; j <= fin; j = decaler(j, 1)) {
    if (jourDeSemaine(j) !== jour) continue
    vus++
    if (vus === rang) return j
  }
  // ⚠ LE RANG PEUT NE PAS EXISTER : un mois a quatre ou cinq occurrences d'un
  // meme jour. On ne rabat pas en silence sur la quatrieme — on rend `null` et
  // l'ecran demande a l'hote de trancher.
  return null
}

/**
 * LES RECONDUCTIONS A PROPOSER, jamais a ecrire.
 *
 * @param {Array}  occurrences  toutes les occurrences du bien
 * @param {Object} options      { aujourdHui, horizonJours }
 * @returns {Array} propositions { nom, recurrence, depuis, debut, fin, ... }
 */
function reconductionsAProposer (occurrences, options = {}) {
  const { aujourdHui, horizonJours = 365 } = options
  if (!estJourISO(aujourdHui)) return []
  const limite = decaler(aujourdHui, horizonJours)
  const parSegment = new Map()
  for (const e of occurrences || []) {
    const cle = cleSegment(e.nom)
    if (!cle) continue
    if (!parSegment.has(cle)) parSegment.set(cle, [])
    parSegment.get(cle).push(e)
  }

  const out = []
  for (const [cle, liste] of parSegment) {
    const triees = [...liste].sort((a, b) => a.date_debut.localeCompare(b.date_debut))
    const derniere = triees[triees.length - 1]
    if (derniere.recurrence === RECURRENCES.PONCTUELLE) continue
    // ⚠ ON PART DE LA DERNIERE OCCURRENCE, DONC ON NE PEUT PAS EN REPROPOSER
    // UNE QUI EXISTE. C'est la propriete qui evite le doublon, et elle suffit :
    // si l'edition 2027 est deja saisie, c'est ELLE la derniere, et la
    // proposition vise 2028.
    //
    // ⚠ UNE GARDE EXPLICITE VIVAIT ICI ET NE POUVAIT JAMAIS SE DECLENCHER —
    // trouvee par contre-epreuve, pas en relisant : je l'ai desarmee, et aucun
    // test n'est tombe. Elle testait « existe-t-il une occurrence posterieure a
    // la derniere ? », ce qui est faux par construction. Du code mort qui
    // rassure est pire que pas de code : on croit la regle tenue par lui.
    const anneeSuivante = Number(derniere.date_debut.slice(0, 4)) + 1

    let debut = null
    let fin = null
    let position = null
    if (derniere.recurrence === RECURRENCES.FIXE) {
      debut = `${anneeSuivante}-${derniere.date_debut.slice(5)}`
      // ⚠ LA FIN SE CALCULE PAR LA DUREE, PAS EN SUBSTITUANT L'ANNEE — releve
      // en review. Un evenement a cheval sur le 31 decembre (marche de Noel,
      // reveillon : le cas le plus plausible d'un recurrent) rendait
      // « 2026-12-28 → 2026-01-03 » : des dates INVERSEES, presentees comme
      // valides, pre-remplies dans le formulaire, et refusees en 400 au moment
      // de confirmer. L'hote n'avait aucun moyen de comprendre.
      fin = estJourISO(debut)
        ? decaler(debut, ecartJours(derniere.date_debut, derniere.date_fin)) : null
      // Le 29 fevrier n'existe pas tous les ans : on rend `null` plutot qu'un
      // 1er mars invente.
      if (!estJourISO(debut) || !estJourISO(fin)) { debut = null; fin = null }
    } else {
      debut = memePositionAnneeSuivante(derniere.date_debut)
      // La duree se conserve : c'est elle que l'hote a choisie.
      if (debut) {
        fin = decaler(debut, ecartJours(derniere.date_debut, derniere.date_fin))
        position = positionDansLeMois(derniere.date_debut)
      }
    }
    // Trop loin dans l'avenir : on ne saoule pas l'hote onze mois a l'avance.
    if (debut && debut > limite) continue
    // ⚠ ET JAMAIS DANS LE PASSE — releve en review. Seule la borne HAUTE etait
    // testee : un evenement de 2024 jamais reconduit faisait proposer son
    // edition 2025, sous le titre « leur prochaine edition approche ».
    // Confirmer aurait ecrit une occurrence revolue, qui repollue la reference
    // du bien — et `creerEvenement` n'interdit pas les dates passees, parce
    // qu'une occurrence PASSEE est precisement ce qui donne son historique a
    // un evenement. C'est donc ici que ça se tranche.
    if (debut && debut < aujourdHui) continue

    out.push({
      segment: cle,
      nom: derniere.nom,
      recurrence: derniere.recurrence,
      parent_segment: derniere.parent_segment || null,
      depuis: { id: derniere.id, debut: derniere.date_debut, fin: derniere.date_fin },
      debut,
      fin,
      position,
      // ⚠ « JE NE SAIS PAS PROPOSER » EST UNE REPONSE. Le 29 fevrier, ou un
      // cinquieme samedi qui n'existe pas l'annee suivante : on le DIT, et
      // l'hote saisit les dates lui-meme.
      non_calculable: debut ? null : (derniere.recurrence === RECURRENCES.FIXE
        ? 'date_absente_l_annee_suivante'
        : 'position_absente_l_annee_suivante')
    })
  }
  return out.sort((a, b) => String(a.debut || '9999').localeCompare(String(b.debut || '9999')))
}

module.exports = {
  TABLE,
  NOM_MAX,
  DUREE_MAX_JOURS,
  RECURRENCES,
  PARENTS_AUTORISES,
  cleSegment,
  valider,
  evenementsDuBien,
  toutesLesOccurrences,
  creerEvenement,
  supprimerEvenement,
  positionDansLeMois,
  memePositionAnneeSuivante,
  reconductionsAProposer
}
