// lib/yield/reglages-position.js — LE REGLAGE DE L'HOTE, NUIT PAR NUIT, PAR
// POSITION DANS UN EVENEMENT. Lot 2 « Ce qui fait bouger vos prix ».
// Spec : docs/specs/spec-yf-reglages-position.md
// SEUL WRITER AUTORISE de `yield_reglages_position` et de son journal.
// Ou tombe une ligne une annee donnee : lib/yield/positions.js (pur).
//
// ⚠ AUCUNE DATE N'EST ECRITE ICI. Une ligne dit « le 2e samedi des vacances de
// Noel », jamais « le 26 decembre 2026 » : c'est ce qui la reconduit (decision 8
// du registre, 30 octobre 2026). Thierry, 5 novembre 2026 : « pouvoir regler
// chaque jour separement ».
//
// ⚠ LA VALIDATION REPREND CELLE DE LA BASE (migrations/
// 2026-11-05-yield-reglages-position.sql). Elle vit aux deux endroits pour que
// l'ecran recoive un refus PARLANT, et pour que la regle tienne meme si un
// autre chemin ecrit un jour. Ce que les tests tiennent : chaque contrainte de
// la migration a son pendant NOMME ici, et les cas eprouves sur un Postgres
// embarque sont rejoues contre `validerPosition`. Ils ne prouvent pas que les
// deux disent la meme chose au-dela de ces cas.
// ⚠ UN ECART VOULU : l'ecrivain est PLUS STRICT que la base sur le samedi
// rattache. La base l'accepte sur toute date commerciale ; l'ecrivain, sur
// celles dont la definition en prevoit un (`weekend_proche`, la Saint-Valentin
// — jamais les reveillons). La liste vit dans lib/yield/dates-commerciales.js :
// la recopier dans une contrainte SQL serait une seconde liste a tenir d'accord.

const P = require('./positions')

const TABLE = 'yield_reglages_position'
const JOURNAL = 'yield_reglages_position_journal'
const EVENEMENT_MAX = 120
const RANG_EVENEMENT_MAX = 60
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLONNES = 'id, evenement, zone, rang, jour, nuit, niveau, updated_at'
const PAGE = 1000

const TABLE_ABSENTE_RE = /PGRST205|42P01|schema cache|does not exist/i
const tableAbsente = error => !!error && (error.code === 'PGRST205' || error.code === '42P01' ||
  (TABLE_ABSENTE_RE.test(error.message || '') && /yield_reglages_position/.test(error.message || '')))
let absenceDite = false

const refus = (raison, message) => ({ ok: false, raison, message })
const nul = v => v === undefined || v === null || v === ''

/**
 * PUR. Une position est-elle coherente ? Memes regles que les contraintes de
 * la table, dans le meme ordre de lecture.
 * @returns {{ ok: true, position } | { ok: false, raison, message }}
 */
function validerPosition (p = {}) {
  const evenement = String(p.evenement ?? '').trim()
  if (!evenement) return refus('evenement_requis', 'Événement requis.')
  if (evenement.length > EVENEMENT_MAX) return refus('evenement_trop_long', `Événement trop long (${EVENEMENT_MAX} caractères maximum).`)
  const zone = p.zone
  if (!P.ZONES.includes(zone)) return refus('zone_inconnue', 'Zone inconnue : dans l’événement, avant ou après.')
  const rang = nul(p.rang) ? null : Number(p.rang)
  const jour = nul(p.jour) ? null : String(p.jour)
  const nuit = nul(p.nuit) ? null : String(p.nuit)
  if (rang !== null && !Number.isInteger(rang)) return refus('rang_invalide', 'Rang invalide.')
  if (jour !== null && !P.JOURS.includes(jour)) return refus('jour_inconnu', 'Jour inconnu.')
  if (nuit !== null && !P.NUITS.includes(nuit)) return refus('nuit_inconnue', 'Nuit inconnue.')
  if (rang !== null) {
    const max = zone === 'evenement' ? RANG_EVENEMENT_MAX : P.RAYONNEMENT_MAX
    if (rang < 1 || rang > max) return refus('rang_hors_bornes', zone === 'evenement'
      ? `Rang hors bornes (1 à ${max}).` : `Le rayonnement compte de 1 à ${max} week-ends.`)
  }
  if (zone !== 'evenement' && jour !== null && !P.NUITS_WEEK_END.includes(jour)) {
    return refus('rayonnement_ven_sam', 'Le rayonnement ne porte que des nuits de vendredi et de samedi.')
  }
  if (zone === 'evenement' && rang !== null && jour === null) {
    return refus('rang_sans_jour', 'Un rang dans l’événement désigne un jour : « le 2e samedi ».')
  }
  if (nuit !== null && (zone !== 'evenement' || rang !== null || jour !== null)) {
    return refus('nuit_seule', 'La nuit de la date se désigne seule, dans l’événement.')
  }
  const dateFixe = P.estDateFixe(evenement)
  if (zone === 'evenement' && jour !== null && dateFixe) {
    return refus('date_fixe_sans_jour', 'Une date fixe se désigne par sa nuit, jamais par un jour de semaine.')
  }
  if (nuit !== null && !dateFixe) return refus('nuit_date_fixe', 'Une période n’a pas de « nuit de la date ».')
  if (nuit === 'samedi_rattache' && !/^commercial:/.test(evenement)) {
    return refus('samedi_rattache_commercial', 'Le samedi rattaché n’existe que pour les dates commerciales.')
  }
  if (nuit === 'samedi_rattache' && !P.aSamediRattache(evenement)) {
    return refus('sans_samedi_rattache', 'Cette date n’a jamais de samedi rattaché : c’est la date elle-même qui est l’événement.')
  }
  return { ok: true, position: { evenement, zone, rang, jour, nuit } }
}

