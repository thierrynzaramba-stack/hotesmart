// lib/price-log.js
// DOC : docs/kb/price-log.md (modif = MEME COMMIT)
// SEUL WRITER AUTORISE de la table `price_display_log`.
//
// Spec : docs/specs/spec-yieldflow-v1.md §4 (YieldFlow etape 1).
//
// ⚠ CE JOURNAL N'EST PAS RETROACTIF, ET C'EST TOUTE SA RAISON D'ETRE.
// Le reste de YieldFlow se recalcule depuis `bookings_snapshot` (4 ans
// d'historique). Le prix AFFICHE, lui, n'existe nulle part une fois remplace :
// ni chez nous, ni chez le provider, qui ne sert que le prix courant. Une
// journee sans capture est une journee perdue pour toujours.
//
// LE MECANISME, EN UNE PHRASE : au plus une ligne COURANTE (ni remplacee, ni
// vendue) par bien et par nuit. Elle s'ouvre quand un prix part aux
// plateformes, et se ferme de deux facons seulement :
//   - REMPLACEMENT : un autre prix est pousse pour cette nuit  -> replaced_at
//   - VENTE        : la nuit est vendue                        -> sold_at
//
// ⚠ UNE LIGNE PAR CHANGEMENT REEL, JAMAIS PAR CYCLE (spec §4).
// Le calendrier repousse les memes prix a chaque enregistrement, et le full
// sync repousse tout le calendrier. Ecrire a chaque poussee produirait des
// milliers de lignes identiques par mois et rendrait la table inexploitable —
// « tenue a 120 pendant trois mois » deviendrait illisible sous le bruit.
// On compare donc au prix courant AVANT d'ecrire.

const CENTIMES_MAX = 100000000   // 1 000 000 EUR — garde-fou de saisie
// Plus long sejour plausible. Au-dela, la date vient d'un payload aberrant.
const MAX_NUITS = 400

