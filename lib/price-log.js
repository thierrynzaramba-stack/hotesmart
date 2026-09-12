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

const { canPushRates, estRelieAuCanal } = require('./rate-sync')

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
  // 'seed' = ligne d'amorcage recopiee du calendrier : son `created_at` ne dit
  // pas depuis quand le prix est affiche. Le marqueur existe pour que toute
  // analyse d'anciennete puisse l'ecarter — sans lui, le journal mentirait sur
  // ses propres dates sans qu'on puisse le savoir.
  if (!['host', 'engine', 'seed'].includes(source)) {
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

// ─── Reouverture apres annulation ────────────────────────────────────────────
// Decision de Thierry, 12 septembre 2026.
//
// ⚠ ON NE ROUVRE JAMAIS UNE LIGNE VENDUE — ELLE DIT LA VERITE.
// Cette nuit A ETE vendue, a ce prix, ce jour-la. Effacer `sold_at` reecrirait
// l'histoire, et le moteur perdrait la seule trace d'une vente qui a
// reellement eu lieu (un prix « qui marche » reste un prix qui a marche, meme
// si le voyageur s'est decommande ensuite).
//
// Ce qu'on fait a la place : OUVRIR UNE NOUVELLE LIGNE COURANTE au dernier prix
// connu du calendrier. C'est ce que l'OTA re-affiche des que la dispo rouvre,
// donc c'est la verite du moment — et la nuit redevient mesurable.
//
// ⚠ AUCUN APPEL PROVIDER (regle 6). Le prix vient de `calendar_inventory`, la
// memoire du coeur, avec repli sur `properties.base_price` — exactement la
// regle de `runFullSync` : « un prix de base est un prix ».
//
// IDEMPOTENT : si une ligne courante existe deja pour cette nuit (un full sync
// est passe entre l'annulation et nous), on ne touche a rien. C'est la meme
// garde que l'index unique partiel, verifiee avant d'ecrire plutot que subie.
async function rouvrirApresAnnulation (supabase, { propertyId, bookingUid, basePriceEur }) {
  const bilan = { rouvertes: 0, deja_courantes: 0, sans_prix: 0 }
  if (!supabase || !propertyId || !bookingUid) return bilan

  // Les nuits que CETTE reservation avait figees. On part du journal, pas des
  // dates du snapshot : si la reservation a ete modifiee avant d'etre annulee,
  // ce sont bien les nuits reellement fermees qu'il faut rouvrir.
  const { data: vendues, error } = await supabase
    .from('price_display_log')
    .select('stay_date')
    .eq('property_id', propertyId)
    .eq('sold_booking_uid', String(bookingUid))
  if (error) throw new Error(`[price-log] lecture des nuits vendues : ${error.message}`)
  if (!vendues?.length) return bilan

  let nuits = [...new Set(vendues.map(l => l.stay_date))].sort()

  // ⚠ ON NE ROUVRE PAS LE PASSE — releve en review.
  // `aRouvrir` vient du journal, qui n'a aucune borne temporelle. Or une
  // annulation arrive souvent APRES le debut du sejour (cote Beds24, le statut
  // bascule tardivement). Ouvrir une ligne courante sur une nuit revolue la
  // laisserait ouverte pour toujours : ni remplacement ni vente ne viendront
  // jamais la fermer, et elle polluerait indefiniment le denominateur
  // « affichee / non vendue ». Les trois autres points de capture partent tous
  // d'aujourd'hui.
  const aujourdHui = new Date()
  aujourdHui.setHours(0, 0, 0, 0)
  const bornee = `${aujourdHui.getFullYear()}-${String(aujourdHui.getMonth() + 1).padStart(2, '0')}-${String(aujourdHui.getDate()).padStart(2, '0')}`
  const passees = nuits.filter(d => d < bornee).length
  nuits = nuits.filter(d => d >= bornee)
  if (passees) bilan.passees = passees
  if (!nuits.length) return bilan

  // Une ligne courante existe-t-elle deja ? (full sync passe entre-temps)
  const { data: courantes, error: eC } = await supabase
    .from('price_display_log')
    .select('stay_date')
    .eq('property_id', propertyId)
    .in('stay_date', nuits)
    .is('replaced_at', null)
    .is('sold_at', null)
  if (eC) throw new Error(`[price-log] lecture des lignes courantes : ${eC.message}`)
  const dejaCourantes = new Set((courantes || []).map(l => l.stay_date))
  bilan.deja_courantes = dejaCourantes.size

  const aRouvrir = nuits.filter(d => !dejaCourantes.has(d))
  if (!aRouvrir.length) return bilan

  // Le dernier prix connu du coeur, nuit par nuit.
  //
  // ⚠ `calendar_inventory` EST CLEE SUR L'UUID, PAS SUR LA CLE PROVIDER.
  // C'est une exception a la regle 10, de la meme famille que celle de ce
  // journal : la table est ecrite par NOUS (`api/calendar.js` y pose
  // `property_id: bienId`), pas par la couche sync. La premiere version de ce
  // module supposait l'inverse et interrogeait avec `provider_property_id` :
  // zero ligne, aucune erreur, et TOUTES les nuits retombaient sur le prix de
  // base — qui est `null` sur quatre des cinq biens. Aucune nuit n'aurait ete
  // rouverte, en silence. Trouve par le dry-run de l'amorcage, pas par un test.
  const prixCalendrier = new Map()
  const { data: inv, error: eInv } = await supabase
    .from('calendar_inventory')
    .select('date, rate, stop_sell, avail')
    .eq('property_id', propertyId)
    .in('date', aRouvrir)
  if (eInv) throw new Error(`[price-log] lecture du calendrier : ${eInv.message}`)
  // ⚠ UNE NUIT FERMEE N'EST PAS ROUVERTE — releve en review.
  // C'est l'invariant du journal, respecte partout ailleurs (api/calendar.js,
  // channel-fullsync.js, amorcer-price-log.js) et qui manquait ici. Les biens de
  // Bagneres sont « tout ferme a la vente jusqu'a verification » : une annulation
  // sur ces dates aurait ouvert une ligne au tarif du calendrier pour des nuits
  // qu'aucun voyageur ne peut reserver — le mensonge exact que ce module
  // interdit trois paragraphes plus haut.
  //
  // ⚠ ET UNE NUIT SANS LIGNE DE CALENDRIER EST FERMEE, ELLE AUSSI.
  // `runFullSync` traite l'absence de ligne comme `availability: 0`. On ne
  // retombe donc sur le prix de base QUE si une ligne existe et laisse la nuit
  // ouverte.
  const ferme = new Set()
  const connue = new Set()
  for (const l of inv || []) {
    connue.add(l.date)
    if (l.stop_sell === true || l.avail === 0) { ferme.add(l.date); continue }
    if (l.rate != null && Number(l.rate) > 0) {
      prixCalendrier.set(l.date, Math.round(Number(l.rate) * 100))
    }
  }

  const baseCents = Number(basePriceEur) > 0 ? Math.round(Number(basePriceEur) * 100) : null
  const nuitsAOuvrir = {}
  for (const d of aRouvrir) {
    if (ferme.has(d) || !connue.has(d)) { bilan.fermees = (bilan.fermees || 0) + 1; continue }
    const cents = prixCalendrier.has(d) ? prixCalendrier.get(d) : baseCents
    // Pas de prix : `runFullSync` fermerait la date (`stop_sell`), donc rien
    // n'est affiche. On n'invente pas une ligne pour une nuit invendable.
    if (cents == null) { bilan.sans_prix++; continue }
    nuitsAOuvrir[d] = cents
  }
  if (!Object.keys(nuitsAOuvrir).length) return bilan

  // ⚠ LES MEMES GARDES QUE TOUT CHEMIN TARIFAIRE — releve en review.
  // `lib/rate-sync.js` pose la regle : un prix ne compte comme AFFICHE que si
  // HoteSmart le pousse reellement. Les trois autres points de capture la
  // respectent ; celui-ci ne l'avait pas. Sans elle, une annulation sur un bien
  // en `keep` — ou sur un bien Beds24, que nous ne pilotons pas — inscrivait au
  // journal un « prix affiche » que nous n'avons jamais envoye.
  const { data: hote } = await supabase
    .from('properties')
    .select('user_id, provider, rate_sync_mode')
    .eq('id', propertyId).maybeSingle()
  if (!hote?.user_id) return bilan
  if (!canPushRates(hote) || !estRelieAuCanal(hote)) {
    bilan.non_pousse = true
    return bilan
  }

  const r = await enregistrerPrixPousses(supabase, {
    userId: hote.user_id, propertyId, nuits: nuitsAOuvrir, source: 'host'
  })
  bilan.rouvertes = r.ouvertes
  return bilan
}

/**
 * LES DATES QUI VIENNENT DE PASSER DE FERMEES A OUVERTES, ET QUI PORTAIENT
 * DEJA UN TARIF. Fonction PURE : elle ne lit ni n'ecrit rien.
 *
 * ⚠ POURQUOI ELLE EXISTE — lacune trouvee le 12 septembre 2026 en verifiant
 * le journal de Coeur de vie 23.
 * Le point de capture d'`api/calendar.js` ne voyait que les POUSSEES DE PRIX.
 * Or une nuit peut devenir affichee sans qu'un prix soit pousse : elle portait
 * deja un tarif en base — ecrit par un `runFullSync` ou une saisie
 * anterieure — et l'hote se contente de l'OUVRIR. Le prix devient alors
 * visible du voyageur sans qu'aucune ligne de journal existe.
 *
 * Mesure du defaut : 14 nuits de week-end d'octobre et novembre portaient 110
 * ou 130 EUR depuis le 10 septembre, etaient FERMEES lors de l'amorcage — donc
 * legitimement non amorcees, « une nuit fermee n'a jamais ete affichee » —
 * puis ont ete ouvertes le 12 au matin par un segment qui ne portait que la
 * disponibilite. Pour le moteur, ces nuits n'avaient jamais eu de prix.
 *
 * ⚠ UN GESTE EXPLICITE EST EXIGE — releve en review du correctif lui-meme.
 * La premiere version parcourait TOUTES les dates touchees par la requete.
 * Une date sans ligne en base dont l'hote ne modifiait que le sejour minimum
 * passait alors pour une ouverture : `etatAvant` absent valait « fermee »,
 * l'objet neuf n'avait ni `stop_sell` ni `avail` donc passait pour « ouverte »,
 * et le prix de base etait journalise. Le calendrier mobile pousse un segment
 * PAR PARAMETRE sur la meme plage : regler « sejour minimum 2 » sur octobre et
 * novembre aurait fabrique cinquante lignes « prix affiche » pour des nuits que
 * personne ne peut reserver. `gestes` dit quelles dates portent reellement une
 * decision de disponibilite.
 *
 * @param {Object} etatAvant   date -> ligne `calendar_inventory` AVANT ecriture
 * @param {Object} etatApres   date -> ligne APRES fusion des segments
 * @param {Object} options
 *   - gestes       date -> { avail: bool, stopSell: bool } : quel champ le geste
 *                  de l'hote porte pour cette date. SANS LUI, RIEN N'EST RETENU.
 *   - dejaPousses  date -> centimes, les tarifs pousses dans le meme geste
 *   - basePrice    prix de base du bien, en EUROS (repli, meme regle que le
 *                  full sync : sans tarif du jour ET sans base_price, la date
 *                  part FERMEE, donc rien n'est affiche)
 *   - bien         le bien, pour le plancher (`prix_minimum`)
 * @returns {Object} date -> { cents, flux: ['availability'|'restrictions'] }
 */
function ouverturesDeDatesTarifees (etatAvant, etatApres, options = {}) {
  const { dejaPousses = {}, basePrice = null, gestes = null, bien = null } = options
  const out = {}
  // ⚠ SANS GESTE DECLARE, ON NE RETIENT RIEN. Le defaut par defaut est de ne
  // pas journaliser : une ligne de trop est un mensonge definitif dans un
  // journal non retroactif, une ligne manquante est une donnee absente.
  if (!gestes) return out

  for (const ds of Object.keys(etatApres || {})) {
    const geste = gestes[ds]
    if (!geste || (!geste.avail && !geste.stopSell)) continue
    // Un tarif pousse dans le meme geste est deja journalise par l'autre
    // chemin : le compter ici ouvrirait deux lignes pour un seul changement.
    if (dejaPousses[ds] != null) continue

    const apres = etatApres[ds]
    if (!apres || !estOuverte(apres)) continue

    // ⚠ PAS DE LIGNE AVANT = FERMEE, jamais « inconnue ».
    // Meme regle que `runFullSync` et que l'amorcage : l'absence de memoire
    // d'intention vaut `availability: 0`. La supposer ouverte journaliserait
    // des nuits qui n'ont jamais ete affichees.
    const avant = (etatAvant || {})[ds]
    if (avant && estOuverte(avant)) continue      // deja ouverte : rien de neuf

    // ⚠ MEME REGLE DE PRIX QUE `runFullSync`, MOT POUR MOT.
    // Un `rate` nul ou <= 0 n'est pas un prix : c'est l'absence d'exception,
    // et on retombe sur le prix de base.
    const prixEur = (apres.rate != null && Number(apres.rate) > 0)
      ? Number(apres.rate)
      : (Number(basePrice) > 0 ? Number(basePrice) : null)
    if (prixEur === null) continue
    const cents = Math.round(prixEur * 100)
    if (!centimesValides(cents)) continue

    // ⚠ LE PLANCHER FERME LA DATE, DONC RIEN N'EST AFFICHE — releve en review.
    // `runFullSync` ferme toute date sous `prix_minimum` et ne pousse aucun
    // prix. Sans ce test, le journal aurait inscrit 8 EUR pendant que le cycle
    // suivant fermait la meme nuit : les deux points de capture auraient dit
    // l'inverse l'un de l'autre sur la meme nuit.
    if (bien) {
      const { tarifAcceptable } = require('./yield/prix-plancher')
      if (!tarifAcceptable(cents, bien).ok) continue
    }

    // ⚠ L'ORIGINE DECIDE DU FLUX A VALIDER, et c'est par DATE, pas par lot.
    // Une ouverture par `avail` part en `/availability` ; une levee de
    // `stop_sell` part en `/restrictions`. Classer par lot faisait valider une
    // levee de stop_sell contre un flux qui ne la portait pas — donc rien de
    // journalise quand le geste ne touchait pas la disponibilite (le defaut
    // d'origine, intact), et une ligne ecrite a tort quand `/restrictions`
    // echouait pendant que `/availability` reussissait ailleurs.
    const flux = []
    if (geste.avail) flux.push('availability')
    if (geste.stopSell) flux.push('restrictions')
    out[ds] = { cents, flux }
  }
  return out
}

// Ouverte = ni intention de fermeture, ni stock a zero. ⚠ `Number()`, pas
// `=== 0` : `etatApres` melange des lignes relues en base (Postgres rend un
// nombre) et des valeurs venues du corps de la requete, qui n'est pas type.
// Un `avail: "0"` echappait a la comparaison stricte et faisait passer une
// date fermee pour ouverte (regle 4 de REVIEW.md).
function estOuverte (l) {
  if (!l) return false
  if (l.stop_sell === true || String(l.stop_sell) === 'true') return false
  if (l.avail != null && Number(l.avail) === 0) return false
  return true
}

/**
 * L'ENSEMBLE FINAL A JOURNALISER : chaque origine validee contre le flux qui
 * la porte, ET contre ce qui est REELLEMENT parti. Fonction PURE.
 *
 * ⚠ `availability.ok` N'EST PAS UN VERDICT PAR DATE — releve en review.
 * `pousserAri` le pose des qu'un appel HTTP reussit, quelle que soit la date
 * qu'il portait. Le bloc de plafonnement peut avoir RETIRE une ouverture de la
 * poussee (nuit deja vendue, ou echec de `nuitsOccupees`) tout en laissant
 * partir une fermeture : l'appel reussit, `ok` vaut `true`, et la date retiree
 * serait journalisee comme affichee alors qu'elle est restee fermee chez le
 * provider. C'est le mode de panne du 11-12 septembre, transforme en mensonge
 * inscrit dans un journal qui ne se rattrape pas.
 *
 * On exige donc que la date soit PRESENTE, ouverte, dans ce qui est parti.
 *
 * @param {Object} options
 *   - prixPousses   date -> centimes (tarifs pousses)
 *   - ouvertures    date -> { cents, flux } (sortie de la fonction ci-dessus)
 *   - resultats     `resultatsPoussee` : { restrictions?: {ok}, availability?: {ok} }
 *   - availEnvoyees date -> valeur de disponibilite REELLEMENT poussee
 */
function nuitsAJournaliser (options = {}) {
  const { prixPousses = {}, ouvertures = {}, resultats = {}, availEnvoyees = null } = options
  const out = {}
  const restrictionsOk = !!(resultats.restrictions && resultats.restrictions.ok)
  const availabilityOk = !!(resultats.availability && resultats.availability.ok)

  if (restrictionsOk) Object.assign(out, prixPousses)

  for (const [ds, o] of Object.entries(ouvertures)) {
    if (!o || !Array.isArray(o.flux) || !o.flux.length) continue
    // TOUS les flux portant l'ouverture doivent avoir abouti : un geste qui
    // touche les deux n'est affiche que si les deux sont partis.
    const okFlux = o.flux.every(f =>
      f === 'availability' ? availabilityOk : restrictionsOk)
    if (!okFlux) continue
    if (o.flux.includes('availability')) {
      // La date doit figurer dans ce qui est REELLEMENT parti, ouverte.
      if (!availEnvoyees) continue
      const v = availEnvoyees[ds]
      if (v == null || Number(v) <= 0) continue
    }
    out[ds] = o.cents
  }
  return out
}

module.exports = {
  enregistrerPrixPousses,
  cloturerVente,
  rouvrirApresAnnulation,
  nuitsDuSejour,
  estDateSejour,
  centimesValides,
  ouverturesDeDatesTarifees,
  nuitsAJournaliser,
  estOuverte
}
