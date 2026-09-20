// lib/canal-calendrier.js — LE CANAL INTERNE VERS LE CALENDRIER (lot 4.6.1).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, section 2.
// Writer : lib/calendrier-writer.js — DOC : docs/kb/coeur-de-donnees.md
//
// « Ouvre ces dates, pose ces prix. » C'est tout ce qu'une app sait dire au
// calendrier, et c'est LE chemin standard que toute future app HoteSmart
// empruntera — pas une tuyauterie du lot 4.6.
//
// ⚠ CE CANAL EST INTERNE, ET CE N'EST PAS UN DETAIL D'IMPLEMENTATION.
// La garde du §2 bis fait refuser par `api/calendar.js` tout segment portant
// un `rate` pour un bien yieldflow. Le moteur doit precisement ecrire ces
// prix-la. Si l'autorisation prenait la forme d'un champ du corps HTTP
// (`source: 'engine'`), n'importe quel appelant pourrait le poser : la garde
// tomberait par sa propre porte de service. Ce module est donc appele EN
// PROCESSUS — par le cron, par un script — jamais par une requete HTTP. Il
// n'a pas d'endpoint, et il ne doit jamais en avoir.
//
// ⚠ UN WRITER, DEUX PORTES, DEUX GARDES. `api/calendar.js` (la porte de
// l'hote) et ce module (la porte du moteur) appellent LE MEME
// `ecrireCalendrier` : plancher, relecture, fusion, upsert, poussee ARI,
// plafonnement du stock, reaffirmation du stop_sell, journal, verdict. Rien
// n'est recopie. Ce qui differe, c'est la garde a l'entree : l'hote ne peut
// pas tarifer un bien pilote ; le moteur ne peut tarifer QUE lui.
//
// ⚠ CE QUE CE CANAL NE SAIT PAS ENCORE (4.6.2) : « Yield ne touche JAMAIS une
// fermeture de l'hote ». Aujourd'hui une fermeture est un `stop_sell = true`
// indistinguable d'une fermeture calculee ; l'objet fermeture (debut, fin,
// raison) arrive au 4.6.2, et c'est lui que ce canal consultera avant
// d'ouvrir. D'ici la, ce canal N'OUVRE PAS une nuit deja fermee en base : il
// la laisse telle quelle et le dit. C'est plus strict que la regle finale,
// jamais moins.

const { ecrireCalendrier } = require('./calendrier-writer')
const { pilotParYield, finDeFenetre } = require('./pilote-tarifaire')
const { estRelieAuCanal } = require('./rate-sync')

// Le vocabulaire du contrat. Une demande est une liste de nuits, chacune
// disant ce qu'elle veut — et rien d'autre. Pas de `stop_sell`, pas de
// `avail` bruts : le canal traduit, le writer execute.
//   { date: 'YYYY-MM-DD', ouvrir?: true, prix_centimes?: number }
const ORIGINE = 'engine'

function jourISO (v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null
}

// ─── LES REFUS DU CANAL ─────────────────────────────────────────────────────
// Un refus est une VALEUR rendue, jamais une exception : le cron qui appelle
// doit pouvoir le journaliser et passer au bien suivant.
const REFUS = {
  BIEN_NON_PILOTE: 'bien_non_pilote',
  DEMANDE_VIDE: 'demande_vide',
  DEMANDE_INVALIDE: 'demande_invalide'
}

/**
 * Demande au calendrier d'ouvrir des nuits et/ou d'y poser des prix.
 *
 * @param supabase   client service
 * @param bien       la ligne `properties` COMPLETE (select('*') : le writer
 *                   juge sur rate_sync_mode, prix_minimum, inventory_units,
 *                   provider_*, pilote_*…)
 * @param demande    { nuits: [{ date, ouvrir?, prix_centimes? }], aujourdHui? }
 * @param deps       { appel } — le client HTTP du canal (channelCall). Fourni
 *                   par l'appelant, comme `pousserAri` le fait deja : ce module
 *                   ne parle a aucun provider par lui-meme.
 * @returns { ok, refus?, message?, ecrit?, ignorees: { passees, hors_fenetre, deja_fermees, invalides } }
 */
