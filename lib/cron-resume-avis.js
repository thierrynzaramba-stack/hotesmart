// lib/cron-resume-avis.js — QUAND les trois chiffres de la page Avis se calculent.
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §10.4.
//
// Le calcul lui-meme vit dans lib/avis/resume.js (writer unique). Ce module ne
// decide que du MOMENT, et il le fait de deux facons :
//
//   1. DEUX CRENEAUX PAR JOUR, 06:00 ET 18:00 HEURE DE PARIS. Un compte est
//      « du » tant que ses lignes sont plus anciennes que le dernier creneau
//      ouvert. La garde ne regarde pas l'heure du tick mais l'AGE DES LIGNES :
//      un creneau manque (cron en panne a 06:00, budget epuise) se rattrape
//      donc au tick suivant, sans fenetre d'une heure a ne pas rater.
//
//   2. LE LOGEMENT NEUF, A CHAQUE TICK (regle du depot : son premier calcul est
//      immediat, sinon sa fiche dit « non calcule » jusqu'au creneau suivant).
//      ⚠ SANS BALAYAGE A CHAQUE TICK : on compte les biens (une requete `head`,
//      servie par l'index), et on ne cherche les references sans ligne QUE si
//      ce nombre a bouge depuis le tick precedent. Quatre chemins posent
//      `provider_property_id` (api/channel-property.js, lib/cron-beds24-props.js,
//      lib/canaux-du-bien.js, lib/cles-migrees.js) : les surveiller tous
//      laisserait le cinquieme, a venir, sans calcul.
//
// ⚠ UN MARQUEUR DE CRENEAU, ET IL N'EST POSE QU'UNE FOIS LE CRENEAU FINI. Tant
// qu'il manque, chaque tick relit qui est a jour ; une fois pose, le tick coute
// une lecture. Un compte en echec ne bloque pas le creneau : il est signale UNE
// fois dans `results.errors`, et repris au creneau suivant — une alerte toutes
// les cinq minutes pendant douze heures serait une alarme qu'on coupe.

const { calculerResumeAvis } = require('./avis/resume')
const { heureDeParis } = require('./cron-revenus-derives')

const MARQUEUR_CRENEAU = 'resume_avis'
const MARQUEUR_BIENS = 'resume_avis_biens'
const CRENEAUX = [6, 18]
const HEURE_MS = 3600 * 1000
const PAGE = 1000
// Budget mur propre, et le reste du cycle : le dispatch passe APRES, et il ne
// doit jamais etre affame par un calcul qui peut attendre cinq minutes.
const BUDGET_MS = 10000
const RESTE_MIN_MS = 25000

/**
 * Le debut du dernier creneau ouvert a `instant` (ms), ou `null` si l'heure de
 * Paris est illisible.
 *
 * ⚠ L'HEURE DE PARIS, PAS L'UTC, et sans calcul de decalage a la main : les
 * fuseaux francais ont des decalages d'heures ENTIERES, donc une frontiere
 * d'heure UTC est une frontiere d'heure a Paris. On remonte heure par heure
 * jusqu'a tomber sur 06 ou 18 — l'heure d'ete se regle d'elle-meme, et le jour
 * du changement aussi.
 */
function debutDuCreneau (instant) {
  if (typeof instant !== 'number' || !Number.isFinite(instant)) return null
  const heure = Math.floor(instant / HEURE_MS) * HEURE_MS
  for (let k = 0; k <= 26; k++) {
    const h = heureDeParis(heure - k * HEURE_MS)
    if (h == null) return null
    if (CRENEAUX.includes(h)) return heure - k * HEURE_MS
  }
  return null
}

// ⚠ PAGINE PAR CURSEUR SUR LA COLONNE DONNEE. Une lecture Supabase sans borne
// est TRONQUEE A 1 000 LIGNES SANS ERREUR. Pour `resume_bien_avis`, le curseur
// porte sur `user_id` : on ne veut que l'ENSEMBLE des comptes, donc sauter la
// fin des lignes d'un compte deja vu ne perd rien.
async function lireTout (fabrique, colonne, valeur) {
  const vus = []
  let curseur = null
  for (let p = 0; p < 200; p++) {
    let q = fabrique()
    if (curseur != null) q = q.gt(colonne, curseur)
    const { data, error } = await q.order(colonne, { ascending: true }).limit(PAGE)
    if (error) return { erreur: error }
    const page = data || []
    for (const l of page) vus.push(valeur(l))
    if (page.length < PAGE) return { lignes: vus }
    curseur = page[page.length - 1][colonne]
  }
  return { erreur: { message: 'plus de 200 pages : lecture arretee' } }
}

