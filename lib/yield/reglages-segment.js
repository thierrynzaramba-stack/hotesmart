// lib/yield/reglages-segment.js — CE QUE L'HOTE DECIDE D'UN CONTEXTE.
// Etape 4 de YieldFlow. Spec : docs/specs/spec-yieldflow-v1.md §6 quater.
// SEUL WRITER AUTORISE de la table `yield_segment_reglages`.
//
// Deux reponses a la meme question, donc une seule table :
//   - a quel NIVEAU ce contexte se positionne (prioritaire sur le calcul)
//   - ce contexte COMPTE-T-IL pour ce bien
//
// ⚠ L'AJUSTEMENT DE L'HOTE EST PRIORITAIRE SUR LE CALCUL, ET C'EST LE SUJET.
// Le moteur positionne en mesurant une mediane : c'est une estimation. L'hote,
// lui, SAIT. S'il place la Toussaint a « Haut » quand le calcul dit « Moyen »,
// c'est lui qui a raison — il connait une demande que son historique ne montre
// pas encore. Le calcul reste visible a cote, pour qu'on puisse constater
// l'ecart plutot que de le subir.
//
// ⚠ UNE ABSENCE DE LIGNE VAUT « ACTIF, POSITION CALCULEE ». L'hote n'a rien a
// faire pour que les vacances et les feries comptent : seul un geste explicite
// ecrit ici. Un defaut inverse aurait rendu le moteur muet a l'installation.

const { NIVEAUX, AMPLITUDE_MAX } = require('./suggestion')

const TABLE = 'yield_segment_reglages'
const SEGMENT_MAX = 120
const NIVEAUX_VALIDES = NIVEAUX.map(n => n.nom)

// ⚠ DEUX CRANS DE PART ET D'AUTRE, PAS PLUS — la meme borne que le pipeline.
// Au-dela, l'hote ne deplace plus un contexte : il en invente un autre, et la
// grille compte cinq niveaux — un decalage de quatre les traverserait tous.
// La contrainte CHECK de la table est plus large (±4) : elle borne l'absurde,
// celle-ci borne l'utile.
const CRANS_MAX = AMPLITUDE_MAX
// La largeur maximale de la zone d'influence, en week-ends (la maquette, et la
// contrainte yield_reglages_weekends_bornes).
const WEEKENDS_MAX = 4

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function valider (r) {
  const segment = String(r?.segment ?? '').trim()
  if (!segment) throw new Error('[yield-reglages] segment requis')
  if (segment.length > SEGMENT_MAX) {
    throw new Error(`[yield-reglages] segment trop long (${SEGMENT_MAX} maximum)`)
  }
  // ⚠ `null` ET `undefined` SONT DEUX INTENTIONS DIFFERENTES ICI.
  // `crans: null` veut dire « retire mon ajustement, remesure » ; l'absence du
  // champ veut dire « ne touche pas a mon ajustement ». Les confondre
  // effacerait un reglage a chaque fois que l'ecran n'envoie que `actif`.
  const ajuste = Object.prototype.hasOwnProperty.call(r || {}, 'crans')
  let crans = null
  if (ajuste && r.crans != null) {
    const n = Number(r.crans)
    if (!Number.isInteger(n)) {
      throw new Error(`[yield-reglages] crans doit etre un entier : ${r.crans}`)
    }
    if (Math.abs(n) > CRANS_MAX) {
      throw new Error(`[yield-reglages] crans hors bornes : ${n}` +
        ` (${-CRANS_MAX} a +${CRANS_MAX})`)
    }
    crans = n
  }
  const bascule = Object.prototype.hasOwnProperty.call(r || {}, 'actif')
  if (bascule && typeof r.actif !== 'boolean') {
    throw new Error('[yield-reglages] actif doit etre vrai ou faux')
  }
  // ⚠ LA LARGEUR DE LA ZONE D'INFLUENCE (lot 2 « Ce qui fait bouger vos prix ») :
  // combien de week-ends avant et apres l'evenement, 0 a 4. Meme convention que
  // `crans` — `null` retire le reglage, l'absence du champ n'y touche pas.
  const largeurs = {}
  for (const c of ['weekends_avant', 'weekends_apres']) {
    if (!Object.prototype.hasOwnProperty.call(r || {}, c)) continue
    if (r[c] == null) { largeurs[c] = null; continue }
    const n = Number(r[c])
    if (!Number.isInteger(n) || n < 0 || n > WEEKENDS_MAX) {
      throw new Error(`[yield-reglages] ${c} hors bornes : ${r[c]} (0 a ${WEEKENDS_MAX})`)
    }
    largeurs[c] = n
  }
  return { segment, ajuste, crans, bascule, actif: bascule ? r.actif : null, largeurs }
}

