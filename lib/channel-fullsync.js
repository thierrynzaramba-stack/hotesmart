// lib/channel-fullsync.js
// Full sync ARI Channex (500 jours) pour un bien donne. Extrait d'api/calendar.js
// pour etre reutilisable par le worker cron (lib/cron-channel-sync.js).
const { supabase } = require('./cron-shared')
const { buildOccupancyRates } = require('./channel-pricing')
const { proprieteChezLeProvider } = require('./rate-sync')
const { nuitsOccupees } = require('./nuits-occupees')

// ⚠ SEUIL D'ALERTE, ET IL EST BAS EXPRES.
// Une poussee couvre 500 jours. Un bien normalement tarife n'a pas 30 dates
// sans prix ; un amorcage rate en ferme des centaines. 30 laisse passer les
// trous ponctuels et attrape la panne. `reportIncident` porte deja un anti-spam
// horaire : meme si le cron repasse toutes les 5 minutes, une alerte au plus
// par heure et par bien.
const SEUIL_ALERTE_SANS_PRIX = 30

// L'horizon REELLEMENT pousse. Exporte pour que les apercus controlent la meme
// fenetre : en inspecter moins, c'est promettre sur ce qu'on n'a pas regarde.
const JOURS_POUSSES = 500

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

// Formatage YYYY-MM-DD en composantes LOCALES (jamais via toISOString/UTC).
const toLocalISO = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

