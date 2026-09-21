// lib/fermetures.js — LES FERMETURES DE L'HOTE (lot 4.6.2).
// SEUL WRITER AUTORISE de la table `fermetures`.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, §4, §5, §7-A et §7-B.
// Migration : migrations/2026-09-21-fermetures.sql
// DOC : docs/kb/coeur-de-donnees.md (modif = MEME COMMIT)
//
// UNE FERMETURE : un stop-sell EN DUR, pose par l'hote pour verrouiller une
// periode — debut, fin, raison. Travaux, usage personnel, indisponibilite.
//
// ⚠ CE N'EST PAS UNE SECONDE SOURCE DE VERITE. « Une nuit n'a qu'une seule
// reponse a : suis-je vendable ? » — et cette reponse vit dans
// `calendar_inventory.stop_sell`. Une fermeture est ce qui ECRIT cette
// intention (par le writer unique du calendrier, `ecrireCalendrier`), et qui
// porte en plus le POURQUOI et les BORNES que la memoire, ligne a ligne, ne
// sait pas dire. Ce module ne decide donc JAMAIS de la vendabilite : il pose
// l'objet, il rend les segments a ecrire. La porte HTTP fait le reste, avec
// le writer.
//
// ⚠ CE N'EST PAS UNE yield_exception. Les exceptions sont des declarations
// sur le PASSE, pour sortir des mois de la reference du moteur. Les fermetures
// portent sur l'AVENIR et la VENTE. Deux tables. Le pont entre les deux est
// dans `nuitsFermees` : une fermeture passee est exclue de la reference comme
// une exception — sans qu'on ait a la recopier dans l'autre table.
//
// ⚠ CHANGEMENT DE DESSIN DU 21 SEPTEMBRE 2026 (Thierry) : UNE FERMETURE EST
// UN OBJET MANIPULE COMME UNE RESERVATION. Creee par le parcours « nouvelle
// reservation » (type « indisponible »), affichee comme une barre foncee dans
// le calendrier, MODIFIEE A LA MAIN par l'hote seul — dates et raison, comme
// il modifierait une reservation. AUCUNE app ne la modifie, jamais : ni Yield,
// ni le calendrier lui-meme. L'arbitrage « une reouverture scinde la
// fermeture » du 19 septembre est ANNULE : rouvrir une nuit couverte est
// REFUSE, et l'hote est renvoye vers la modification de la fermeture.
// Ce module ne sait donc que : lire, creer, modifier, supprimer.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
const RAISON_MAX = 200
// ⚠ BORNE D'AMPLITUDE — relevee en review. Sans elle, une fermeture
// 2026-01-01 -> 2999-12-31 (la paire par defaut du GET, facile a copier) etait
// acceptee, puis le writer enumerait 355 000 nuits pour l'upsert et l'ARI. Deux
// ans et demi de travaux, c'est deja beaucoup ; on refuse, on ne tronque pas.
const NUITS_MAX = 1000

// ⚠ UN JOUR QUI EXISTE, pas seulement qui a la forme : « 2026-02-30 » passait
// la regex, `nuitsEntre` rendait NaN, et c'est la base qui refusait — en 503
// « fermetures illisibles » pour une simple erreur de saisie (re-review).
const estJour = v => {
  if (!JOUR_RE.test(String(v || ''))) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
const periodeValide = (debut, fin) => estJour(debut) && estJour(fin) && fin >= debut
const nuitsEntre = (debut, fin) => Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / 86400000) + 1