/** Les reglages d'un bien, indexes par cle de segment. */
async function reglagesDuBien (supabase, propertyId) {
  if (!supabase || !propertyId) {
    throw new Error('[yield-reglages] supabase et propertyId requis')
  }
  // ⚠ `*` ET NON LA LISTE DES COLONNES, et c'est voulu : les deux colonnes de
  // largeur (migration 2026-11-05) n'existent pas tant que la migration n'est
  // pas collee. Les nommer ferait lever CETTE lecture — donc le moteur de prix
  // de tous les biens — dans l'intervalle. Absentes, elles se lisent `undefined`.
  const { data, error } = await supabase
    .from(TABLE).select('*')
    .eq('property_id', propertyId)
  // ⚠ UNE LECTURE QUI ECHOUE LEVE, elle ne rend pas un objet vide. Rendre
  // « aucun reglage » ferait reapparaitre une date desactivee et ignorerait un
  // ajustement — deux fois le contraire de ce que l'hote a demande, en silence.
  if (error) throw new Error(`[yield-reglages] lecture : ${error.message}`)
  const parSegment = new Map()
  for (const l of data || []) parSegment.set(l.segment, l)
  return parSegment
}

/**
 * Pose ou met a jour UN reglage.
 * ⚠ LE BIEN EST CONFRONTE AU COMPTE — meme garde qu'au writer des evenements,
 * et pour la meme raison : rien ne relie `user_id` a `property_id` en base, et
 * les deux chemins de lecture ne se cadrent pas sur la meme colonne.
 */
async function poserReglage (supabase, options = {}) {
  const { userId, propertyId } = options
  if (!supabase) throw new Error('[yield-reglages] supabase requis')
  if (!userId || !propertyId) {
    throw new Error('[yield-reglages] userId et propertyId requis')
  }
  if (!UUID_RE.test(String(propertyId))) {
    throw new Error('[yield-reglages] propertyId invalide')
  }
  const v = valider(options)
  const { data: bien, error: eBien } = await supabase
    .from('properties').select('id, user_id').eq('id', propertyId).maybeSingle()
  if (eBien) throw new Error(`[yield-reglages] lecture du bien : ${eBien.message}`)
  if (!bien) throw new Error('[yield-reglages] bien introuvable')
  if (String(bien.user_id) !== String(userId)) {
    throw new Error('[yield-reglages] bien hors du compte')
  }

  const existant = (await reglagesDuBien(supabase, propertyId)).get(v.segment) || null
  const ligne = {
    user_id: userId,
    property_id: propertyId,
    segment: v.segment,
    // ⚠ ON NE REECRIT QUE CE QUI EST ENVOYE. Le champ absent garde sa valeur :
    // basculer `actif` ne doit pas effacer un ajustement pose la semaine
    // derniere.
    crans: v.ajuste ? v.crans : (existant ? existant.crans : null),
    actif: v.bascule ? v.actif : (existant ? existant.actif : true),
    updated_at: new Date().toISOString()
  }
  // ⚠ LES LARGEURS N'ENTRENT DANS LA LIGNE QUE SI ELLES DISENT QUELQUE CHOSE —
  // envoyees, ou deja posees. Les ecrire toujours (a `null`) ferait echouer
  // TOUT reglage en crans tant que la migration n'est pas collee : la colonne
  // n'existe pas encore.
  for (const c of ['weekends_avant', 'weekends_apres']) {
    if (Object.prototype.hasOwnProperty.call(v.largeurs, c)) ligne[c] = v.largeurs[c]
    else if (existant && existant[c] != null) ligne[c] = existant[c]
  }
  const sansLargeur = ligne.weekends_avant == null && ligne.weekends_apres == null

  // ⚠ UNE LIGNE NEUTRE NE SE STOCKE PAS. « Actif, aucun ajustement » est
  // exactement le defaut : la garder ferait une ligne qui ne dit rien, et
  // l'ecran afficherait « reglage » sur un segment que l'hote n'a pas reglé.
  // Une largeur posee n'est pas neutre : la ligne la porte, elle reste.
  if (ligne.crans == null && ligne.actif === true && sansLargeur) {
    if (existant) {
      const { error } = await supabase.from(TABLE).delete().eq('id', existant.id)
      if (error) throw new Error(`[yield-reglages] retrait : ${error.message}`)
    }
    return { segment: v.segment, crans: null, actif: true, retire: true }
  }

  const { data, error } = existant
    ? await supabase.from(TABLE).update(ligne).eq('id', existant.id).select().single()
    : await supabase.from(TABLE).insert(ligne).select().single()
  if (error) throw new Error(`[yield-reglages] ecriture : ${error.message}`)
  return { ...data, retire: false }
}

