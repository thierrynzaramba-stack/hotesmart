// lib/avis/resume.js — LE WRITER UNIQUE de `resume_bien_avis`.
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §10.
//
// Les trois chiffres de la page Avis — la note, les avis recus, la proprete —
// sont des donnees NON URGENTES (regle d'architecture du depot) : ils se
// calculent ici, deux fois par jour et apres un geste de l'hote sur la page
// (decision Q3 de Thierry, 10 novembre 2026), et l'ecran les LIT.
//
// ⚠ AUCUNE REGLE N'EST RECOPIEE. La population (`avisQuiComptent` et
// `OR_VOYAGEUR_A_ECRIT`), les periodes (`PERIODES`, `borneDepuis`) et la
// conversion sur 5 (`microSurCinq`) sont IMPORTEES des modules qui servent
// aujourd'hui l'ecran (`ratioProprete`, `notesDuPerimetre`). Deux chiffres
// calcules differemment pour la meme chose finiraient par se contredire, et
// la page Avis diffuserait l'un pendant que l'accueil diffuse l'autre.
//
// ⚠ UNE SEULE LECTURE PAR COMPTE, LES QUATRE PERIODES EN UNE PASSE. La
// population de la proprete (« le voyageur a ecrit ») CONTIENT celle de la
// note (une note > 0 suffit a « avoir ecrit ») : une lecture de la premiere
// rend donc les deux, et les periodes ne sont que des bornes sur
// `received_at`. Lire periode par periode coutait 4 x 5 requetes par compte.
//
// ⚠ IL N'ECRIT RIEN QUAND IL NE SAIT PAS. Une lecture qui echoue laisse les
// lignes d'avant en place, avec LEUR heure : l'ecran montre des chiffres
// vieux et le dit, plutot que des chiffres faux sans le dire. Une lecture
// INCOMPLETE (plafond atteint) ecrit des `null` avec le motif
// `lecture_incomplete` — jamais un zero, qui se lirait comme un fait.

const { avisQuiComptent, borneDepuis, PERIODES } = require('../stats-avis')
const { microSurCinq, sonnerSourcesInconnues, arrondiDixiemes } = require('./echelle')
const { OR_VOYAGEUR_A_ECRIT } = require('./naissance')

const PAGE = 1000
// Le meme plafond que la lecture des notes (`MAX_NOTES`, lib/stats-avis.js) :
// au-dela, la lecture se DIT incomplete, elle ne s'arrete pas en silence.
const MAX_AVIS = 50000
const MAX_BIENS = 5000
const VERDICTS = ['positif', 'remarque', 'rien_signale']
const MOTIF_INCOMPLET = 'lecture_incomplete'

// ⚠ PAGINATION PAR CURSEUR SUR `id`, comme `notesDuPerimetre` et pour la meme
// raison : `ota_reviews.id` est un uuid ALEATOIRE, et le poll Channex, le
// webhook ou un hote qui confirme une detection inserent ou font entrer des
// lignes PENDANT la lecture. Un decalage (`range`) sauterait alors des lignes
// reelles ; un curseur n'en saute aucune et n'en compte aucune deux fois.
//
// ⚠ LE COMPTE EXACT EST DEMANDE AVEC LA PREMIERE PAGE : c'est la seule facon
// de distinguer « fin des donnees » de « db-max-rows a rogne ».
async function lireParCurseur (requete, { max }) {
  const lignes = []
  let total = null
  let curseur = null
  for (;;) {
    let q = requete(curseur == null)
    if (curseur != null) q = q.gt('id', curseur)
    const { data, error, count } = await q.limit(PAGE)
    if (error) return { erreur: error }
    if (curseur == null && Number.isFinite(count)) total = count
    const page = data || []
    lignes.push(...page)
    if (page.length < PAGE) break
    curseur = page[page.length - 1].id
    if (lignes.length >= max) break
  }
  const incomplete = total != null ? lignes.length < total : lignes.length >= max
  return { lignes, total, incomplete }
}

