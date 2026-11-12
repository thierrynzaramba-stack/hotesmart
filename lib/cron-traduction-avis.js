// lib/cron-traduction-avis.js — la tache `traduction_avis` du cron.
// Spec : docs/specs/avis-v5/spec-traduction-avis.md §3.2 et §3.6.
//
// Vide la file `avis_a_traduire` (migrations/2026-11-11-avis-traductions.sql)
// par lots, en appelant le writer unique (lib/avis/traduction.js).
//
// ⚠ LE COUT EST UNE DECISION DE THIERRY (Q5 = A, 11 novembre 2026) :
//   - 10 appels a l'IA au plus par passage ;
//   - 100 appels au plus par jour (jour de Paris), toute la plateforme ;
//   - ZERO appel quand la file est vide : on la lit d'abord.
// Le compte du jour vit dans `cron_logs` (`traduction_avis_jour`) : `last_run`
// dit le jour, `total_messages` le nombre d'appels. Au plafond, la tache
// s'arrete jusqu'au lendemain et le dit dans son bilan — sans alerte : une
// traduction qui attend un jour n'est pas une panne.
//
// ⚠ UN APPEL QUI ECHOUE COMPTE QUAND MEME : c'est l'appel qui coute, pas son
// resultat. Et un avis en echec ne repasse qu'apres 24 h (meme empreinte) :
// sans cette attente, une reponse toujours refusee mangerait le plafond du
// jour a elle seule.

const traduction = require('./avis/traduction')

const MARQUEUR_JOUR = 'traduction_avis_jour'
const PAR_PASSAGE = 10
const PAR_JOUR = 100
// Budget mur propre, et le reste du cycle : le dispatch passe apres, et une
// traduction peut attendre cinq minutes, un message de bienvenue non.
const BUDGET_MS = 12000
const RESTE_MIN_MS = 25000
// La classification pose l'extrait de proprete ; on l'attend pour le traduire
// dans le meme appel. Un avis encore non classe apres 48 h est traduit sans
// attendre : une classification en echec ne bloque pas la traduction.
const ATTENTE_CLASSEMENT_MS = 48 * 3600 * 1000
const ATTENTE_ECHEC_MS = 24 * 3600 * 1000
// Un appel dure au plus 20 s dans le cron, et un appel qui n'a plus 3 s devant
// lui ne part pas (revue du lot, constat 1).
const TIMEOUT_APPEL_MS = 20000
const TIMEOUT_MIN_MS = 3000
// Au-dela de 3 000 caracteres (public + prive + extrait), la traduction ne
// tient pas dans un appel de cron : l'avis attend le script.
const LONGUEUR_MAX = 3000
// Trois echecs sur le meme texte : l'avis sort de la file (un texte qui change
// y revient). Sans cette borne, un avis toujours refuse couterait un appel par
// jour, pour toujours (revue du lot, constat 2).
const ECHECS_MAX = 3

const jourDeParis = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(ms))

/**
 * Un passage. Rend un bilan, ne leve jamais.
 *
 * @param results le bilan du cycle de cron (`errors` alerte le fondateur)
 * @param deps    { supabase, now, resteMs, traduire, anthropic } — injectables
 */