// Arithmetique de jours EN UTC sur des jours ISO : aucun fuseau n'entre en jeu.
function decaler (jour, n) {
  const d = new Date(`${jour}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ─── Lecture : les fermetures d'un bien qui CROISENT une periode ─────────────
// ⚠ CROISEMENT, PAS INCLUSION (meme regle que les exceptions) : une fermeture
// du 1er au 30 doit ressortir quand on interroge la seule semaine du 15 au 21.
// ⚠ `user_id` N'EST PAS LU : ces lignes partent telles quelles au calendrier,
// qui retire deliberement `user_id` des biens (« il ne ressort pas »). Le
// cloisonnement se fait dans le WHERE des ecritures, jamais par relecture.
const COLONNES = 'id, property_id, date_debut, date_fin, raison, created_at'

// ⚠ TABLE ABSENTE = AUCUNE FERMETURE, ET CE N'EST PAS UNE ERREUR. Constate sur
// staging le 21 septembre 2026 : deploye avant que la migration soit collee,
// `joursExclus` levait, et TOUT le radar yield repondait 500 « lecture
// impossible ». Or une table qui n'existe pas ne peut contenir aucune
// fermeture : rendre vide est EXACT, pas indulgent. Seule une vraie panne de
// lecture (timeout, refus) leve — un vide par erreur, la, ouvrirait a tort.
// PostgREST dit PGRST205 (schema cache), Postgres 42P01 (relation absente).
const TABLE_ABSENTE_RE = /PGRST205|42P01|schema cache|does not exist/i
function tableAbsente (error) {
  return !!error && (error.code === 'PGRST205' || error.code === '42P01' ||
    (TABLE_ABSENTE_RE.test(error.message || '') && /fermetures/.test(error.message || '')))
}
let absenceDite = false
function direAbsence () {
  if (absenceDite) return
  absenceDite = true
  console.warn('[fermetures] table absente : la migration 2026-09-21-fermetures.sql n est pas appliquee — aucune fermeture, rien n est bloque')
}

async function fermeturesDuBien (supabase, propertyId, debut, fin) {
  if (!supabase || !UUID_RE.test(String(propertyId || ''))) {
    throw new Error('[fermetures] supabase et propertyId (uuid) requis')
  }
  if (!periodeValide(debut, fin)) throw new Error('[fermetures] periode invalide')
  const { data, error } = await supabase.from('fermetures')
    .select(COLONNES)
    .eq('property_id', propertyId)
    .lte('date_debut', fin).gte('date_fin', debut)
    .order('date_debut')
  // ⚠ UNE LECTURE EN ECHEC LEVE, elle ne rend pas « aucune fermeture » : le
  // canal interne s'en sert pour NE PAS ouvrir — un vide par erreur ouvrirait.
  // Sauf la table absente : la, vide est la verite.
  if (tableAbsente(error)) { direAbsence(); return [] }
  if (error) throw new Error(`[fermetures] lecture : ${error.message}`)
  return data || []
}

// Plusieurs biens en UNE requete, groupes par bien — c'est ce que le GET du
// calendrier consomme a chaque relecture (releve en review : une requete par
// bien, a chaque glisser-deposer). Chaque bien demande a sa cle, meme vide.
async function fermeturesDesBiens (supabase, propertyIds, debut, fin) {
  const ids = [...new Set(propertyIds || [])]
  if (!supabase || !ids.length || !ids.every(id => UUID_RE.test(String(id)))) {
    throw new Error('[fermetures] supabase et une liste d uuid requis')
  }
  if (!periodeValide(debut, fin)) throw new Error('[fermetures] periode invalide')
  const { data, error } = await supabase.from('fermetures')
    .select(COLONNES)
    .in('property_id', ids)
    .lte('date_debut', fin).gte('date_fin', debut)
    .order('date_debut')
  if (tableAbsente(error)) { direAbsence(); const vide = {}; for (const id of ids) vide[id] = []; return vide }
  if (error) throw new Error(`[fermetures] lecture : ${error.message}`)
  const parBien = {}
  for (const id of ids) parBien[id] = []
  for (const f of data || []) (parBien[f.property_id] || (parBien[f.property_id] = [])).push(f)
  return parBien
}

// Les nuits couvertes par au moins une fermeture, sur une periode. C'est ce
// que la capacite et le canal consomment : un Set de jours ISO.
// ⚠ ON N'ENUMERE QUE L'INTERSECTION AVEC LA PERIODE DEMANDEE, ET ON NE TRONQUE
// JAMAIS (re-review) : une nuit absente du Set est une nuit que le canal
// interne peut OUVRIR. La longueur d'une fermeture est bornee par la base
// (CHECK de la migration) ; une periode demandee absurde est refusee, pas
// coupee.
const SANITE = 100000
function nuitsFermees (fermetures, debut, fin) {
  const out = new Set()
  for (const f of fermetures || []) {
    let j = f.date_debut < debut ? debut : f.date_debut
    const stop = f.date_fin > fin ? fin : f.date_fin
    let n = 0
    while (j <= stop) {
      if (++n > SANITE) throw new Error(`[fermetures] periode demesuree : ${debut} -> ${fin}`)
      out.add(j); j = decaler(j, 1)
    }
  }
  return out
}

// ─── Ecriture : poser une fermeture ──────────────────────────────────────────
// Rend la ligne creee ET les segments que la porte doit passer au writer :
// `stop_sell: true` sur la periode. La porte ecrit ; ce module ne touche pas
// `calendar_inventory`.
async function creerFermeture (supabase, { userId, propertyId, debut, fin, raison }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) {
    return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  }
  if (!periodeValide(debut, fin)) {
    return { ok: false, raison: 'periode_invalide', message: 'La fin doit être le même jour que le début, ou après.' }
  }
  if (nuitsEntre(debut, fin) > NUITS_MAX) {
    return { ok: false, raison: 'periode_trop_longue', message: `Une fermeture couvre au plus ${NUITS_MAX} nuits. Coupez-la en plusieurs.` }
  }
  const texte = String(raison == null ? '' : raison).trim().slice(0, RAISON_MAX)
  if (!texte) return { ok: false, raison: 'raison_manquante', message: 'Dites pourquoi vous fermez : c\'est ce que le calendrier affichera sur la période.' }

  // ⚠ UNE NUIT N'APPARTIENT QU'A UNE SEULE FERMETURE — releve en review. Deux
  // fermetures qui se chevauchent, et retirer l'une rouvrait des nuits que
  // l'autre dit fermees : l'objet et la memoire en desaccord, dans le sens
  // interdit. On refuse le chevauchement ; les morceaux d'une scission sont
  // disjoints par construction, donc l'invariant tient partout.
  let existantes
  try { existantes = await fermeturesDuBien(supabase, propertyId, debut, fin) }
  catch (e) { return { ok: false, raison: 'lecture_impossible', message: `Fermetures illisibles, rien n'a été fermé : ${e.message}` } }
  if (existantes.length) {
    const f = existantes[0]
    return { ok: false, raison: 'chevauchement', message: `Ces dates croisent déjà la fermeture du ${f.date_debut} au ${f.date_fin} (« ${f.raison} »). Retirez-la ou choisissez d'autres dates.` }
  }

  const { data, error } = await supabase.from('fermetures')
    .insert({ user_id: userId, property_id: propertyId, date_debut: debut, date_fin: fin, raison: texte })
    .select('id, property_id, date_debut, date_fin, raison, created_at').single()
  // ⚠ LA LECTURE CI-DESSUS NE TIENT PAS SOUS CONCURRENCE (deux onglets, un
  // double clic) : c'est la contrainte d'EXCLUSION de la migration qui tient,
  // et son refus (23P01) est le meme chevauchement, dit par la base.
  if (error && (error.code === '23P01' || /fermetures_sans_chevauchement/.test(error.message || ''))) {
    return { ok: false, raison: 'chevauchement', message: 'Ces dates croisent une fermeture posée à l\'instant. Rechargez le calendrier.' }
  }
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Enregistrement impossible : ${error.message}` }
  return { ok: true, fermeture: data, segments: [{ date_from: debut, date_to: fin, stop_sell: true }] }
}

// ─── Ecriture : retirer une fermeture ────────────────────────────────────────
// ⚠ RETIRER ROUVRE TOUTE LA PERIODE, et c'est assume. Une nuit que l'hote avait
// fermee a la main AVANT de poser la fermeture par-dessus redevient vendable
// avec elle : la fermeture l'englobait, son retrait la libere. Le calendrier le
// dit au moment du retrait ; s'il veut garder une nuit fermee, il la referme.
async function supprimerFermeture (supabase, { userId, propertyId, id }) {
  if (!UUID_RE.test(String(id || ''))) return { ok: false, raison: 'parametres_invalides', message: 'Fermeture inconnue.' }
  // ⚠ LE COMPTE ET LE BIEN DANS LE WHERE, pas seulement dans la garde de la
  // porte : une requete qui ne porte pas son cloisonnement finit recopiee dans
  // un contexte qui n'en a plus.
  const { data, error } = await supabase.from('fermetures')
    .delete().eq('id', id).eq('user_id', userId).eq('property_id', propertyId)
    .select('id, date_debut, date_fin, raison')
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Retrait impossible : ${error.message}` }
  if (!data || !data.length) return { ok: false, raison: 'introuvable', message: 'Cette fermeture n\'existe plus.' }
  const f = data[0]
  // ⚠ ON NE ROUVRE QUE CE QU'AUCUNE AUTRE FERMETURE NE COUVRE (re-review). En
  // regime normal il n'y en a pas d'autre (chevauchement refuse) ; mais si une
  // scission a laisse un doublon (DELETE en echec apres les inserts), retirer
  // l'un des jumeaux ne doit pas rouvrir des nuits que l'autre dit fermees.
  // Retirer les deux rouvre tout : l'etat se repare par le geste normal.
  // Une relecture en echec ne rouvre RIEN : mieux vaut une periode restee
  // fermee, que l'hote voit, qu'une nuit vendue contre une fermeture.
  let restantes
  try { restantes = await fermeturesDuBien(supabase, propertyId, f.date_debut, f.date_fin) }
  catch (e) {
    return { ok: true, fermeture: f, segments: [], avertissement: `Fermeture retirée, mais la période n'a pas été rouverte (fermetures illisibles : ${e.message}). Rouvrez-la depuis le calendrier.` }
  }
  const couvertes = nuitsFermees(restantes, f.date_debut, f.date_fin)
  const toutes = nuitsFermees([f], f.date_debut, f.date_fin)
  const segments = plagesDepuisNuits([...toutes].filter(j => !couvertes.has(j))).map(p => ({ ...p, stop_sell: false }))
  const out = { ok: true, fermeture: f, segments }
  if (couvertes.size) out.avertissement = `${couvertes.size} nuit(s) restent fermées par une autre fermeture.`
  return out
}