function vide () {
  return { total: 0, positif: 0, remarque: 0, rien_signale: 0, notes: 0, notes_micro: 0 }
}

/**
 * Calcule les chiffres d'un compte et remplace ses lignes de `resume_bien_avis`.
 *
 * @param sb               client Supabase en cle de service (injectable)
 * @param opts.userId      OBLIGATOIRE. La cle de service contourne la RLS : ce
 *                         filtre est la seule defense (REVIEW.md regle 1).
 * @param opts.maintenant  horloge injectable. C'est l'heure de la LECTURE, donc
 *                         `calcule_le` : un calcul qui a lu plus tot ne peut
 *                         pas ecraser un calcul qui a lu plus tard.
 * @param opts.echelle     table des echelles, injectable (lib/avis/echelle.js).
 * @param opts.alarme      alarme des sources inconnues, injectable.
 * @param opts.aBlanc      calcule sans ecrire.
 *
 * @returns { ecrit, lignes, motif?, erreur?, incomplet? }
 */
async function calculerResumeAvis (sb, opts = {}) {
  const { userId, maintenant = Date.now(), echelle, alarme, aBlanc = false } = opts
  if (!userId) throw new Error('calculerResumeAvis : userId requis')
  const calculeLe = new Date(maintenant).toISOString()

  // Les biens du compte, ARCHIVES COMPRIS : leurs avis restent dans la note
  // globale (decision de Thierry du 3 novembre 2026). Un bien sans avis
  // recoit ses lignes a zero — un zero CALCULE est un fait.
  const biens = await lireParCurseur(() => sb.from('properties')
    .select('id, provider_property_id')
    .eq('user_id', userId)
    .not('provider_property_id', 'is', null)
    .order('id', { ascending: true }), { max: MAX_BIENS })
  if (biens.erreur) {
    console.error('[avis/resume] lecture des biens echec:', biens.erreur.message)
    return { ecrit: false, erreur: 'biens' }
  }

  const avis = await lireParCurseur((premiere) => avisQuiComptent(
    sb.from('ota_reviews').select('id, ota, overall_score, property_id_ref, ai_clean_verdict, received_at',
      premiere ? { count: 'exact' } : undefined), userId)
    .or(OR_VOYAGEUR_A_ECRIT)
    .order('id', { ascending: true }), { max: MAX_AVIS })
  if (avis.erreur) {
    console.error('[avis/resume] lecture des avis echec:', avis.erreur.message)
    return { ecrit: false, erreur: 'avis' }
  }

  const periodes = Object.keys(PERIODES)
  const bornes = periodes.map(p => {
    const b = borneDepuis(p, maintenant)
    return b == null ? null : Date.parse(b)
  })

  // ref -> [compteurs par periode], dans l'ordre de `periodes`.
  const parRef = new Map()
  const compteurs = (ref) => {
    let c = parRef.get(ref)
    if (!c) { c = periodes.map(vide); parRef.set(ref, c) }
    return c
  }
  for (const b of biens.lignes) compteurs(String(b.provider_property_id))

  const incomplet = avis.incomplete || biens.incomplete
  if (!incomplet) {
    for (const a of avis.lignes) {
      // La colonne est NOT NULL (migrations/2026-09-02-ota-reviews.sql) : une
      // ligne sans reference ne peut pas exister. Si elle existait, elle ne
      // serait rangee dans aucun bien — et aucune ligne de resume ne la porte.
      if (a.property_id_ref == null) continue
      // ⚠ `received_at` EST NULLABLE, et `NULL >= x` vaut NULL : un avis sans
      // date n'appartient qu'a « toujours ». Meme regle que `ratioProprete`.
      const t = a.received_at ? Date.parse(a.received_at) : NaN
      const micro = microSurCinq(a.overall_score, a.ota, echelle)
      const verdict = VERDICTS.includes(a.ai_clean_verdict) ? a.ai_clean_verdict : null
      const c = compteurs(String(a.property_id_ref))
      for (let i = 0; i < periodes.length; i++) {
        if (bornes[i] != null && !(Number.isFinite(t) && t >= bornes[i])) continue
        const k = c[i]
        k.total++
        if (verdict) k[verdict]++
        if (micro != null) { k.notes++; k.notes_micro += micro }
      }
    }
  } else {
    console.error(`[avis/resume] lecture INCOMPLETE pour ${userId} : `
      + `${avis.lignes.length} avis lus sur ${avis.total == null ? '?' : avis.total}`)
  }

  const lignes = []
  for (const [ref, c] of parRef) {
    periodes.forEach((periode, i) => {
      lignes.push(incomplet
        ? { periode, property_id_ref: ref, total: null, positif: null, remarque: null,
            rien_signale: null, notes: null, notes_micro: null, motif_non_calculable: MOTIF_INCOMPLET }
        : { periode, property_id_ref: ref, ...c[i], motif_non_calculable: null })
    })
  }

  // ⚠ UNE SOURCE HORS TABLE SONNE, comme dans `notesDuPerimetre` : ses notes ne
  // comptent dans aucune moyenne, et sans alarme l'ecran se tairait.
  // ⚠ SAUF A BLANC (revue du lot, constat 5) : l'alarme ECRIT un incident et
  // peut prevenir le fondateur, et « a blanc » promet de n'ecrire nulle part.
  // Le registre des sources vues est quand meme vide, pour qu'un appel suivant
  // ne sonne pas pour ce que celui-ci a vu.
  await sonnerSourcesInconnues(aBlanc ? async () => {} : alarme)

  if (aBlanc) return { ecrit: false, aBlanc: true, lignes, calcule_le: calculeLe, ...(incomplet ? { incomplet: true } : {}) }

  // Le remplacement est ATOMIQUE et refuse un calcul perime : c'est la base
  // qui tranche, sous verrou (migrations/2026-11-10-resume-bien-avis.sql).
  const { data, error } = await sb.rpc('resume_bien_avis_remplacer', {
    p_user_id: userId, p_calcule_le: calculeLe, p_lignes: lignes
  })
  if (error) {
    // ⚠ LA MIGRATION ABSENTE N'EST PAS UNE PANNE, C'EST UNE ATTENTE : entre le
    // merge et le collage de la migration, la fonction n'existe pas. L'appelant
    // (le cron) ne doit pas alerter le fondateur toutes les 5 minutes pour ca —
    // une alarme qui crie pour du normal se fait couper (lecon de
    // lib/cron-revenus-derives.js). Le motif est donc DISTINCT.
    if (migrationAbsente(error)) {
      console.error('[avis/resume] fonction ou table absente : migration 2026-11-10-resume-bien-avis a appliquer')
      return { ecrit: false, erreur: 'migration_absente', lignes, calcule_le: calculeLe }
    }
    console.error('[avis/resume] ecriture echec:', error.message)
    return { ecrit: false, erreur: 'ecriture', lignes, calcule_le: calculeLe }
  }
  if (!data || data.ecrit !== true) {
    return { ecrit: false, motif: (data && data.motif) || 'refuse', lignes, calcule_le: calculeLe }
  }
  return { ecrit: true, lignes, calcule_le: calculeLe, ...(incomplet ? { incomplet: true } : {}) }
}

