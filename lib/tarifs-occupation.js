// lib/tarifs-occupation.js
// Voyageurs inclus et supplement par voyageur d'un logement connecte : ce que
// la fiche peut changer chez le canal, et ce que ce changement doit renvoyer.
// Spec : docs/specs/spec-supplement-voyageur.md
//
// ⚠ LE MODE DE VENTE D'UN PLAN TARIFAIRE EST FIGE A SA CREATION. Mesure sur
// staging le 20 novembre 2026 : `PUT /rate_plans/:id` avec un autre
// `sell_mode` rend 422 « sell_mode can't be changed ». Or la fiche recalculait
// ce mode a chaque enregistrement (`buildRatePlanOptions` : supplement > 0 ->
// par personne, sinon par logement). Passer le supplement de 2 a 0 sur un plan
// par personne partait donc en 422, et la fiche rendait un 502 opaque — meme
// avec un prix de base. On refuse AVANT d'ecrire, et on dit quoi faire.
//
// ⚠ « PAS DE SUPPLEMENT » SUR UN PLAN PAR PERSONNE, C'EST « TOUS LES VOYAGEURS
// INCLUS ». `buildOccupancyRates` rend alors des `rates[]` plats, le format que
// Channex accepte sur un plan par personne. Un `rate` seul, lui, ne met a jour
// que l'occupation PRINCIPALE (mesure staging) : les autres garderaient leur
// ancienne valeur.
//
// ⚠ UNE GRILLE CHANGEE NE CHANGE AUCUNE NUIT. Les canaux vendent le prix POUSSE
// par date ; la grille du plan n'est qu'un defaut. Changer l'occupation sans
// renvoyer les prix par date laissait chaque nuit a son ancien prix par
// occupation jusqu'a ce que son tarif change — le 23 restait a 89 EUR pour 85.
// D'ou `valeursTarifs` : les prix SEULS, jamais `stop_sell` ni disponibilite
// (mesure staging : poser un prix sur une date fermee ne la rouvre pas).

const { buildOccupancyRates } = require('./channel-pricing')
const { tarifAcceptable } = require('./yield/prix-plancher')
const { enregistrerPrixPousses } = require('./price-log')
const { nuitsOccupees } = require('./nuits-occupees')

const centimes = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

// Le mode de vente que la grille demande : la REGLE de `buildRatePlanOptions`
// (api/channel-property.js), repetee ici parce que c'est elle qu'on confronte
// au mode reel du plan. Un test garde l'accord des deux.
function modeDeVenteDemande (supplement) {
  return (supplement != null && Number(supplement) > 0) ? 'per_person' : 'per_room'
}

// Refus si la grille demandee changerait le mode de vente du plan. `null` sinon.
function refusModeDeVente (modeActuel, modeDemande, capacite) {
  if (!modeActuel || modeActuel === modeDemande) return null
  if (modeActuel === 'per_person') {
    return {
      http: 409,
      error: 'mode_de_vente_immuable',
      message: 'Ce logement est vendu au prix par voyageur chez la plateforme, et ce mode '
        + 'ne peut pas etre change. Pour retirer le supplement, mettez « Voyageurs inclus » a '
        + `${capacite} : tous les voyageurs paieront le meme prix.`
    }
  }
  return {
    http: 409,
    error: 'mode_de_vente_immuable',
    message: 'Ce logement est vendu a un prix unique par logement chez la plateforme, et ce '
      + 'mode ne peut pas etre change : un supplement par voyageur ne peut pas y etre ajoute.'
  }
}

// Le montant de base (EUROS) d'une grille existante : la partie SANS supplement,
// lue sur l'option a l'occupation des voyageurs inclus d'avant. Au-dela de cette
// occupation, chaque voyageur ajoute le supplement ; en deca, c'est la base.
// Repli sur l'option principale (plan par logement : une seule option).
// `null` si la grille ne porte aucun montant exploitable : on ne devine pas.
function baseDeLaGrille (options, inclusAvant) {
  const opts = (Array.isArray(options) ? options : [])
    .map(o => ({ occ: Number(o && o.occupancy), cents: centimes(o && o.rate), primaire: !!(o && o.is_primary) }))
    .filter(o => Number.isFinite(o.occ) && o.occ >= 1 && o.cents != null && o.cents > 0)
  if (!opts.length) return null
  const maxOcc = Math.max(...opts.map(o => o.occ))
  const inc = Number(inclusAvant)
  const cible = (Number.isFinite(inc) && inc >= 1) ? Math.min(inc, maxOcc) : null
  const choisie = (cible != null && opts.find(o => o.occ === cible)) || opts.find(o => o.primaire) || null
  return choisie ? choisie.cents / 100 : null
}

