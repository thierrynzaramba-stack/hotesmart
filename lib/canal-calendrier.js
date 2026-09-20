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
 * @returns { ok, refus?, message?, ecrit?, ignorees: { hors_fenetre, deja_fermees, invalides } }
 */
async function demanderAuCalendrier (supabase, bien, demande, deps = {}) {
  if (!pilotParYield(bien)) {
    return { ok: false, refus: REFUS.BIEN_NON_PILOTE,
      message: 'Ce logement n\'est pas piloté par YieldFlow : le calendrier n\'accepte de lui que la main de l\'hôte.' }
  }
  const nuits = Array.isArray(demande && demande.nuits) ? demande.nuits : []
  if (!nuits.length) return { ok: false, refus: REFUS.DEMANDE_VIDE, message: 'Aucune nuit demandée.' }

  const auj = jourISO(demande.aujourdHui) || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
  // ⚠ LA FENETRE DU BIEN EST LA BORNE DU CANAL. Le moteur n'ouvre pas au-dela
  // de ce que l'hote a regle a l'activation ; une nuit hors fenetre n'est pas
  // refusee en bloc, elle est IGNOREE et comptee — le cron doit pouvoir dire
  // « 3 nuits ignorees : hors fenetre », pas « demande refusee ».
  const finFenetre = finDeFenetre(bien, auj)
  const ignorees = { hors_fenetre: [], deja_fermees: [], invalides: [] }

  // ⚠ ON RELIT L'ETAT AVANT DE DECIDER QUOI DEMANDER — pas pour ecrire (le
  // writer relit lui-meme, c'est SA regle), mais pour ne pas OUVRIR une nuit
  // que l'hote a fermee. Voir l'en-tete : d'ici le 4.6.2, une nuit fermee en
  // base ne se rouvre pas par ce canal.
  const dates = nuits.map(n => jourISO(n && n.date)).filter(Boolean)
  const fermees = new Set()
  if (dates.length) {
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, stop_sell, avail').eq('property_id', bien.id).in('date', dates)
    if (error) return { ok: false, refus: REFUS.DEMANDE_INVALIDE, message: `Relecture du calendrier impossible : ${error.message}` }
    for (const l of data || []) if (l.stop_sell === true || l.avail === 0) fermees.add(l.date)
  }

  const dateSegments = []
  for (const n of nuits) {
    const date = jourISO(n && n.date)
    if (!date) { ignorees.invalides.push(n && n.date); continue }
    if (finFenetre != null && date > finFenetre) { ignorees.hors_fenetre.push(date); continue }
    const seg = { date_from: date, date_to: date }
    let porte = false
    if (n.ouvrir === true) {
      if (fermees.has(date)) { ignorees.deja_fermees.push(date) }
      else { seg.avail = 1; seg.stop_sell = false; porte = true }
    }
    if (n.prix_centimes != null) {
      const c = Number(n.prix_centimes)
      if (!Number.isInteger(c) || c <= 0) { ignorees.invalides.push(date); continue }
      // Le writer attend des EUROS (comme le calendrier) et reconvertit en
      // centimes lui-meme : on parle sa langue, on ne recopie pas sa regle.
      seg.rate = c / 100
      porte = true
    }
    if (porte) dateSegments.push(seg)
  }

  if (!dateSegments.length) {
    return { ok: true, ecrit: null, ignorees,
      message: 'Rien à écrire : toutes les nuits demandées sont hors fenêtre, déjà fermées ou invalides.' }
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