const MOTIF_PAS_ENCORE = 'pas_encore_calcule'

/**
 * LA LECTURE de l'ecran : les chiffres d'un perimetre, sommes depuis ses lignes.
 *
 * ⚠ LA SEULE AGREGATION A LA LECTURE, ET ELLE EST UNE ADDITION. Une ligne par
 * bien du perimetre : on additionne des comptes et des sommes de notes, puis on
 * arrondit UNE fois (`arrondiDixiemes`). Jamais une moyenne de moyennes : un
 * membre limite a deux biens sur quatre lit la somme de SES deux lignes.
 *
 * ⚠ UN BIEN DEMANDE SANS LIGNE REND « PAS ENCORE CALCULE », PAS UN ZERO. Un bien
 * qui vient d'arriver n'a pas encore ete vu par le calcul (au plus 5 minutes) :
 * l'additionner a zero ferait passer une absence pour un fait.
 *
 * @param opts.refs       `null` = tout le compte (references orphelines
 *                        comprises, comme la note globale d'aujourd'hui) ; sinon
 *                        le filtre du perimetre, TEL QUE LES AUTRES LECTURES LE
 *                        POSENT (`refsDuPerimetre` melange uuid et references :
 *                        les uuid ne designent aucune ligne, et c'est voulu).
 * @param opts.attendues  les references qui DOIVENT avoir une ligne — celles des
 *                        biens du perimetre. Une absence parmi elles rend « pas
 *                        encore calcule ». Liste vide : aucun bien a attendre,
 *                        donc aucune ligne veut dire zero. Omise : chaque
 *                        reference de `refs` est attendue.
 * @returns { total, positif, remarque, rien_signale, non_analyses, note_sur_5,
 *            notes, calcule_le, periode, depuis } | { periode, motif } | { periode, erreur: true }
 */