// Une date de sejour valide, au format que porte la poussee ARI.
function estDateSejour (v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

// ⚠ UN PRIX EN CENTIMES EST UN ENTIER, ET ON LE VERIFIE.
// `Math.round(rate * 100)` sur une saisie en euros peut rendre un flottant si
// `rate` est deja un centime mal converti quelque part en amont. Un `rate` non
// entier ferait echouer l'INSERT sur la contrainte `integer` — mais seulement
// a l'ecriture, donc apres la poussee, donc en silence dans les logs.
function centimesValides (v) {
  return Number.isInteger(v) && v >= 0 && v <= CENTIMES_MAX
}

// ─── Ouverture / remplacement ────────────────────────────────────────────────
// `nuits` : Map ou objet { 'YYYY-MM-DD': rateCents }.
// Rend { ouvertes, remplacees, inchangees, ignorees }.
//
// ⚠ N'EST APPELE QU'APRES UNE POUSSEE REUSSIE. Journaliser un prix qui n'est
// pas parti aux plateformes ferait croire au moteur qu'une nuit etait affichee
// a un prix qu'aucun voyageur n'a jamais vu. L'appelant (api/calendar.js) ne
// nous appelle que si `/restrictions` a rendu ok.
async function enregistrerPrixPousses (supabase, { userId, propertyId, nuits, source = 'host' }) {
  const bilan = { ouvertes: 0, remplacees: 0, inchangees: 0, ignorees: 0 }
  if (!supabase || !userId || !propertyId || !nuits) return bilan
  if (source !== 'host' && source !== 'engine') {
    throw new Error(`[price-log] source invalide : ${source}`)
  }

  const entrees = nuits instanceof Map ? [...nuits.entries()] : Object.entries(nuits)
  const valides = entrees.filter(([d, c]) => estDateSejour(d) && centimesValides(c))
  bilan.ignorees = entrees.length - valides.length
  if (bilan.ignorees) {
    // On le DIT. Un filtre muet rendrait indiscernable « aucun prix a
    // journaliser » de « toutes les nuits ont ete rejetees ».
    console.warn(`[price-log] ${bilan.ignorees} nuit(s) ignoree(s) : date ou centimes invalides`)
  }
  if (!valides.length) return bilan

  const dates = valides.map(([d]) => d)

  // Prix courants, en UNE lecture. Une lecture par nuit ferait 60 allers-
  // retours pour un mois pousse d'un coup.
  const { data: courantes, error } = await supabase
    .from('price_display_log')
    .select('id, stay_date, rate')
    .eq('property_id', propertyId)
    .in('stay_date', dates)
    .is('replaced_at', null)
    .is('sold_at', null)

  if (error) {
    // ⚠ ON NE DEVINE PAS. Sans les prix courants, on ne sait pas distinguer un
    // changement d'un re-envoi a l'identique : ecrire quand meme remplirait le
    // journal de doublons, et ne rien ecrire perdrait des changements reels.
    // On remonte, l'appelant journalise l'echec sans faire echouer la poussee
    // (le prix EST parti : c'est le journal qui a manque, pas la vente).
    throw new Error(`[price-log] lecture des prix courants : ${error.message}`)
  }

  const courantParDate = new Map((courantes || []).map(l => [l.stay_date, l]))
  const aRemplacer = []
  const aInserer = []
  for (const [stayDate, rate] of valides) {
    const courant = courantParDate.get(stayDate)
    if (courant && courant.rate === rate) { bilan.inchangees++; continue }
    if (courant) aRemplacer.push(courant.id)
    aInserer.push({ user_id: userId, property_id: propertyId, stay_date: stayDate, rate, source })
  }
  if (!aInserer.length) return bilan

  // ⚠ FERMER AVANT D'OUVRIR, ET L'ORDRE N'EST PAS INTERCHANGEABLE.
  // L'index unique partiel interdit deux lignes courantes sur la meme nuit :
  // inserer d'abord ferait echouer l'INSERT. Et si l'INSERT echoue apres la
  // fermeture, la nuit se retrouve sans prix courant — un trou, visible et
  // rattrapable a la poussee suivante, alors que deux lignes courantes
  // feraient clore la mauvaise a la vente, en silence.
  if (aRemplacer.length) {
    // ⚠ LE FILTRE `sold_at is null` EST REPETE ICI, ET CE N'EST PAS REDONDANT.
    // La lecture plus haut l'imposait deja, mais le dispatcher tourne toutes
    // les 5 minutes : entre la lecture et cet UPDATE, `cloturerVente` peut
    // avoir vendu la nuit. Sans ce filtre, la ligne porterait a la fois
    // `sold_at` ET `replaced_at` — et toute requete de l'etape 3 qui reconnait
    // une vente reelle par `sold_at is not null and replaced_at is null` la
    // perdrait, en silence.
    const { data: fermees, error: eMaj } = await supabase
      .from('price_display_log')
      .update({ replaced_at: new Date().toISOString() })
      .in('id', aRemplacer)
      .is('sold_at', null)
      .select('id')
    if (eMaj) throw new Error(`[price-log] fermeture des lignes remplacees : ${eMaj.message}`)
    bilan.remplacees = (fermees || []).length
    if (bilan.remplacees !== aRemplacer.length) {
      // La nuit a ete vendue entre-temps : c'est un cas normal, pas une erreur.
      // On le dit, parce qu'un ecart muet ici serait indiscernable d'un bug.
      console.log(`[price-log] ${aRemplacer.length - bilan.remplacees} nuit(s) vendue(s) `
        + `entre la lecture et la fermeture — ligne de vente preservee`)
    }
  }

  const { error: eIns } = await supabase.from('price_display_log').insert(aInserer)
  if (eIns) throw new Error(`[price-log] ouverture des nouvelles lignes : ${eIns.message}`)
  bilan.ouvertes = aInserer.length
  return bilan
}

// ─── Cloture par la vente ────────────────────────────────────────────────────
// Fige le prix affiche courant des nuits d'un sejour vendu.
//
// ⚠ AUCUN APPEL PROVIDER ICI (spec §4, et regle 6 de REVIEW.md). Les nuits
// viennent du snapshot deja ecrit par la couche sync, via le dispatcher
// `booking_change_events`. Ce module ne parle qu'a Supabase.
//
// ⚠ LES NUITS D'UN SEJOUR EXCLUENT LE JOUR DE DEPART.
// Un sejour du 12 au 15 occupe les nuits du 12, 13 et 14 — pas celle du 15,
// qui est revendable le jour meme. Poser `sold_at` dessus fermerait une ligne
// courante encore en vente et ferait disparaitre du journal un prix affiche
// bel et bien affiche.
function nuitsDuSejour (arrival, departure) {
  if (!estDateSejour(arrival) || !estDateSejour(departure)) return []
  const nuits = []
  const fin = new Date(`${departure}T00:00:00Z`)
  for (let d = new Date(`${arrival}T00:00:00Z`); d < fin; d.setUTCDate(d.getUTCDate() + 1)) {
    // Garde-fou : une date de depart aberrante servie par un provider ferait
    // boucler sur des annees. On coupe AVANT d'ajouter, sinon la borne rend
    // 401 nuits — un plafond qui depasse son propre plafond.
    if (nuits.length >= MAX_NUITS) break
    nuits.push(d.toISOString().slice(0, 10))
  }
  return nuits
}

async function cloturerVente (supabase, { propertyId, arrival, departure, bookingUid }) {
  const bilan = { fermees: 0, nuits: 0 }
  if (!supabase || !propertyId || !bookingUid) return bilan
  const nuits = nuitsDuSejour(arrival, departure)
  bilan.nuits = nuits.length
  if (!nuits.length) return bilan

  // Seules les lignes COURANTES se ferment. Une nuit deja vendue (sold_at pose
  // par une reservation precedente, puis annulee et revendue) garde sa premiere
  // cloture : le journal dit ce qui etait affiche, pas qui a achete en dernier.
  const { data, error } = await supabase
    .from('price_display_log')
    .update({ sold_at: new Date().toISOString(), sold_booking_uid: String(bookingUid) })
    .eq('property_id', propertyId)
    .in('stay_date', nuits)
    .is('replaced_at', null)
    .is('sold_at', null)
    .select('id')
  if (error) throw new Error(`[price-log] cloture a la vente : ${error.message}`)
  bilan.fermees = (data || []).length
  return bilan
}

module.exports = {
  enregistrerPrixPousses,
  cloturerVente,
  nuitsDuSejour,
  estDateSejour,
  centimesValides
}