const TABLE_ABSENTE_RE = /PGRST205|42P01|schema cache|does not exist/i
const tableAbsente = (e) => !!e && TABLE_ABSENTE_RE.test(`${e.code || ''} ${e.message || ''}`)

async function lireMarqueur (sb, id) {
  const { data, error } = await sb.from('cron_logs').select('last_run, total_messages').eq('id', id).maybeSingle()
  if (error) return { erreur: error }
  return { marqueur: data || null }
}

async function poserMarqueur (sb, id, lastRun, total) {
  const { error } = await sb.from('cron_logs').upsert({
    id, last_run: lastRun, total_messages: total, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  return error || null
}

/**
 * Un passage. Rend un bilan, ne leve jamais.
 *
 * @param results  le bilan du cycle de cron (`errors` alerte le fondateur)
 * @param deps     { supabase, now, resteMs, calculer } — injectables
 */
async function calculerResumesDus (results, deps = {}) {
  const sb = deps.supabase
  if (!sb) return { skipped: 'pas_de_client' }
  const maintenant = deps.now || (() => Date.now())
  const resteMs = deps.resteMs || (() => Infinity)
  const calculer = deps.calculer || calculerResumeAvis
  const t0 = maintenant()
  const bilan = { calcules: 0, echecs: 0, perimes: 0, budget_atteint: false, creneau: null, biens_neufs: 0 }

  const creneau = debutDuCreneau(t0)
  if (creneau == null) return { ...bilan, skipped: 'fuseau_illisible' }
  const creneauIso = new Date(creneau).toISOString()
  bilan.creneau = creneauIso

  const plusDeTemps = () => (maintenant() - t0 > BUDGET_MS) || resteMs() < RESTE_MIN_MS
  const echecs = []
  // ⚠ UN COMPTE N'EST TENTE QU'UNE FOIS PAR PASSAGE. Un compte en echec au
  // creneau n'a pas de lignes : sans ce registre, le controle des biens neufs
  // le prendrait pour un compte neuf et le retenterait dans le meme tick —
  // deux echecs, deux lignes d'alerte, pour une seule panne.
  const tentes = new Set()
  let enAttente = false

  // Un compte. `false` arrete le passage (budget, migration absente).
  // ⚠ `perime` N'EST PAS UN ECHEC : un calcul qui a lu APRES celui-ci existe
  // deja (un geste de l'hote, typiquement), donc le compte est a jour.
  async function un (userId) {
    if (tentes.has(userId)) return true
    if (plusDeTemps()) { bilan.budget_atteint = true; return false }
    tentes.add(userId)
    let r
    try { r = await calculer(sb, { userId }) } catch (e) { r = { ecrit: false, erreur: e && e.message } }
    if (r && r.ecrit) bilan.calcules++
    else if (r && r.motif === 'perime') bilan.perimes++
    else if (r && r.erreur === 'migration_absente') { enAttente = true; return false }
    else { bilan.echecs++; echecs.push(userId) }
    return true
  }

  // ─── 1. Le creneau ──────────────────────────────────────────────────────
  const lu = await lireMarqueur(sb, MARQUEUR_CRENEAU)
  if (lu.erreur) {
    results?.errors?.push({ context: 'resume_avis', error: 'marqueur: ' + lu.erreur.message })
    return { ...bilan, skipped: 'marqueur_illisible' }
  }
  const creneauFini = lu.marqueur?.last_run && Date.parse(lu.marqueur.last_run) >= creneau

  if (!creneauFini) {
    const comptes = await lireTout(() => sb.from('properties').select('user_id')
      .not('provider_property_id', 'is', null), 'user_id', l => l.user_id)
    if (comptes.erreur) {
      results?.errors?.push({ context: 'resume_avis', error: 'properties: ' + comptes.erreur.message })
      return { ...bilan, skipped: 'properties_illisibles' }
    }
    const aJour = await lireTout(() => sb.from('resume_bien_avis').select('user_id')
      .eq('periode', 'toujours').gte('calcule_le', creneauIso), 'user_id', l => l.user_id)
    if (aJour.erreur) {
      if (tableAbsente(aJour.erreur)) {
        if (results) results.resumeAvisEnAttente = 'migration_absente'
        return { ...bilan, skipped: 'migration_absente' }
      }
      results?.errors?.push({ context: 'resume_avis', error: 'resume: ' + aJour.erreur.message })
      return { ...bilan, skipped: 'resume_illisible' }
    }
    const faits = new Set(aJour.lignes)
    const dus = [...new Set(comptes.lignes)].filter(u => u && !faits.has(u)).sort()
    let fini = true
    for (const u of dus) {
      if (!(await un(u))) { fini = false; break }
    }
    if (enAttente) {
      if (results) results.resumeAvisEnAttente = 'migration_absente'
      return { ...bilan, skipped: 'migration_absente' }
    }
    if (fini) {
      const e = await poserMarqueur(sb, MARQUEUR_CRENEAU, creneauIso, bilan.calcules)
      if (e) results?.errors?.push({ context: 'resume_avis', error: 'marqueur non ecrit: ' + e.message })
    }
  }

  // ─── 2. Le logement neuf ────────────────────────────────────────────────
  if (!plusDeTemps()) {
    const { count, error: eC } = await sb.from('properties')
      .select('id', { count: 'exact', head: true })
      .not('provider_property_id', 'is', null)
    const lb = eC ? null : await lireMarqueur(sb, MARQUEUR_BIENS)
    if (eC || !Number.isFinite(count) || lb.erreur) {
      results?.errors?.push({ context: 'resume_avis', error: 'comptage des biens: ' + ((eC || lb?.erreur)?.message || 'compte absent') })
    } else if (lb.marqueur?.total_messages !== count) {
      const refs = await lireTout(() => sb.from('properties').select('id, user_id, provider_property_id')
        .not('provider_property_id', 'is', null), 'id', l => l)
      const avecLigne = refs.erreur ? null : await lireTout(() => sb.from('resume_bien_avis')
        .select('user_id, property_id_ref').eq('periode', 'toujours'), 'user_id', l => l)
      // ⚠ LE CURSEUR SUR `user_id` PEUT COUPER LES LIGNES D'UN COMPTE a la
      // frontiere d'une page (il faudrait plus de 1 000 biens pour un seul
      // compte). Le compte coupe paraitrait alors avoir un bien sans ligne, et
      // serait recalcule : un calcul de trop, jamais un de moins.
      if (refs.erreur || avecLigne.erreur) {
        const e = refs.erreur || avecLigne.erreur
        if (tableAbsente(e)) { if (results) results.resumeAvisEnAttente = 'migration_absente' }
        else results?.errors?.push({ context: 'resume_avis', error: 'biens neufs: ' + e.message })
      } else {
        const connues = new Set(avecLigne.lignes.map(l => `${l.user_id}|${l.property_id_ref}`))
        const comptesNeufs = [...new Set(refs.lignes
          .filter(b => !connues.has(`${b.user_id}|${String(b.provider_property_id)}`))
          .map(b => b.user_id))].sort()
        let tous = true
        for (const u of comptesNeufs) {
          const avant = bilan.calcules + bilan.perimes
          if (!(await un(u))) { tous = false; break }
          if (bilan.calcules + bilan.perimes > avant) bilan.biens_neufs++
        }
        if (enAttente) { if (results) results.resumeAvisEnAttente = 'migration_absente' }
        // ⚠ LE NOMBRE EST RETENU MEME SI UN COMPTE A ECHOUE, et c'est voulu :
        // sinon chaque tick le reprendrait et alerterait le fondateur toutes
        // les cinq minutes. L'echec part UNE fois dans `results.errors`, et le
        // creneau suivant recalcule le compte. Seul un passage INTERROMPU (le
        // budget) laisse le nombre d'avant, pour que le tick suivant finisse.
        else if (tous) {
          const e = await poserMarqueur(sb, MARQUEUR_BIENS, new Date(t0).toISOString(), count)
          if (e) results?.errors?.push({ context: 'resume_avis', error: 'marqueur biens non ecrit: ' + e.message })
        }
      }
    }
  }

  if (echecs.length) {
    results?.errors?.push({
      context: 'resume_avis',
      error: `${echecs.length} compte(s) non calcule(s) : ${echecs.slice(0, 5).join(', ')}`
    })
  }
  return bilan
}

module.exports = {
  calculerResumesDus, debutDuCreneau,
  MARQUEUR_CRENEAU, MARQUEUR_BIENS, CRENEAUX, BUDGET_MS, RESTE_MIN_MS
}