async function traduireAvisDus (results, deps = {}) {
  const sb = deps.supabase || require('./cron-shared').supabase
  const maintenant = deps.now || (() => Date.now())
  const resteMs = deps.resteMs || (() => Infinity)
  const traduire = deps.traduire || traduction.traduireLigne
  const erreur = (msg) => results?.errors?.push({ context: 'traduction_avis', error: msg })

  const bilan = { lus: 0, traduits: 0, echecs: 0, appels: 0, appels_jour: 0 }

  // 1. Le compte du jour.
  const { data: marqueur, error: errMarqueur } = await sb.from('cron_logs')
    .select('last_run, total_messages').eq('id', MARQUEUR_JOUR).maybeSingle()
  if (errMarqueur) {
    erreur('marqueur du jour illisible : ' + errMarqueur.message)
    return { ...bilan, skipped: 'marqueur_illisible' }
  }
  const aujourdhui = jourDeParis(maintenant())
  const memeJour = marqueur && marqueur.last_run && jourDeParis(Date.parse(marqueur.last_run)) === aujourdhui
  const dejaFaits = memeJour && Number.isFinite(marqueur.total_messages) ? Math.max(0, marqueur.total_messages) : 0
  bilan.appels_jour = dejaFaits
  if (dejaFaits >= PAR_JOUR) return { ...bilan, skipped: 'plafond_jour' }
  if (resteMs() < RESTE_MIN_MS) return { ...bilan, skipped: 'temps' }

  // 2. La file, bornee par ce qui reste du plafond. Vide : zero appel.
  const limite = Math.min(PAR_PASSAGE, PAR_JOUR - dejaFaits)
  const t0 = maintenant()
  const { data: file, error: errFile } = await sb.rpc('avis_a_traduire', {
    p_limite: limite,
    p_classe_avant: new Date(t0 - ATTENTE_CLASSEMENT_MS).toISOString(),
    p_echec_avant: new Date(t0 - ATTENTE_ECHEC_MS).toISOString(),
    // Un avis trop long pour un passage reste au script (revue, constat 1) ;
    // un avis qui echoue trois fois sur le meme texte sort de la file (constat 2).
    p_longueur_max: LONGUEUR_MAX,
    p_echecs_max: ECHECS_MAX
  })
  if (errFile) {
    if (traduction.migrationAbsente(errFile)) {
      if (results) results.traductionAvisEnAttente = 'migration_absente'
      return { ...bilan, skipped: 'migration_absente' }
    }
    erreur('file illisible : ' + errFile.message)
    return { ...bilan, skipped: 'file_illisible' }
  }
  const lignes = Array.isArray(file) ? file.slice(0, limite) : []
  bilan.lus = lignes.length
  if (!lignes.length) return bilan

  // 3. ⚠ LE COMPTE DU JOUR EST RESERVE AVANT LE PREMIER APPEL (revue du lot,
  // constat 1). Un passage coupe par la plateforme pendant un appel n'ecrit
  // plus rien apres : sans reservation, l'appel paye ne serait jamais compte.
  // On reserve le lot entier, et on rend ce qui n'est pas parti a la fin.
  const ecrireCompte = async (total) => {
    const { error } = await sb.from('cron_logs').upsert({
      id: MARQUEUR_JOUR, last_run: new Date(maintenant()).toISOString(),
      total_messages: total, total_replies: 0, errors: []
    }, { onConflict: 'id' })
    return error || null
  }
  const reserve = dejaFaits + lignes.length
  const errReserve = await ecrireCompte(reserve)
  if (errReserve) {
    erreur('compte du jour NON ecrit : ' + errReserve.message)
    return { ...bilan, skipped: 'compte_non_ecrit' }
  }

  // 4. Les traductions, dans le budget du passage.
  const echeance = t0 + BUDGET_MS
  try {
    for (const ligne of lignes) {
      // ⚠ CHAQUE APPEL A SA DUREE BORNEE : son plafond propre, et le reste du
      // cycle moins le plancher laisse au dispatch. Un appel ne PART qu'avant
      // l'echeance du budget ; moins de quelques secondes devant lui, il ne part
      // pas : il serait coupe, et paye.
      const timeoutMs = Math.min(TIMEOUT_APPEL_MS, resteMs() - RESTE_MIN_MS)
      if (maintenant() > echeance || timeoutMs < TIMEOUT_MIN_MS) { bilan.interrompu = 'budget'; break }
      // ⚠ LA TENTATIVE EST NOTEE AVANT L'APPEL : coupe pendant l'appel, l'avis
      // reste ecarte 24 h au lieu de repasser en tete au passage suivant.
      const errTentative = await traduction.noterTentatives(sb, [ligne], { maintenant: maintenant() })
      if (errTentative) { erreur('tentative ' + ligne.id + ' : ' + errTentative.message); bilan.interrompu = 'ecriture'; break }
      let r
      try { r = await traduire(ligne, { ...deps, timeoutMs }) } catch (err) {
        r = { ok: false, motif: 'appel_en_echec', detail: String(err && err.message || err), appel: true }
      }
      if (r.appel !== false) bilan.appels++
      if (r.ok) {
        bilan.traduits++
        const errEcriture = await traduction.ecrireResultat(sb, ligne, r, { maintenant: maintenant() })
        if (errEcriture) erreur('ecriture ' + ligne.id + ' : ' + errEcriture.message)
      } else {
        // L'echec est deja ecrit : c'est la tentative.
        bilan.echecs++
        console.warn('[traduction-avis] echec', ligne.id, r.motif)
      }
    }
  } finally {
    // Ce qui a ete reserve et n'est pas parti est rendu. Un appel parti reste
    // compte, meme si la boucle a leve.
    if (dejaFaits + bilan.appels !== reserve) {
      const err = await ecrireCompte(dejaFaits + bilan.appels)
      if (err) erreur('compte du jour NON corrige : ' + err.message)
    }
  }
  bilan.appels_jour = dejaFaits + bilan.appels
  return bilan
}

module.exports = {
  traduireAvisDus, jourDeParis,
  MARQUEUR_JOUR, PAR_PASSAGE, PAR_JOUR, BUDGET_MS, RESTE_MIN_MS,
  ATTENTE_CLASSEMENT_MS, ATTENTE_ECHEC_MS, TIMEOUT_APPEL_MS, TIMEOUT_MIN_MS,
  LONGUEUR_MAX, ECHECS_MAX
}