// La grille lue chez le canal, rendue sous la forme qu'un PUT accepte (rate en
// centimes) : c'est ce qu'on remet si le renvoi des prix echoue.
function grilleCommeEcrite (options) {
  return (Array.isArray(options) ? options : [])
    .map(o => ({ occupancy: Number(o.occupancy), rate: centimes(o.rate), is_primary: !!o.is_primary }))
    .filter(o => Number.isFinite(o.occupancy) && o.rate != null)
}

// Les valeurs `/restrictions` qui renvoient le prix de chaque date de la fenetre
// avec la nouvelle occupation. MEME REGLE DE PRIX que `runFullSync` : le tarif
// du jour s'il existe, sinon le prix de base du bien, sinon rien ; un tarif
// sous le plancher n'est pas renvoye (la poussee complete ferme ces dates, ce
// n'est pas a ce renvoi d'y toucher).
//
// ⚠ PRIX SEULS : ni `stop_sell`, ni conditions de sejour, ni disponibilite.
// Ce renvoi ne decide d'aucune ouverture — il corrige un montant.
function valeursTarifs ({ lignes, fenetre, bien, propId, ratePlanId, capacite, inclus, supplement }) {
  const parDate = {}
  for (const r of (lignes || [])) if (r && r.date) parDate[r.date] = r
  const baseEur = Number(bien && bien.base_price) || 0
  const feeCents = Math.round((Number(supplement) || 0) * 100)
  const values = []
  const ignorees = { sans_prix: 0, sous_plancher: 0 }
  // Les nuits dont ce prix est AFFICHE : une ligne en memoire, ni fermee, ni a
  // stock nul. Une date sans ligne part fermee a la poussee complete ; une
  // nuit fermee n'a jamais ete affichee (meme regle que runFullSync).
  const affichees = {}
  for (const date of (fenetre || [])) {
    const r = parDate[date]
    const prixEur = (r && r.rate != null && Number(r.rate) > 0)
      ? Number(r.rate)
      : (baseEur > 0 ? baseEur : null)
    if (prixEur === null) { ignorees.sans_prix++; continue }
    const cents = Math.round(prixEur * 100)
    if (!tarifAcceptable(cents, bien).ok) { ignorees.sous_plancher++; continue }
    const occ = buildOccupancyRates(cents, capacite, inclus, feeCents)
    values.push(occ
      ? { property_id: propId, rate_plan_id: ratePlanId, date, rates: occ }
      : { property_id: propId, rate_plan_id: ratePlanId, date, rate: cents })
    if (r && r.stop_sell !== true && !(r.avail != null && Number(r.avail) === 0)) affichees[date] = cents
  }
  return { values, ignorees, affichees }
}

// ─── Le journal des prix affiches ─────────────────────────────────────────
// docs/kb/price-log.md. Tout chemin qui pousse un tarif l'alimente
// (recensement de tests/price-log.test.js). Ici, le prix de base d'une nuit
// ne change pas en general — seule sa repartition par occupation bouge — et
// `enregistrerPrixPousses` n'ecrit qu'un changement REEL : un renvoi a
// l'identique ne laisse aucune ligne. Mais une date servie par le prix de base
// du bien peut differer de ce qui avait ete pousse : le journal le saura.
//
// ⚠ APRES UNE POUSSEE REUSSIE SEULEMENT, ET SANS JAMAIS LA FAIRE ECHOUER. Le
// prix EST parti : une erreur rendue a l'hote le ferait repousser. On perd une
// ligne de journal, jamais une vente — et on le dit fort.
// ⚠ `userId` est le compte PROPRIETAIRE resolu par la garde (le defaut du
// 12 septembre 2026 : `bien.user_id` non selectionne, journal muet).
async function journaliser ({ supabase, userId, propertyId, providerPropertyId, unites }, affichees) {
  const dates = Object.keys(affichees || {}).sort()
  if (!supabase || !dates.length) return null
  try {
    const vendues = await nuitsOccupees(supabase, providerPropertyId, dates[0], dates[dates.length - 1], { userId })
    const nuits = {}
    const u = Math.max(1, Number(unites) || 1)
    for (const d of dates) if ((vendues[d] || []).length < u) nuits[d] = affichees[d]
    if (!Object.keys(nuits).length) return null
    return await enregistrerPrixPousses(supabase, { userId, propertyId, nuits, source: 'host' })
  } catch (e) {
    console.error('[tarifs-occupation] JOURNAL DES PRIX NON ECRIT :', e.message)
    return { erreur: e.message }
  }
}