async function demanderAuCalendrier (supabase, bien, demande, deps = {}) {
  if (!pilotParYield(bien)) {
    return { ok: false, refus: REFUS.BIEN_NON_PILOTE,
      message: 'Ce logement n\'est pas piloté par YieldFlow : le calendrier n\'accepte de lui que la main de l\'hôte.' }
  }
  const nuits = Array.isArray(demande && demande.nuits) ? demande.nuits : []
  if (!nuits.length) return { ok: false, refus: REFUS.DEMANDE_VIDE, message: 'Aucune nuit demandée.' }
  // ⚠ DEUX PRECONDITIONS AVANT D'ECRIRE QUOI QUE CE SOIT — relevees en review.
  // `bien.user_id` : le writer ecrit, journalise et alerte sous ce compte. Un
  // bien charge avec une projection sans `user_id` traverserait tout le writer
  // avec `compte = undefined` — c'est le defaut du 12 septembre, qui a coute
  // trois prix reels au journal. On refuse, comme `nuitsOccupees` le fait.
  if (!bien.user_id) {
    return { ok: false, refus: REFUS.DEMANDE_INVALIDE,
      message: 'Le bien doit être chargé avec toutes ses colonnes (user_id absent).' }
  }
  // `deps.appel` : sans client canal, le writer upserterait en base PUIS
  // leverait « appel is not a function » dans son try — le cœur porterait des
  // prix jamais partis, et un incident fondateur partirait par bien traite.
  if (estRelieAuCanal(bien) && typeof (deps && deps.appel) !== 'function') {
    return { ok: false, refus: REFUS.DEMANDE_INVALIDE,
      message: 'Ce bien est relié au canal : le client du canal (appel) est requis.' }
  }

  const auj = jourISO(demande.aujourdHui) || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
  // ⚠ LA FENETRE DU BIEN EST LA BORNE DU CANAL. Le moteur n'ouvre pas au-dela
  // de ce que l'hote a regle a l'activation ; une nuit hors fenetre n'est pas
  // refusee en bloc, elle est IGNOREE et comptee — le cron doit pouvoir dire
  // « 3 nuits ignorees : hors fenetre », pas « demande refusee ».
  const finFenetre = finDeFenetre(bien, auj)
  const ignorees = { hors_fenetre: [], deja_fermees: [], invalides: [], passees: [] }
  // ⚠ LE STOCK SUIT LE BIEN, PAS UN « 1 » EN DUR — releve en review. Le
  // plafonnement du writer ne peut que RETIRER du stock, jamais en ajouter :
  // ouvrir a 1 un bien a 3 unites en laisserait deux invendables.
  const unites = Math.max(1, Number(bien.inventory_units) || 1)

  // ⚠ ON RELIT L'ETAT AVANT DE DECIDER QUOI DEMANDER — pas pour ecrire (le
  // writer relit lui-meme, c'est SA regle), mais pour ne pas OUVRIR une nuit
  // que l'hote a fermee. Voir l'en-tete : d'ici le 4.6.2, une nuit fermee en
  // base ne se rouvre pas par ce canal.
  const dates = [...new Set(nuits.map(n => jourISO(n && n.date)).filter(Boolean))]
  const fermees = new Set()
  // ⚠ PAGINEE PAR 500, COMME LE WRITER, ET POUR LA MEME RAISON — relevee en
  // review. PostgREST tronque a 1000 lignes SANS erreur : au-dela, les nuits
  // manquantes n'entraient pas dans `fermees`, et `ouvrir: true` posait
  // `avail = 1, stop_sell = false` sur des nuits que l'hote avait FERMEES — la
  // regle exacte que ce canal existe pour tenir d'ici le 4.6.2. Un `.in()` de
  // 1200 dates depasserait aussi la longueur d'URL admise.
  const PAGE = 500
  for (let i = 0; i < dates.length; i += PAGE) {
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, stop_sell, avail').eq('property_id', bien.id).in('date', dates.slice(i, i + PAGE))
    if (error) return { ok: false, refus: REFUS.DEMANDE_INVALIDE, message: `Relecture du calendrier impossible : ${error.message}` }
    for (const l of data || []) if (l.stop_sell === true || l.avail === 0) fermees.add(l.date)
  }

  const dateSegments = []
  for (const n of nuits) {
    const date = jourISO(n && n.date)
    if (!date) { ignorees.invalides.push(n && n.date); continue }
    // ⚠ LE PASSE EST IGNORE, COMME LE HORS-FENETRE — releve en review. Une
    // nuit d'hier (cycle en retard, decalage UTC / Paris) serait upsertee
    // puis poussee : Channex la refuse, le verdict crie « panne », un incident
    // fondateur part pour une nuit qui ne peut plus se vendre de toute facon.
    if (date < auj) { ignorees.passees.push(date); continue }
    if (finFenetre != null && date > finFenetre) { ignorees.hors_fenetre.push(date); continue }
    const seg = { date_from: date, date_to: date }
    let porte = false
    if (n.ouvrir === true) {
      if (fermees.has(date)) { ignorees.deja_fermees.push(date) }
      else { seg.avail = unites; seg.stop_sell = false; porte = true }
    }
    if (n.prix_centimes != null) {
      const c = Number(n.prix_centimes)
      // ⚠ UN PRIX INVALIDE N'ANNULE PAS L'OUVERTURE DE LA MEME NUIT — releve en
      // review. Un `continue` ici jetait l'ouverture, valide et independante,
      // avec le prix, et le rapport ne disait que « invalide ».
      if (!Number.isInteger(c) || c <= 0) { ignorees.invalides.push(date) }
      else {
        // Le writer attend des EUROS (comme le calendrier) et reconvertit en
        // centimes lui-meme : on parle sa langue, on ne recopie pas sa regle.
        seg.rate = c / 100
        porte = true
      }
    }
    if (porte) dateSegments.push(seg)
  }

  if (!dateSegments.length) {
    return { ok: true, ecrit: null, ignorees,
      message: 'Rien à écrire : toutes les nuits demandées sont passées, hors fenêtre, déjà fermées ou invalides.' }
  }

  const r = await ecrireCalendrier({
    supabase, bien, compte: bien.user_id, dateSegments, origine: ORIGINE, appel: deps.appel
  })
  if (r.refus) {
    // Le plancher, ou une relecture/ecriture en echec : le writer a deja dit
    // pourquoi, dans les mots de l'hote. On le transmet tel quel.
    return { ok: false, refus: r.refus.body && r.refus.body.code || 'writer', message: r.refus.body && r.refus.body.error, ignorees }
  }
  return { ok: true, ecrit: r, ignorees }
}

module.exports = { demanderAuCalendrier, REFUS, ORIGINE }