// ─── Des nuits aux plages ────────────────────────────────────────────────────
// Un ensemble de jours ISO -> des plages contigues [{ date_from, date_to }].
function plagesDepuisNuits (nuits) {
  const tri = [...new Set([...(nuits || [])].filter(estJour))].sort()
  const out = []
  let debut = null, prec = null
  for (const j of tri) {
    if (debut && j === decaler(prec, 1)) { prec = j; continue }
    if (debut) out.push({ date_from: debut, date_to: prec })
    debut = j; prec = j
  }
  if (debut) out.push({ date_from: debut, date_to: prec })
  return out
}

// ─── Ecriture : MODIFIER une fermeture (dates, raison) ──────────────────────
// Le seul chemin par lequel une fermeture change : la main de l'hote, par la
// fiche. Rend les segments que la porte passe au writer : `stop_sell: true`
// sur les nuits AJOUTEES, `stop_sell: false` sur les nuits RETIREES — sauf
// celles qu'une autre fermeture couvre encore (comme au retrait).
async function modifierFermeture (supabase, { userId, propertyId, id, debut, fin, raison }) {
  if (!UUID_RE.test(String(id || '')) || !UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) {
    return { ok: false, raison: 'parametres_invalides', message: 'Fermeture inconnue.' }
  }
  if (!periodeValide(debut, fin)) {
    return { ok: false, raison: 'periode_invalide', message: 'La fin doit être le même jour que le début, ou après.' }
  }
  if (nuitsEntre(debut, fin) > NUITS_MAX) {
    return { ok: false, raison: 'periode_trop_longue', message: `Une fermeture couvre au plus ${NUITS_MAX} nuits. Coupez-la en plusieurs.` }
  }
  const texte = String(raison == null ? '' : raison).trim().slice(0, RAISON_MAX)
  if (!texte) return { ok: false, raison: 'raison_manquante', message: 'Dites pourquoi vous fermez : c\'est ce que le calendrier affichera sur la période.' }

  const { data: lue, error: eLire } = await supabase.from('fermetures')
    .select(COLONNES).eq('id', id).eq('user_id', userId).eq('property_id', propertyId).maybeSingle()
  if (eLire) return { ok: false, raison: 'lecture_impossible', message: `Fermetures illisibles, rien n'a été modifié : ${eLire.message}` }
  if (!lue) return { ok: false, raison: 'introuvable', message: 'Cette fermeture n\'existe plus.' }
  // Une COPIE : l'ancien etat sert au calcul des nuits apres l'update, et un
  // client qui rendrait le meme objet muterait la reference.
  const avant = { ...lue }

  // UNE lecture sur l'union des deux periodes (ancienne et nouvelle) sert aux
  // deux usages : le chevauchement avec une AUTRE fermeture (refuse ici pour
  // le message, tenu par la contrainte d'exclusion sous concurrence) et les
  // nuits retirees qu'une autre couvre encore.
  let autres
  try {
    const u0 = debut < avant.date_debut ? debut : avant.date_debut
    const u1 = fin > avant.date_fin ? fin : avant.date_fin
    autres = (await fermeturesDuBien(supabase, propertyId, u0, u1)).filter(f => f.id !== id)
  } catch (e) { return { ok: false, raison: 'lecture_impossible', message: `Fermetures illisibles, rien n'a été modifié : ${e.message}` } }
  const voisines = autres.filter(f => f.date_debut <= fin && f.date_fin >= debut)
  if (voisines.length) {
    const f = voisines[0]
    return { ok: false, raison: 'chevauchement', message: `Ces dates croisent déjà la fermeture du ${f.date_debut} au ${f.date_fin} (« ${f.raison} »). Retirez-la ou choisissez d'autres dates.` }
  }

  const { data: apres, error } = await supabase.from('fermetures')
    .update({ date_debut: debut, date_fin: fin, raison: texte, updated_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', userId).eq('property_id', propertyId)
    .select(COLONNES).single()
  if (error && (error.code === '23P01' || /fermetures_sans_chevauchement/.test(error.message || ''))) {
    return { ok: false, raison: 'chevauchement', message: 'Ces dates croisent une fermeture posée à l\'instant. Rechargez le calendrier.' }
  }
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Modification impossible : ${error.message}` }
  // Ce qu'on a DEMANDE fait foi, pas ce que le client rend (un client qui
  // rendrait l'ancienne ligne ferait croire que rien n'a change).
  const fermeture = { ...avant, ...(apres || {}), date_debut: debut, date_fin: fin, raison: texte }

  // Les nuits qui entrent se ferment ; celles qui sortent rouvrent, sauf si
  // une autre fermeture les couvre encore (relecture en echec : on ne rouvre
  // rien, on le dit).
  const anciennes = nuitsFermees([avant], avant.date_debut, avant.date_fin)
  const nouvelles = nuitsFermees([{ date_debut: debut, date_fin: fin }], debut, fin)
  const ajoutees = [...nouvelles].filter(j => !anciennes.has(j))
  let retirees = [...anciennes].filter(j => !nouvelles.has(j))
  const out = { ok: true, avant, fermeture, segments: [] }
  if (retirees.length) {
    const couvertes = nuitsFermees(autres, avant.date_debut, avant.date_fin)
    const encore = retirees.filter(j => couvertes.has(j))
    retirees = retirees.filter(j => !couvertes.has(j))
    if (encore.length) out.avertissement = `${encore.length} nuit(s) restent fermées par une autre fermeture.`
  }
  out.segments = [
    ...plagesDepuisNuits(ajoutees).map(p => ({ ...p, stop_sell: true })),
    ...plagesDepuisNuits(retirees).map(p => ({ ...p, stop_sell: false }))
  ]
  return out
}

module.exports = {
  fermeturesDuBien,
  fermeturesDesBiens,
  nuitsFermees,
  creerFermeture,
  modifierFermeture,
  supprimerFermeture,
  plagesDepuisNuits,
  RAISON_MAX,
  NUITS_MAX
}