async function channelCall(method, path, body, _attempt = 0) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if ((res.status === 429 || res.status >= 500) && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, _attempt), 8000)
    await new Promise(r => setTimeout(r, waitMs))
    return channelCall(method, path, body, _attempt + 1)
  }
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Jour suivant en ISO (UTC, deterministe quel que soit le fuseau serveur)
function nextISO(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Coalescence : regroupe les dates consecutives a signature identique en plages.
function coalesceRanges(items) {
  const out = []
  let cur = null
  for (const it of items) {
    if (cur && it.sig === cur.sig && nextISO(cur.date_to) === it.date) {
      cur.date_to = it.date
    } else {
      if (cur) out.push({ ...cur.value, date_from: cur.date_from, date_to: cur.date_to })
      cur = { sig: it.sig, date_from: it.date, date_to: it.date, value: it.value }
    }
  }
  if (cur) out.push({ ...cur.value, date_from: cur.date_from, date_to: cur.date_to })
  return out
}

// Execute un full sync ARI (500 jours) pour un bien deja valide (ids canal presents).
// Retourne { days, pushed, warnings, task_ids }. Throw uniquement sur erreur de lecture DB.
//
// ⚠ `dryRun` N'EST PAS UN CONFORT : c'est ce qui fait de la poussee une etape
// d'assistant (spec-assistant-migration.md §2). Il calcule TOUT — les memes 500
// dates, les memes plages, le meme compte de fermetures — et s'arrete avant le
// premier appel reseau. Une seconde source de calcul « pour l'apercu » aurait
// fini par montrer autre chose que ce qui part.
//
// ⚠ LA DESTINATION SE DEMANDE, ELLE NE SE SUPPOSE PAS : pendant la migration,
// `provider_property_id` est la cle du provider SOURCE. Voir
// `proprieteChezLeProvider` (lib/rate-sync.js).
async function runFullSync(bien, { dryRun = false } = {}) {
  // ⚠ LE PIEGE DE LA COLONNE NON SELECTIONNEE, DIT PLUTOT QUE SUBI.
  // Un appelant qui oublie `provider` dans son SELECT ferait lire `undefined` a
  // la resolution de destination, qui rendrait alors la propriete CIBLE — ou
  // rien. On refuse en NOMMANT la cause : ce depot a paye quatre fois le meme
  // piege sous forme de comportement silencieux.
  // La destination depend de DEUX colonnes : proteger l'une sans l'autre laissait
  // le meme silence — un appelant qui oublie `migration_target_property_id` pousse
  // vers la cle source sans que rien ne le dise.
  const COLONNES_REQUISES = {
    provider: 'impossible de savoir vers quelle propriete pousser',
    migration_target_property_id: 'impossible de savoir vers quelle propriete pousser',
    inventory_units: 'impossible de calculer le stock, donc de fermer une nuit vendue',
    // Sans elle, la lecture des sejours interroge `property_id = 'undefined'` :
    // zero nuit vendue, aucune erreur, et tout repart ouvert. Exactement la
    // regression que ce calcul ferme, rouverte en silence.
    provider_property_id: 'impossible de lire les sejours, donc de fermer une nuit vendue',
    // `provider_property_id` n'a pas d'unicite globale : sans le compte, on
    // lirait les sejours d'un autre hote.
    user_id: 'impossible de cloisonner la lecture des sejours par compte'
  }
  for (const [col, pourquoi] of Object.entries(COLONNES_REQUISES)) {
    // ⚠ `== null` et non `=== undefined` : une colonne NULLE produit exactement
    // le meme silence (`String(null)` vaut 'null' — zero ligne, zero erreur).
    // `migration_target_property_id` fait exception : elle est LEGITIMEMENT nulle
    // hors migration, seule son absence du SELECT est un defaut.
    const absente = col === 'migration_target_property_id'
      ? bien[col] === undefined
      : bien[col] == null
    if (bien && absente) {
      throw new Error(`runFullSync : la colonne \`${col}\` n a pas ete selectionnee — ${pourquoi}`)
    }
  }
  const propIdFs = proprieteChezLeProvider(bien)
  if (!propIdFs) {
    throw new Error('Aucune propriete de destination : ce bien n est ni chez le canal, ni provisionne chez lui')
  }
  const ratePlanFs = bien.provider_rate_plan_id
  const roomTypeFs = bien.provider_room_type_id
  const startFs = new Date(); startFs.setHours(0, 0, 0, 0)
  const endFs = new Date(startFs); endFs.setDate(endFs.getDate() + 500)
  const isoFs = (d) => toLocalISO(d)
  const { data: invFs, error: invErrFs } = await supabase
    .from('calendar_inventory')
    .select('date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
    .eq('property_id', bien.id)
    .gte('date', isoFs(startFs))
    .lte('date', isoFs(endFs))
    .order('date', { ascending: true })
  if (invErrFs) throw new Error('Erreur lecture inventory')
  const invMapFs = {}
  ;(invFs || []).forEach(r => { invMapFs[r.date] = r })
  const baseEur = Number(bien.base_price) || 0
  // Tarifs par occupation (per-occupancy). extra_guest_fee est stocke en unite
  // majeure sur properties -> conversion en cents pour matcher le rate pousse.
  const capFs      = bien.capacity
  const incFs      = bien.included_guests
  const feeCentsFs = Math.round((Number(bien.extra_guest_fee) || 0) * 100)
  // Full sync : fenetre IDENTIQUE availability + restrictions sur les 500 dates (pas de
  // delta), une restriction poussee pour CHAQUE date (rate de base + defauts si pas de
  // ligne), le tout coalesce en plages (Channex accepte/prefere les plages).
  // ⚠ LE STOCK EST CALCULE, IL N'EST PAS LU.
  // `calendar_inventory.avail` vaut NULL sur tout bien amorce, et la regle
  // precedente traduisait NULL par « 1 place libre ». Une nuit VENDUE repartait
  // donc annoncee disponible a chaque poussee — et chez Channex, qui decremente
  // pourtant son stock a la confirmation (`allow_availability_autoupdate_on_
  // confirmation`), la poussee ECRASAIT sa decrementation. Mesure du 9 septembre
  // 2026 : 11 nuits vendues sur les deux biens de Bagneres repartaient ouvertes.
  //
  // Regle (docs/specs/spec-audit-stop-sell.md) : `avail` est un STOCK, calcule au
  // moment de pousser — jamais une source. `stop_sell`, lui, reste l'intention de
  // l'hote, et n'est pas touche ici.
  //
  // Sur un bien mono-unite — `inventory_type: 'whole'`, le seul codé, et le cas
  // des quatre biens actuels — le calcul ne peut QUE fermer : une ligne absente
  // reste fermee, une ligne que l'hote a mise a 0 reste a 0, une nuit libre
  // reste a 1. Sur un bien multi-unites il annoncerait le stock reel (3 places
  // moins les ventes) la ou l'ancienne regle annoncait 1 : c'est le but, mais
  // ce n'est plus « il ne peut que fermer ». A verifier le jour ou un tel bien
  // existe.
  const unites = Math.max(1, Number(bien.inventory_units) || 1)
  const vendues = await nuitsOccupees(supabase, bien.provider_property_id, isoFs(startFs), isoFs(endFs), { userId: bien.user_id })
  const fermeesCarVendues = []

  const availItems = []
  const restItems = []
  // Les dates fermees faute de prix. Comptees pour etre DITES, et alertees
  // au-dela d'un seuil : un amorcage rate qui fermerait 300 dates doit se voir
  // tout de suite, pas se decouvrir sur Booking.
  const fermeesSansPrix = []
  // Prix reellement AFFICHES, par nuit, en centimes. Alimente le journal des
  // prix apres une poussee reussie. Une nuit fermee n'y entre pas.
  const prixParNuitFs = {}
  const warnings = []
  for (let i = 0; i < 500; i++) {
    const d = new Date(startFs); d.setDate(d.getDate() + i)
    const iso = isoFs(d)
    const r = invMapFs[iso]
    // Availability : pas de ligne d'inventaire = date fermee (0), sinon le stock
    // REEL — ce que la memoire annonce, plafonne par ce qui reste a vendre.
    const stock = Math.max(0, unites - ((vendues[iso] || []).length))
    const annonce = (r && r.avail != null) ? Number(r.avail) : unites
    const availability = r ? Math.min(annonce, stock) : 0
    // Toute place RETIREE se dit, pas seulement la fermeture totale : sur un
    // bien a 3 unites dont 2 vendues, un stock passe de 3 a 1 doit se voir.
    if (r && availability < annonce) fermeesCarVendues.push(iso)
    availItems.push({ date: iso, sig: String(availability), value: { property_id: propIdFs, room_type_id: roomTypeFs, availability } })
    // Restrictions full sync : ETAT COMPLET, tous les champs declares presents sur CHAQUE
    // date (exigence certif #1 "147/168 missing max_stay"). max_stay TOUJOURS emis (0 = pas
    // de limite). min_stay couples, defaut 1. rate en cents.
    const obj = {
      min_stay_arrival: (r && r.min_stay_arrival) || 1,
      min_stay_through: (r && r.min_stay_through) || 1,
      max_stay: (r && r.max_stay) || 0,
      closed_to_arrival: !!(r && r.cta),
      closed_to_departure: !!(r && r.ctd),
      stop_sell: !!(r && r.stop_sell)
    }
    // ─── Le prix du jour, ou son absence ────────────────────────────────────
    // L'exception du jour si elle existe, sinon le prix de base du bien, sinon
    // RIEN. Un `rate` a 0 n'est pas un prix : c'est l'absence d'exception.
    const prixEur = (r && r.rate != null && Number(r.rate) > 0)
      ? Number(r.rate)
      : (baseEur > 0 ? baseEur : null)

    if (prixEur === null) {
      // ⚠ FERMETURE CALCULEE — arbitrage de Thierry du 8 septembre 2026, rendu
      // apres le verdict staging (docs/specs/protocole-staging-tarifs.md).
      //
      // Le verdict, mesure : OMETTRE `rate` NE FERME RIEN. La date reste
      // vendable au prix par defaut de l'option du rate plan — un prix que
      // l'hote n'a jamais choisi pour cette date. Et `rate: 0` n'est pas
      // applique par Channex : l'ancien comportement (pousser 0 avec un simple
      // warning dans un log que personne ne lit) vendait donc au tarif de la
      // grille, en silence.
      //
      // Ce qui ferme reellement une date, c'est `stop_sell`. On le pousse.
      //
      // ⚠ ET ON N'ECRIT RIEN DANS `calendar_inventory.stop_sell`.
      // La memoire d'intention n'appartient QU'A L'HOTE (regle gravee du
      // chantier audit stop_sell). Cette fermeture-ci est un ETAT CALCULE :
      // des que l'hote saisit un prix, la date rouvre d'elle-meme a la poussee
      // suivante, sans qu'il ait rien a defaire.
      //
      // Coherent avec l'option A du moteur direct : sans prix = invendable,
      // partout, du calendrier public jusqu'aux OTA.
      obj.stop_sell = true
      fermeesSansPrix.push(iso)
    } else {
      const rateCents = Math.round(prixEur * 100)
      const occRates  = buildOccupancyRates(rateCents, capFs, incFs, feeCentsFs)
      // occRates non-null -> rates[] par occupation ; null -> rate singulier.
      if (occRates) obj.rates = occRates
      else          obj.rate  = rateCents

      // ─── Journal des prix affiches (YieldFlow etape 1) ──────────────────
      // docs/kb/price-log.md. On capte ICI, pas dans `restrictionValues` :
      // avec une tarification par occupation, `obj.rate` n'est pas pose et
      // seul `obj.rates` existe — relire `rate` plus bas journaliserait
      // `undefined` sur tous ces biens, sans erreur.
      //
      // ⚠ UNE NUIT FERMEE N'EST PAS UNE NUIT AFFICHEE.
      // `obj.stop_sell` vient de l'intention memorisee de l'hote : une date
      // peut porter un prix ET etre fermee a la vente. Aucun voyageur ne voit
      // ce prix — le journaliser ferait croire au moteur qu'une nuit a ete
      // proposee a 120 EUR pendant trois mois alors qu'elle etait invendable,
      // et fausserait la mesure meme que ce journal existe pour rendre.
      if (!obj.stop_sell) prixParNuitFs[iso] = rateCents
    }
    restItems.push({ date: iso, sig: JSON.stringify(obj), value: { property_id: propIdFs, rate_plan_id: ratePlanFs, ...obj } })
  }
  // ⚠ SEUIL D'ALERTE, POUR LA MEME RAISON QUE CELUI DES DATES SANS PRIX.
  // Le stock depend maintenant de la fraicheur de `bookings_snapshot`, et rien ne
  // purge encore les snapshots disparus des fetchs Beds24 (« fantomes actifs »,
  // dette connue). Un fantome `confirmed` ferme desormais une nuit REELLEMENT
  // vendable, a chaque poussee, et aucun geste de l'hote ne peut la rouvrir : le
  // plafond ecrase toute valeur superieure. Un defaut jusque-la cosmetique
  // deviendrait une perte de revenu silencieuse — donc on le rend bruyant.
  const SEUIL_ALERTE_VENDUES = 30
  if (fermeesCarVendues.length >= SEUIL_ALERTE_VENDUES && !dryRun) {
    try {
      const { reportIncident } = require('./founder-notify')
      await reportIncident('poussee_nuits_vendues', {
        userId: bien.user_id || null,
        propertyId: String(propIdFs || bien.id),
        propertyName: bien.name || String(bien.id),
        threshold: 1,
        detail: `${fermeesCarVendues.length} nuits sur 500 poussees au stock REDUIT car deja vendues`
          + ` (${fermeesCarVendues[0]} → ${fermeesCarVendues[fermeesCarVendues.length - 1]}).`
          + ' Si ce n\'est pas voulu, des reservations fantomes ferment des nuits vendables.'
      })
    } catch (e) {
      console.error('[fullsync] alerte « nuits vendues » non partie :', e.message)
    }
  }

  if (fermeesCarVendues.length) {
    warnings.push(`${fermeesCarVendues.length} nuit(s) dont le stock est reduit car deja vendue(s) (stock calcule)`)
    console.log(`[fullsync] bien ${bien.id} : ${fermeesCarVendues.length} nuit(s) au stock reduit car vendue(s)`
      + ` (de ${fermeesCarVendues[0]} a ${fermeesCarVendues[fermeesCarVendues.length - 1]})`)
  }

  const availabilityValues = coalesceRanges(availItems)
  const restrictionValues = coalesceRanges(restItems)
  // L'ancien avertissement (« rate 0 sera rejete par Channex ») disait une chose
  // fausse — Channex ne rejette pas 0, il l'ignore et garde le prix de la grille
  // — et ne faisait rien. Il est remplace par le comportement ci-dessus, et par
  // un compte que l'on DIT.
  if (fermeesSansPrix.length) {
    warnings.push(`${fermeesSansPrix.length} date(s) fermee(s) faute de prix (fermeture calculee, aucune intention ecrite)`)
    console.log(`[fullsync] bien ${bien.id} : ${fermeesSansPrix.length}/500 dates fermees faute de prix`
      + ` (de ${fermeesSansPrix[0]} a ${fermeesSansPrix[fermeesSansPrix.length - 1]})`)
  }
  // ─── L'APERCU S'ARRETE ICI ────────────────────────────────────────────────
  // Avant l'alerte (un apercu ne doit pas declencher un incident) et avant tout
  // appel reseau.
  if (dryRun) {
    const tarifees = restrictionValues.filter(v => v.rate != null || v.rates)
    return {
      dry_run: true,
      days: 500,
      cible: propIdFs,
      pushed: false,
      warnings,
      dates_tarifees: 500 - fermeesSansPrix.length,
      dates_fermees_faute_de_prix: fermeesSansPrix.length,
      // Rendu pour que personne ne refasse le calcul ailleurs : une seconde
      // copie de la regle finit par dire autre chose que ce qui part.
      nuits_vendues_fermees: fermeesCarVendues.length,
      dates_vendues: fermeesCarVendues,
      premiere_fermee: fermeesSansPrix[0] || null,
      derniere_fermee: fermeesSansPrix[fermeesSansPrix.length - 1] || null,
      plages: { availability: availabilityValues.length, restrictions: restrictionValues.length },
      echantillon: tarifees.slice(0, 5)
    }
  }

  if (fermeesSansPrix.length >= SEUIL_ALERTE_SANS_PRIX) {
    try {
      const { reportIncident } = require('./founder-notify')
      await reportIncident('poussee_dates_sans_prix', {
        userId: bien.user_id || null,
        // ⚠ LA PROPRIETE OU LES DATES ONT ETE FERMEES, pas la source : pendant
        // une migration ce sont deux identifiants differents, et chercher au
        // mauvais endroit coute la duree de l'incident.
        propertyId: String(propIdFs || bien.id),
        propertyName: bien.name || String(bien.id),
        threshold: 1,
        detail: `${fermeesSansPrix.length} dates sur 500 poussees FERMEES faute de prix`
          + ` (${fermeesSansPrix[0]} → ${fermeesSansPrix[fermeesSansPrix.length - 1]}).`
          + ` Si ce n'est pas voulu, l'amorcage des prix a echoue : ces dates ne sont vendables nulle part.`
      })
    } catch (e) {
      console.error('[fullsync] alerte « dates sans prix » non partie :', e.message)
    }
  }
  let pushed = false
  const task_ids = {}
  const a = await channelCall('POST', '/availability', { values: availabilityValues })
  if (!a.ok) warnings.push('availability: HTTP ' + a.status); else { pushed = true; task_ids.availability = a.json?.data?.[0]?.id || null }
  const rr = await channelCall('POST', '/restrictions', { values: restrictionValues })
  if (!rr.ok) warnings.push('restrictions: HTTP ' + rr.status); else { pushed = true; task_ids.restrictions = rr.json?.data?.[0]?.id || null }

  // ─── JOURNAL DES PRIX AFFICHES (YieldFlow etape 1) ─────────────────────────
  // docs/specs/spec-yieldflow-v1.md §4 — docs/kb/price-log.md
  //
  // ⚠ C'EST ICI LE POINT DE CAPTURE PRINCIPAL, PAS `api/calendar.js`.
  // Releve en review : la premiere version ne journalisait que le calendrier,
  // alors que le chemin par lequel un prix atteint REELLEMENT les OTA est ce
  // full sync 500 jours — file `channel_sync_queue`, migration ARI, changement
  // de rate plan. Consequence mesuree a la lecture : toutes les nuits au
  // `base_price` (donc jamais editees a la main, soit la quasi-totalite)
  // n'entraient jamais au journal, et pire, une baisse du prix de base poussait
  // 90 EUR aux plateformes pendant que le journal continuait d'affirmer 120 —
  // la vente aurait alors fige un prix que personne n'a vu.
  //
  // Les deux points de capture coexistent sans se marcher dessus : le writer
  // n'ecrit que sur changement REEL, donc le second a passer ne voit rien a
  // faire. C'est la deduplication qui rend l'idempotence, pas une coordination.
  if (rr.ok && Object.keys(prixParNuitFs).length && bien.id && bien.user_id) {
    try {
      const { enregistrerPrixPousses } = require('./price-log')
      const bilan = await enregistrerPrixPousses(supabase, {
        userId: bien.user_id,
        propertyId: bien.id,      // UUID : le journal est cle sur properties.id
        nuits: prixParNuitFs,
        source: 'host'
      })
      if (bilan.ouvertes || bilan.remplacees) {
        console.log(`[fullsync] journal des prix : ${JSON.stringify(bilan)}`)
      }
    } catch (e) {
      // Le journal ne fait JAMAIS echouer une poussee : les prix sont partis,
      // c'est la mesure qui a manque. Mais on le dit fort — un journal muet
      // est un journal faux.
      console.error('[fullsync] JOURNAL DES PRIX NON ECRIT :', e.message)
      warnings.push('journal des prix non ecrit : ' + e.message)
    }
  }
  // Meme contrat qu'en apercu : un appelant qui lit `nuits_vendues_fermees` sur
  // une poussee reelle obtenait `undefined`, sans erreur.
  return { days: 500, pushed, warnings, task_ids,
    nuits_vendues_fermees: fermeesCarVendues.length, dates_vendues: fermeesCarVendues,
    // `dates_tarifees` manquait ici alors que l'apercu le rend : un script qui
    // journalisait « X date(s) tarifee(s) » apres une poussee REELLE imprimait
    // `undefined`. Le contrat n'etait pas le meme, malgre le commentaire.
    dates_tarifees: 500 - fermeesSansPrix.length,
    dates_fermees_faute_de_prix: fermeesSansPrix.length }
}

// ⚠ EXPORTES POUR QUE LES VERIFICATEURS NE RECONSTRUISENT PAS LA FENETRE.
// Releve en review : un script rebatissait les 500 dates avec `toISOString()`,
// donc en UTC, alors que le writer les calcule a minuit LOCAL. En Europe/Paris
// entre 00 h et 02 h, les deux fenetres sont decalees d'un jour : la derniere
// date poussee n'etait ni relue ni comptee — un faux vert sur une date, a une
// heure ou personne ne regarde. La regle « jamais via toISOString/UTC » etait
// deja ecrite ici ; elle ne servait a rien tant que le voisin ne pouvait pas
// appeler la meme fonction.
const fenetrePoussee = () => {
  const debut = new Date(); debut.setHours(0, 0, 0, 0)
  const out = []
  for (let i = 0; i < JOURS_POUSSES; i++) {
    const d = new Date(debut); d.setDate(d.getDate() + i)
    out.push(toLocalISO(d))
  }
  return out
}

module.exports = { runFullSync, JOURS_POUSSES, toLocalISO, fenetrePoussee }