/**
 * LA CLE DE REGLAGE D'UN JOUR, de la plus fine a la plus large.
 *
 * ⚠ DEUX GRANULARITES, ET ELLES NE SERVENT PAS LA MEME CHOSE.
 * Le SEGMENT du moteur reste large (`ferie`) pour que l'echantillon tienne :
 * eclater les feries en onze segments donnerait deux nuits chacun. Mais l'hote
 * veut ajuster « la Toussaint », pas « tous les feries ». On lui offre donc une
 * cle FINE (`ferie:toussaint`) qui ne sert qu'a l'ajustement, et qui l'emporte
 * sur la cle large quand les deux existent.
 */
function clesDeReglage (s) {
  if (!s || !s.segment) return []
  const cles = []
  // Un evenement ou une date commerciale porte deja sa cle fine.
  if (String(s.segment).includes(':')) return [s.segment]
  // Un ferie ou un pont se nomme par son libelle.
  if ((s.segment === 'ferie' || s.segment === 'pont') && s.libelle) {
    cles.push(`${s.segment}:${normaliser(s.libelle)}`)
  }
  // Les vacances portent deja un `detail` (`vacances_zone_du_bien:toussaint`).
  if (s.detail && s.detail !== s.segment) cles.push(s.detail)
  cles.push(s.segment)
  return cles
}

function normaliser (t) {
  return String(t || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * Le reglage applicable a un jour : le PLUS FIN qui porte un ajustement.
 * ⚠ UNE LIGNE QUI NE PORTE QU'UNE LARGEUR (lot 2 : `weekends_avant/apres`,
 * crans au calcul, actif) N'EST PAS UN AJUSTEMENT : elle ne masque pas les
 * crans d'une cle plus large. Sans ce saut, poser « 2 week-ends avant » sur
 * `vacances_zone_du_bien:noel` effacait en silence le +1 cran pose sur toutes
 * les vacances, pour les seules nuits de Noel (constat de review du 2c).
 * Une ligne neutre etait supprimee a l'ecriture avant le lot 2 : la sauter
 * garde le sens qu'elle avait, celui de l'absence.
 */
function reglagePour (reglages, s) {
  if (!reglages || typeof reglages.get !== 'function') return null
  for (const cle of clesDeReglage(s)) {
    const r = reglages.get(cle)
    if (r && (r.actif === false || (r.crans !== null && r.crans !== undefined))) return { ...r, cle }
  }
  return null
}

module.exports = {
  TABLE,
  SEGMENT_MAX,
  CRANS_MAX,
  WEEKENDS_MAX,
  NIVEAUX_VALIDES,
  valider,
  reglagesDuBien,
  poserReglage,
  clesDeReglage,
  normaliser,
  reglagePour
}