/** Les lignes d'un bien, paginees par curseur (jamais tronquees a 1000). */
async function lignesDuBien (supabase, propertyId) {
  if (!supabase || !UUID_RE.test(String(propertyId || ''))) {
    throw new Error('[reglages-position] supabase et propertyId (uuid) requis')
  }
  const out = []
  let apres = null
  for (;;) {
    let q = supabase.from(TABLE).select(COLONNES).eq('property_id', propertyId)
    if (apres) q = q.gt('id', apres)
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGE)
    // ⚠ UNE TABLE ABSENTE N'EST PAS UNE PANNE DE LECTURE : la migration n'est
    // pas appliquee, il n'y a donc aucun reglage — on le dit une fois, et le
    // moteur continue. Toute AUTRE erreur leve : rendre « aucun reglage »
    // effacerait en silence ce que l'hote a pose.
    if (tableAbsente(error)) {
      if (!absenceDite) { absenceDite = true; console.warn('[reglages-position] table absente : la migration 2026-11-05-yield-reglages-position.sql n est pas appliquee — aucun reglage de position') }
      return []
    }
    if (error) throw new Error(`[reglages-position] lecture : ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
    apres = data[data.length - 1].id
  }
  return out
}

// La ligne existante a cette position exacte. Un NULL se cherche par `is`,
// jamais par `eq` (`= null` n'est jamais vrai en SQL).
async function lireExistante (supabase, propertyId, pos) {
  let q = supabase.from(TABLE).select(`${COLONNES}, user_id`)
    .eq('property_id', propertyId).eq('evenement', pos.evenement).eq('zone', pos.zone)
  for (const c of ['rang', 'jour', 'nuit']) q = pos[c] === null ? q.is(c, null) : q.eq(c, pos[c])
  return q.maybeSingle()
}

async function bienDuCompte (supabase, userId, propertyId) {
  const { data, error } = await supabase.from('properties').select('id, user_id').eq('id', propertyId).maybeSingle()
  if (error) return refus('lecture_impossible', `Lecture du logement impossible : ${error.message}`)
  if (!data) return refus('bien_introuvable', 'Logement introuvable.')
  if (String(data.user_id) !== String(userId)) return refus('bien_hors_compte', 'Ce logement n’appartient pas à ce compte.')
  return { ok: true }
}

async function tracer (supabase, l) {
  const { error } = await supabase.from(JOURNAL).insert(l)
  if (error) console.error(`[reglages-position] TRACE PERDUE (${l.geste} ${l.evenement}, bien ${l.property_id}) : ${error.message}`)
  return !error
}

// Les niveaux recommandes au moment du geste : { "2026-12-26": "Haut" }.
// Une valeur qui n'est pas un des cinq niveaux est ecartee, pas inventee.
function recommandesPropres (r) {
  if (!r || typeof r !== 'object') return null
  const out = {}
  for (const [j, n] of Object.entries(r)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(j) && P.NIVEAUX.includes(n)) out[j] = n
  }
  return Object.keys(out).length ? out : null
}

/**
 * Poser (ou remplacer) le niveau d'UNE position.
 * @param {Object} o — userId, propertyId, evenement, zone, rang, jour, nuit,
 *   niveau (les cinq, ou 'calcul'), recommandes ({ nuit: niveau } au moment du geste)
 * @returns {{ ok: true, geste, avant } | { ok: false, raison, message }}
 */
async function poserPosition (supabase, o = {}) {
  if (!supabase) throw new Error('[reglages-position] supabase requis')
  if (!UUID_RE.test(String(o.userId || '')) || !UUID_RE.test(String(o.propertyId || ''))) {
    return refus('parametres_invalides', 'Compte et logement requis.')
  }
  // ⚠ LE LOT 2 EXIGE UN NIVEAU. La colonne est nullable pour le lot 3 (une
  // ligne qui ne porterait qu'une restriction de sejour) ; ici, une ligne sans
  // niveau ne dirait rien.
  if (o.niveau !== P.CALCUL && !P.NIVEAUX.includes(o.niveau)) {
    return refus('niveau_inconnu', 'Niveau inconnu : Base, Moyen, Haut, Très haut ou Exceptionnel.')
  }
  const v = validerPosition(o)
  if (!v.ok) return v
  const pos = v.position
  const garde = await bienDuCompte(supabase, o.userId, o.propertyId)
  if (!garde.ok) return garde

  const { data: exist, error: eLu } = await lireExistante(supabase, o.propertyId, pos)
  if (eLu) return refus('ecriture_impossible', `Enregistrement impossible : ${eLu.message}`)
  if (exist && exist.user_id && String(exist.user_id) !== String(o.userId)) {
    return refus('conflit_compte', 'Ce réglage appartient à un autre compte : rien n’a été modifié.')
  }
  // L'etat d'avant se releve AVANT l'ecriture : c'est lui que le journal porte.
  const avant = exist ? exist.niveau : null
  const maintenant = new Date().toISOString()
  const { error } = exist
    ? await supabase.from(TABLE).update({ niveau: o.niveau, updated_at: maintenant }).eq('id', exist.id)
    : await supabase.from(TABLE).insert({ user_id: o.userId, property_id: o.propertyId, ...pos, niveau: o.niveau, updated_at: maintenant })
  // ⚠ DEUX GESTES CONCURRENTS sur la meme position : l'index unique refuse le
  // second insert. On le dit plutot que de reessayer a l'aveugle.
  if (error) return refus(error.code === '23505' ? 'geste_concurrent' : 'ecriture_impossible', error.code === '23505'
    ? 'Ce réglage vient d’être modifié ailleurs : rechargez, rien n’a été écrit.'
    : `Enregistrement impossible : ${error.message}`)
  const geste = exist ? 'remplacee' : 'posee'
  await tracer(supabase, { user_id: o.userId, property_id: o.propertyId, ...pos, geste,
    niveau: o.niveau, niveau_avant: avant, recommandes: recommandesPropres(o.recommandes) })
  return { ok: true, geste, avant }
}

/**
 * Retirer UNE position : la ligne disparait, les lignes plus larges reprennent
 * la nuit. ⚠ Ce n'est PAS « remettre en automatique » une nuit couverte par
 * un joker : ce geste-la POSE une ligne `calcul` (spec §2.4).
 */
async function retirerPosition (supabase, o = {}) {
  if (!supabase) throw new Error('[reglages-position] supabase requis')
  if (!UUID_RE.test(String(o.userId || '')) || !UUID_RE.test(String(o.propertyId || ''))) {
    return refus('parametres_invalides', 'Compte et logement requis.')
  }
  const v = validerPosition(o)
  if (!v.ok) return v
  const pos = v.position
  const garde = await bienDuCompte(supabase, o.userId, o.propertyId)
  if (!garde.ok) return garde
  const { data: exist, error: eLu } = await lireExistante(supabase, o.propertyId, pos)
  if (eLu) return refus('ecriture_impossible', `Retrait impossible : ${eLu.message}`)
  if (!exist) return { ok: true, geste: null, avant: null }
  if (exist.user_id && String(exist.user_id) !== String(o.userId)) {
    return refus('conflit_compte', 'Ce réglage appartient à un autre compte : rien n’a été modifié.')
  }
  const { error } = await supabase.from(TABLE).delete().eq('id', exist.id)
  if (error) return refus('ecriture_impossible', `Retrait impossible : ${error.message}`)
  await tracer(supabase, { user_id: o.userId, property_id: o.propertyId, ...pos, geste: 'retiree',
    niveau: null, niveau_avant: exist.niveau, recommandes: recommandesPropres(o.recommandes) })
  return { ok: true, geste: 'retiree', avant: exist.niveau }
}

module.exports = {
  TABLE,
  JOURNAL,
  EVENEMENT_MAX,
  RANG_EVENEMENT_MAX,
  validerPosition,
  lignesDuBien,
  poserPosition,
  retirerPosition
}