async function lireResumeAvis (sb, opts = {}) {
  const { userId, periode, refs = null } = opts
  const attendues = Array.isArray(opts.attendues) ? [...new Set(opts.attendues.map(String))] : null
  if (!userId) throw new Error('lireResumeAvis : userId requis')
  if (!Object.prototype.hasOwnProperty.call(PERIODES, periode)) throw new Error('lireResumeAvis : periode inconnue ' + periode)
  const demandees = Array.isArray(refs) ? [...new Set(refs.map(String))] : null
  if (demandees && !demandees.length) {
    return { total: 0, positif: 0, remarque: 0, rien_signale: 0, non_analyses: 0,
             note_sur_5: null, notes: 0, calcule_le: null, periode, depuis: null }
  }

  // ⚠ PAGINEE PAR CURSEUR, comme toute lecture qui peut depasser 1 000 lignes
  // (une par bien du compte) : PostgREST rognerait en silence.
  const lignes = []
  let curseur = null
  for (let p = 0; p < 50; p++) {
    let q = sb.from('resume_bien_avis')
      .select('property_id_ref, total, positif, remarque, rien_signale, notes, notes_micro, calcule_le, motif_non_calculable')
      .eq('user_id', userId).eq('periode', periode)
    if (demandees) q = q.in('property_id_ref', demandees)
    if (curseur != null) q = q.gt('property_id_ref', curseur)
    const { data, error } = await q.order('property_id_ref', { ascending: true }).limit(PAGE)
    if (error) {
      // Table absente : la migration n'est pas collee sur cette base. Pour
      // l'hote, c'est la meme chose qu'un compte jamais calcule — mais le log,
      // lui, le dit (revue du lot, constat 4).
      if (migrationAbsente(error)) {
        console.error('[avis/resume] table absente : migration 2026-11-10-resume-bien-avis a appliquer')
        return { periode, motif: MOTIF_PAS_ENCORE }
      }
      console.error('[avis/resume] lecture echec:', error.message)
      return { periode, erreur: true }
    }
    const page = data || []
    lignes.push(...page)
    if (page.length < PAGE) break
    curseur = page[page.length - 1].property_id_ref
  }

  const vues = new Set(lignes.map(l => String(l.property_id_ref)))
  const doivent = attendues || demandees
  if (doivent ? doivent.some(r => !vues.has(r)) : !lignes.length) return { periode, motif: MOTIF_PAS_ENCORE }
  if (!lignes.length) {
    // Aucun bien attendu, aucune ligne : un perimetre sans avis, donc zero.
    return { total: 0, positif: 0, remarque: 0, rien_signale: 0, non_analyses: 0,
             note_sur_5: null, notes: 0, calcule_le: null, periode, depuis: null }
  }
  const sansChiffre = lignes.find(l => l.motif_non_calculable != null)
  if (sansChiffre) return { periode, motif: sansChiffre.motif_non_calculable }

  const somme = (c) => lignes.reduce((s, l) => s + Number(l[c] || 0), 0)
  const total = somme('total')
  const positif = somme('positif')
  const remarque = somme('remarque')
  const rienSignale = somme('rien_signale')
  const notes = somme('notes')
  // ⚠ L'AGE D'UN CHIFFRE EST CELUI DE SA PARTIE LA PLUS VIEILLE : si un bien a
  // ete calcule plus tard que les autres, c'est l'heure la plus ancienne qui
  // s'affiche.
  const calculeLe = lignes.map(l => l.calcule_le).filter(Boolean).sort()[0] || null
  return {
    total, positif, remarque, rien_signale: rienSignale,
    non_analyses: Math.max(0, total - positif - remarque - rienSignale),
    note_sur_5: arrondiDixiemes(somme('notes_micro'), notes),
    notes,
    calcule_le: calculeLe,
    periode,
    depuis: calculeLe ? borneDepuis(periode, Date.parse(calculeLe)) : null
  }
}