// Lit le plan tarifaire chez le canal. `appel(method, path, body)` rend
// { ok, status, json } (le `channelCall` de l'endpoint).
async function lirePlan (appel, ratePlanId) {
  // ⚠ L'APPEL PEUT LEVER (coupure reseau : le `channelCall` de l'endpoint ne
  // protege pas son `fetch`). Une exception ici est une lecture ratee comme une
  // autre : rien n'a encore ete ecrit, on le dit.
  let r
  try { r = await appel('GET', `/rate_plans/${ratePlanId}`) } catch (e) { r = null }
  const attr = r && r.ok && r.json && r.json.data && r.json.data.attributes
  if (!attr) {
    return {
      ok: false, http: 502, error: 'lecture_tarif',
      message: 'Impossible de lire le tarif de ce logement chez la plateforme pour le moment. '
        + 'Rien n\'a ete change. Reessayez.'
    }
  }
  return { ok: true, mode: attr.sell_mode || null, options: Array.isArray(attr.options) ? attr.options : [] }
}

// Ecrit la grille, puis renvoie les prix par date si on le demande. Si le
// renvoi echoue, la grille d'avant est REMISE : l'appelant n'ecrit alors rien
// en base, et rien n'a change nulle part — ni une base qui dirait « 6 inclus »
// pendant que les canaux vendent l'ancien prix, ni une grille seule changee.
//
// `lireInventaire()` rend les lignes `{ date, rate }` de la fenetre, ou LEVE.
async function appliquerOccupation ({ appel, ratePlanId, planActuel, grille, renvoyer,
                                      lireInventaire, fenetre, bien, propId,
                                      capacite, inclus, supplement, journal }) {
  let g
  try {
    g = await appel('PUT', `/rate_plans/${ratePlanId}`, {
      rate_plan: { sell_mode: grille.sell_mode, options: grille.options }
    })
  } catch (e) {
    g = null
  }
  if (!g || !g.ok) {
    return { ok: false, http: 502, error: 'Mise a jour du tarif echouee cote plateforme', status: g && g.status }
  }
  if (!renvoyer) return { ok: true, renvoyees: 0 }

  const remettre = async () => {
    try {
      const back = await appel('PUT', `/rate_plans/${ratePlanId}`, {
        rate_plan: { sell_mode: planActuel.mode, options: grilleCommeEcrite(planActuel.options) }
      })
      return !!(back && back.ok)
    } catch (e) {
      return false
    }
  }
  const echec = async (detail) => {
    const remise = await remettre()
    return {
      ok: false, http: 502, error: 'tarifs_non_renvoyes', detail, grille_remise: remise,
      message: remise
        ? 'Les prix par date n\'ont pas pu etre renvoyes aux plateformes : rien n\'a ete change. Reessayez.'
        : 'Les prix par date n\'ont pas pu etre renvoyes aux plateformes, et la grille du tarif '
          + 'n\'a pas pu etre remise. Vos prix par date sont inchanges. Reessayez.'
    }
  }

  let lignes
  try {
    lignes = await lireInventaire()
  } catch (e) {
    return echec('lecture_calendrier: ' + e.message)
  }
  const { values, ignorees, affichees } = valeursTarifs({ lignes, fenetre, bien, propId, ratePlanId, capacite, inclus, supplement })
  if (!values.length) return { ok: true, renvoyees: 0, ignorees }
  let r
  try {
    r = await appel('POST', '/restrictions', { values })
  } catch (e) {
    return echec('restrictions: ' + e.message)
  }
  if (!r || !r.ok) return echec('restrictions: HTTP ' + (r && r.status))
  const bilanJournal = journal ? await journaliser(journal, affichees) : null
  return { ok: true, renvoyees: values.length, ignorees, journal: bilanJournal }
}

module.exports = {
  modeDeVenteDemande, refusModeDeVente, baseDeLaGrille, grilleCommeEcrite,
  valeursTarifs, journaliser, lirePlan, appliquerOccupation
}