// PostgREST : PGRST202 (fonction absente du cache de schema), PGRST205 (table
// absente) ; Postgres : 42883 (fonction), 42P01 (relation).
//
// ⚠ LA TABLE OU LA FONCTION, JAMAIS UNE COLONNE (revue du lot, constat 4). Une
// premiere version attrapait aussi « schema cache » et « does not exist » en
// clair — donc une COLONNE absente (42703, PGRST204) : un schema qui a derive
// passait pour une migration pas encore collee, le cron attendait en silence
// pour toujours et l'ecran disait « pas encore calcule » sans un mot au log.
// Seuls les CODES font foi ; le texte n'est lu que quand le code manque, et
// seulement sous la forme « relation … » / « function … ».
const CODES_MIGRATION_ABSENTE = new Set(['PGRST202', 'PGRST205', '42P01', '42883'])
const TEXTE_MIGRATION_ABSENTE_RE = /\b(relation|function) "?[\w.]*resume_bien_avis\w*"?(\([^)]*\))? does not exist|could not find the (function|table) '?[\w.]*resume_bien_avis/i
function migrationAbsente (error) {
  if (!error) return false
  if (error.code) return CODES_MIGRATION_ABSENTE.has(String(error.code))
  return TEXTE_MIGRATION_ABSENTE_RE.test(String(error.message || ''))
}

/**
 * Le recalcul APRES UN GESTE DE L'HOTE sur la page Avis — saisir un avis,
 * confirmer une detection, corriger une proprete (decision Q3 de Thierry,
 * 10 novembre 2026 : « l'hote voit son geste compte »).
 *
 * ⚠ IL NE LEVE JAMAIS, ET IL EST ATTENDU. Le geste est deja ecrit quand on
 * l'appelle : un echec du recalcul ne doit pas transformer un enregistrement
 * reussi en erreur 500 — les chiffres seront repris au creneau suivant, avec
 * leur heure. Et il est ATTENDU (`await`) par l'endpoint, parce qu'une fonction
 * Vercel peut etre figee des que la reponse est partie : un recalcul lance sans
 * attendre peut ne jamais s'executer.
 */
async function recalculerApresGeste (sb, userId, opts = {}) {
  try {
    const r = await calculerResumeAvis(sb, { ...opts, userId })
    // `perime` n'est pas un echec : un calcul plus recent existe deja.
    if (!r.ecrit && r.motif !== 'perime') {
      console.error('[avis/resume] recalcul apres geste non ecrit:', r.erreur || r.motif)
    }
    return r
  } catch (e) {
    console.error('[avis/resume] recalcul apres geste echec:', e && e.message)
    return { ecrit: false, erreur: 'exception' }
  }
}

module.exports = {
  calculerResumeAvis, recalculerApresGeste, lireResumeAvis, migrationAbsente,
  MOTIF_INCOMPLET, MOTIF_PAS_ENCORE, MAX_AVIS
}
