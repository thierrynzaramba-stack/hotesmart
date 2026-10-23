const { supabase, getSignatureForKey, SENDVIABEDS24_ENABLED } = require('./cron-shared')
const { colonneAbsente } = require('./colonne-absente')

// ─── Refresh automatique tokens Beds24 ───────────────────────────────────────
// Tourne à chaque cron (5 min). Les tokens Beds24 expirent en 24h, les refresh
// tokens en 30 jours d'inutilisation. Tant que le cron tourne, tout reste valide.
// ─── Le renouvellement du jeton Beds24 ───────────────────────────────────────
//
// ⚠ IL PARTAIT A CHAQUE PASSAGE DU CRON, SOIT 288 FOIS PAR JOUR, SANS JAMAIS
// REGARDER SI LE JETON COURANT ETAIT ENCORE VALIDE. Mesure du 23 octobre 2026
// sur 209 passages : 184 secondes cumulees — deuxieme poste de TEMPS du cron,
// alors que la tache n'est que 10e en requetes. Et le parc ne compte AUCUN bien
// Beds24 actif : on renouvelait un jeton que rien d'autre n'utilise.
//
// LA REGLE, POSEE PAR THIERRY LE 23 OCTOBRE 2026 : stocker l'heure
// d'expiration REELLE (`expiresIn` de la reponse) et ne renouveler que lorsqu'il
// reste moins de 30 minutes, quel que soit le cas.
//
// ⚠ ET SES DEUX EXIGENCES SE RAMENENT A UNE SEULE REGLE — verifie, pas suppose.
// Il demandait aussi « s'il n'y a plus aucun bien Beds24 actif, un
// renouvellement par jour suffit a garder le jeton de renouvellement en vie »
// (il meurt apres 30 jours sans usage). Or la regle des 30 minutes le donne
// GRATUITEMENT :
//   · duree de vie 24 h (ce qu'annonce la doc) -> renouvellement toutes les
//     23 h 30, soit 1,02 par jour ;
//   · duree de vie 3600 s (ce qu'affiche un exemple de la doc) -> toutes les
//     30 minutes, soit 48 par jour.
// Dans les deux cas le jeton de renouvellement est utilise au moins une fois
// par jour, donc il ne peut pas atteindre 30 jours d'inactivite. Aucun code de
// maintien en vie a ecrire : il serait mort, et un code mort fait croire que la
// classe de defauts est fermee ailleurs.
//
// ⚠ UNE DUREE DE VIE COURTE NE DOIT PAS RESTAURER LES 288 APPELS. Si `expiresIn`
// valait 600 s, « il reste moins de 30 minutes » serait TOUJOURS vrai et on
// repartirait a chaque cycle. La marge est donc le MINIMUM de 30 minutes et de
// la moitie de la duree de vie : on renouvelle au plus tard a mi-vie, jamais a
// chaque passage.
//
// ⚠ ET TOUT DOUTE RENOUVELLE. Heure d'expiration absente (premier passage apres
// la migration), illisible, `expiresIn` absent ou absurde : on renouvelle. Un
// jeton Beds24 expire casse TOUTE la synchro de l'hote ; economiser un appel ne
// vaut pas ce risque. C'est la seule asymetrie de cette fonction, et elle est
// volontaire.
const MARGE_MAX_MS = 30 * 60 * 1000
// Duree de vie de repli quand la reponse n'en donne aucune : la doc annonce
// 24 h, on prend une heure — si Beds24 passait a une duree courte sans le dire,
// un repli optimiste laisserait un jeton mort en base.
const VIE_DE_REPLI_MS = 60 * 60 * 1000

// Faut-il renouveler ? Pure, donc eprouvable cas par cas.
function doitRenouveler (expireLe, maintenantMs, dureeVieMs = null) {
  if (!expireLe) return true                       // inconnu = on renouvelle
  const t = new Date(expireLe).getTime()
  if (!Number.isFinite(t)) return true             // illisible = on renouvelle
  const vie = Number.isFinite(dureeVieMs) && dureeVieMs > 0 ? dureeVieMs : MARGE_MAX_MS * 2
  const marge = Math.min(MARGE_MAX_MS, Math.floor(vie / 2))
  return (t - maintenantMs) < marge
}

// `expiresIn` -> millisecondes. Beds24 le donne en SECONDES. Une valeur absente,
// nulle, negative ou delirante (plus de 30 jours) retombe sur le repli : on
// prefere renouveler trop tot que porter une expiration inventee.
const TRENTE_JOURS_MS = 30 * 24 * 60 * 60 * 1000
function dureeDeVieMs (expiresIn) {
  const n = Number(expiresIn)
  if (!Number.isFinite(n) || n <= 0) return { ms: VIE_DE_REPLI_MS, mesuree: false }
  const ms = n * 1000
  if (ms > TRENTE_JOURS_MS) return { ms: VIE_DE_REPLI_MS, mesuree: false }
  return { ms, mesuree: true }
}

async function refreshBeds24Tokens ({ maintenant = Date.now() } = {}) {
  // ⚠ LA FENETRE ENTRE LE PUSH ET LA MIGRATION, ET ELLE EST DANGEREUSE ICI.
  // Dans ce depot la migration se colle A LA MAIN apres le push : il y a donc
  // toujours un moment ou le code nomme `token_expire_le` et ou la base ne l'a
  // pas. Un `select` qui la nomme echoue EN ENTIER (42703), et mon garde-fou
  // « une lecture tombee n'est pas aucune cle » rendrait alors
  // `{ erreur }` — donc PLUS AUCUN RENOUVELLEMENT, pour de bon. Le jeton de
  // renouvellement meurt apres 30 jours sans usage : la fenetre de deploiement
  // deviendrait une bombe a retardement de trente jours.
  // On relit donc SANS la colonne, et on renouvelle comme avant le lot — c'est
  // `lib/colonne-absente.js`, et c'est exactement ce pour quoi il existe.
  let keys = null
  let sansExpiration = false
  {
    const lu = await supabase
      .from('api_keys')
      .select('user_id, refresh_token, token_expire_le')
      .not('refresh_token', 'is', null)
    if (lu.error && colonneAbsente(lu.error)) {
      console.warn('[Beds24] token_expire_le absente (migration 2026-10-23 non appliquee) :'
        + ' renouvellement a chaque passage, comme avant le lot')
      sansExpiration = true
      const repli = await supabase
        .from('api_keys')
        .select('user_id, refresh_token')
        .not('refresh_token', 'is', null)
      if (repli.error) {
        console.error('[Beds24] lecture des cles echec, renouvellement non tente :', repli.error.message)
        return { lues: 0, renouveles: 0, sautes: 0, erreur: repli.error.message }
      }
      keys = repli.data
    } else if (lu.error) {
      // ⚠ UNE LECTURE TOMBEE N'EST PAS « AUCUNE CLE A RENOUVELER ». Sans ce
      // test, une panne de 30 jours laisserait mourir le jeton en silence — et
      // personne ne verrait rien avant que la synchro ne tombe.
      console.error('[Beds24] lecture des cles echec, renouvellement non tente :', lu.error.message)
      return { lues: 0, renouveles: 0, sautes: 0, erreur: lu.error.message }
    } else {
      keys = lu.data
    }
  }
  if (!keys?.length) return { lues: 0, renouveles: 0, sautes: 0, sansExpiration }

  let renouveles = 0, sautes = 0
  for (const key of keys) {
    if (!sansExpiration && !doitRenouveler(key.token_expire_le, maintenant)) {
      sautes++
      continue
    }
    try {
      const r = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: { accept: 'application/json', refreshToken: key.refresh_token }
      })
      const d = await r.json()
      if (d.token) {
        const { ms, mesuree } = dureeDeVieMs(d.expiresIn)
        const expireLe = new Date(maintenant + ms).toISOString()
        // Sans la migration, on n'ecrit que ce qui existe : nommer une colonne
        // absente ferait echouer l'UPDATE en entier, donc perdre le jeton neuf.
        const champs = sansExpiration
          ? { api_key: d.token }
          : { api_key: d.token, token_expire_le: expireLe, token_renouvele_le: new Date(maintenant).toISOString() }
        const { error: eMaj } = await supabase
          .from('api_keys')
          .update(champs)
          .eq('user_id', key.user_id)
        // ⚠ UNE ECRITURE RATEE NE DOIT PAS SE LIRE « RENOUVELE ». Sans ce test,
        // le jeton neuf vivrait en memoire et la base garderait l'ancien avec
        // son ancienne expiration : on renouvellerait a chaque cycle sans
        // jamais s'en apercevoir.
        if (eMaj) {
          console.error(`[Beds24] jeton renouvele mais NON ENREGISTRE user ${key.user_id} :`, eMaj.message)
          continue
        }
        renouveles++
        console.log(`[Beds24] jeton renouvele user ${key.user_id}`
          + ` — duree de vie ${Math.round(ms / 1000)} s${mesuree ? ' (donnee par Beds24)' : ' (REPLI : expiresIn absent ou absurde)'}`
          + `, expire le ${expireLe}`)
      } else {
        console.error(`[Beds24] renouvellement refuse user ${key.user_id} :`, d.error)
      }
    } catch (err) {
      console.error(`[Beds24] erreur de renouvellement user ${key.user_id} :`, err.message)
    }
  }
  return { lues: keys.length, renouveles, sautes, sansExpiration }
}

// ─── Fetch properties ────────────────────────────────────────────────────────
// La FICHE COMPLETE (etape 1B) : ce que Beds24 sert sur un bien passe de 157 a
// 330 champs avec ces `include` — chambres, unites, offres, regles de prix,
// ventes additionnelles. Mesure du 8 septembre 2026.
//
// ⚠ CE QUE BEDS24 NE SERT PAS, MEME EN LE DEMANDANT : ni descriptions ni
// photos. `includeTexts` et `includePictures` sont ACCEPTES (HTTP 200) mais
// aucune cle `texts`/`pictures` ne revient, et les 8 `templates` sont vides sur
// les deux biens. On les demande quand meme : le jour ou un compte les porte,
// ils entreront sans changement de code. L'editorial vient d'ailleurs.
const FICHE_COMPLETE = '&includeTexts=true&includePictures=true'
  + '&includeAllRooms=true&includeUnitDetails=true'
  + '&includeOffers=true&includePriceRules=true&includeUpsellItems=true'

// `complet` est OPT-IN : trois appelants existants (api/cron.js, extract-kb,
// backfill-beds24-host) n'ont besoin que de la liste des biens, et payer un
// payload deux fois plus gros a chaque cycle */5 pour rien serait absurde.
async function fetchProperties(beds24Key, { complet = false, id = null } = {}) {
  const params = (id != null ? `&id=${encodeURIComponent(id)}` : '') + (complet ? FICHE_COMPLETE : '')
  const r = await fetch('https://beds24.com/api/v2/properties' + (params ? '?' + params.slice(1) : ''), {
    headers: { token: beds24Key }
  })
  const d = await r.json()
  // Une erreur API rendait `[]` sans un mot — meme defaut que fetchBookings,
  // meme correctif : on le CRIE plutot que de s'endormir sur une liste vide.
  if (d.success === false) {
    console.error('[Beds24] fetchProperties echec', JSON.stringify(d).slice(0, 200))
  }
  return d.data || []
}

// ─── Statuts Beds24 demandes explicitement ───────────────────────────────────
// ⚠ GET /bookings EXCLUT LES ANNULATIONS PAR DEFAUT, et ne le dit nulle part :
// pas d'erreur, pas d'indice, la reservation disparait simplement de la reponse.
// Consequence mesuree en production sur le bien 209413 : une reservation
// confirmee puis annulee n'est jamais revue par le writer, donc detectChange ne
// voit aucune transition et le snapshot reste `confirmed` POUR TOUJOURS. Trois
// reservations annulees etaient encore actives en base, dont une a venir
// (92209790, 12-13 septembre 2026) : menage notifie, code d'acces pose et
// message envoye pour un sejour qui n'existe plus.
//
// Demander la liste complete coute le meme prix (1,5 credit par page, mesure).
const TOUS_STATUTS = ['new', 'confirmed', 'request', 'inquiry', 'black', 'cancelled']
  .map(s => `&status=${s}`).join('')

// ─── Lignes de facture ───────────────────────────────────────────────────────
// ⚠ SANS CE PARAMETRE, `invoiceItems` N'EST PAS SERVI DU TOUT.
// L'inventaire de l'etape 0 a ete mene avec `includeInvoiceItems=true` dans des
// appels manuels, et les conclusions en dependent — mais le code de production ne
// l'a jamais demande. Deux consequences silencieuses :
//   - `totalCharges()` (lib/bookings-snapshot.js) rend toujours 0 dans le cron,
//     donc le repli de `montantBeds24` sur saisie directe n'a JAMAIS pu se
//     declencher en production.
//   - le `raw` conserve par le sous-chantier A n'aurait porte aucune ligne de
//     facture, alors que c'est le premier argument de la colonne.
// Surcout mesure : 1,6 credit par page au lieu de 1,5.
const AVEC_FACTURES = '&includeInvoiceItems=true'

// ─── Le reste du payload brut (sous-chantier A, volet « champs non captures ») ─
// ⚠ TROIS `include` MANQUAIENT AU `raw`, ET AUCUN NE SE VOIT SANS LES DEMANDER.
// L'inventaire du 8 septembre 2026 a compte 71 champs dans les `raw` conserves
// contre 74 servis par l'API : `infoItems`, `guests` et `bookingGroup` n'ont
// jamais ete demandes. `infoItems` n'est pas decoratif — il porte les drapeaux
// OTA reels (constate : BOOKINGCOMFLAG / « booker is genius »).
//
// ⚠ ET IL FAUT LES DEMANDER DANS LES *TROIS* FETCHS, PAS SEULEMENT DANS CELUI
// DU WRITER. `bookings_snapshot` a DEUX alimentateurs Beds24 : cron-bookings
// (via fetchBookings) et cron-classify (via fetchBookingsHistory -> syncBookings).
// Enrichir un seul des deux ferait osciller `raw_hash` a chaque cycle */5 —
// l'un ecrivant un payload riche, l'autre le remplacant par un payload pauvre,
// indefiniment. C'est la forme aigue de la dette « double writer Beds24 ».
//
// Surcout mesure le 8 septembre 2026 (bien 209413, page de 100 reservations) :
// 1,9 credit par page au lieu de 1,6, soit +0,3 ; +12 Ko sur 186 (+6 %).
// Pire cas par bien et par cycle */5 : TROIS appelants de fetchBookings
// (cron-bookings, cron-messages, cron-arrival-code = 3 pages) + history
// (5 pages) = 8 pages, soit +2,4 credits, sur un budget de 100 par fenetre de
// 5 minutes. Avec deux biens Beds24 : ~38 credits par cycle, marge confortable —
// c'est ce chiffre qu'il faudra relire le jour ou le parc grandira.
const AVEC_DETAILS = '&includeInfoItems=true&includeGuests=true&includeBookingGroup=true'

// ─── Fetch bookings ──────────────────────────────────────────────────────────
// ATTENTION : Beds24 ignore le filtre propId côté API, on filtre côté client.
//
// `includeCancelled` est OPT-IN, et c'est deliberé. TROIS appelants partagent
// cette fonction — les verifier tous avant d'en changer le defaut :
//   - lib/cron-bookings.js (writer de snapshots) : demande les annulees, c'est
//     tout l'objet du correctif.
//   - lib/cron-messages.js (envoi des templates arrival/departure) : ne les
//     demande PAS. Ce chemin envoie un message par booking rapporte ; lui servir
//     les annulees enverrait « bienvenue » et « bon retour » a des voyageurs
//     dont le sejour est annule. Il filtre en plus par isActiveStatus.
//   - api/cron.js (fenetre 0/+2j) -> lib/cron-arrival-code.js : POSE LES CODES DE
//     SERRURE. Il filtre deja par isActiveStatus, mais un code d'acces ouvert pour
//     un sejour annule est le pire des trois cas : le verifier en premier.
// Un defaut a false garantit qu'aucun appelant existant ne change de
// comportement sans qu'on l'ait ecrit.
async function fetchBookings(beds24Key, propertyId, { daysBefore = 1, daysAfter = 90, includeCancelled = false } = {}) {
  const today = new Date()
  const dateFrom = new Date(today); dateFrom.setDate(today.getDate() - daysBefore)
  const dateTo   = new Date(today); dateTo.setDate(today.getDate() + daysAfter)

  const url = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`
    + `&arrivalTo=${dateTo.toISOString().split('T')[0]}`
    + (includeCancelled ? TOUS_STATUTS : '')
    + AVEC_FACTURES
    + AVEC_DETAILS

  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  // Une erreur API rendait `[]` sans un mot : detectBookingChanges passait alors
  // une liste vide au writer, donc plus aucun snapshot mis a jour ni changement
  // detecte, et rien dans les logs pour le dire. D'autant moins acceptable qu'on
  // vient d'ajouter six parametres `status` a cette URL : si Beds24 les refuse un
  // jour, le cron doit le CRIER, pas s'endormir.
  if (d.success === false) {
    console.error(`[Beds24] fetchBookings ${propertyId} echec`, JSON.stringify(d).slice(0, 200))
  }
  return (d.data || []).filter(b => String(b.propertyId) === String(propertyId))
}

// ─── Fetch bookings passés (pour classification messages) ────────────────────
// ⚠ PAGINE. Sans cela, seule la premiere page etait lue : l'API plafonne a 100
// reservations par page et signale la suite dans `pages.nextPageExists`, que
// l'ancien code ignorait. Sur le bien 209413, six mois d'historique en comptent
// plus de 100 — le reste etait perdu en silence, et lib/cron-classify.js
// rattachait donc les messages a un sous-ensemble arbitraire des sejours.
//
// Les annulees restent HORS de ce fetch : la classification rattache un message
// a un sejour reel, et le plafond de pages borne le cout comme la memoire.
//
// ⚠ CE FETCH TOURNE A CHAQUE CYCLE `*/5`, PAR BIEN (api/cron.js -> cron-classify).
// Chaque page coute 1,5 credit sur un budget Beds24 de 100 par fenetre glissante
// de 5 minutes, et un appel HTTP en serie dans un cycle deja mesure a 40-56 s pour
// un plafond Vercel de 60 s. Le plafond est donc volontairement BAS : 5 pages =
// 500 reservations sur six mois, tres au-dela du besoin reel (181 sur le bien le
// plus charge). Il borne le pire cas a 7,5 credits et ~2 s par bien.
const PAGE_MAX = 5

async function fetchBookingsHistory(beds24Key, propertyId, monthsBack = 6) {
  const dateFrom = new Date()
  dateFrom.setMonth(dateFrom.getMonth() - monthsBack)

  const base = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`
    + AVEC_FACTURES
    + AVEC_DETAILS

  const out = []
  for (let page = 1; page <= PAGE_MAX; page++) {
    const r = await fetch(`${base}&page=${page}`, { headers: { token: beds24Key } })
    const d = await r.json()
    if (d.success === false) {
      // `return`, pas `break` : sortir par la boucle ferait passer l'echec sous le
      // warn « plafond atteint » ci-dessous, qui enverrait le diagnostic dans la
      // mauvaise direction. Deux troncatures differentes, deux messages differents.
      console.error(`[Beds24] fetchBookingsHistory ${propertyId} page ${page} echec, historique tronque`, JSON.stringify(d).slice(0, 200))
      return out
    }
    out.push(...(d.data || []))
    if (!d.pages?.nextPageExists) return out
  }
  // Plafond atteint : on rend ce qu'on a, mais on le DIT. Un historique
  // silencieusement tronque est exactement le defaut qu'on corrige ici.
  console.warn(`[Beds24] fetchBookingsHistory ${propertyId} : plafond de ${PAGE_MAX} pages atteint, historique tronque`)
  return out
}

// ─── Fetch INTEGRAL d'un bien (backfill historique, hors cron) ───────────────
// Toute la profondeur disponible, annulations comprises, factures comprises.
// Mesure sur le bien 209413 : 1 413 reservations depuis septembre 2022
// (1 234 actives + 179 annulees), 13 pages, ~24 credits.
//
// Vit ICI, dans le module Beds24 de production, et non dans le script de backfill :
// la lecon du chantier precedent est qu'un parametre present dans des appels
// manuels mais absent du code livre (`includeInvoiceItems`) produit un ecart
// silencieux entre ce qu'on croit avoir mesure et ce que la prod collecte.
//
// ⚠ HORS CRON. Cette fonction n'a AUCUNE borne de date et pagine jusqu'a 40 pages :
// elle ne doit jamais etre appelee depuis le cycle */5. Les fetchs du cron restent
// bornes (fetchBookings : -1j/+90j ; fetchBookingsHistory : -6 mois, 5 pages).
//
// `onProgress` recoit ({ page, cumul, creditsRestants }) : le script de backfill
// s'en sert pour son journal et son curseur de reprise.
// `attendreCredits` est injectable pour les tests (aucune attente reelle).
const PAGE_MAX_INTEGRAL = 40
const CREDITS_PLANCHER = 30     // marge : la cle est partagee avec le cron */5

async function fetchBookingsIntegral(beds24Key, propertyId, {
  depuis = '2015-01-01',
  onProgress = null,
  attendreCredits = (ms) => new Promise(r => setTimeout(r, ms))
} = {}) {
  const base = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${depuis}`
    + TOUS_STATUTS
    + AVEC_FACTURES
    + AVEC_DETAILS

  const out = []
  let creditsRestants = undefined     // undefined avant la 1re mesure ; null = illisible

  for (let page = 1; page <= PAGE_MAX_INTEGRAL; page++) {
    // Throttle : la cle Beds24 est partagee avec le cron, qui tourne toutes les
    // 5 minutes et consomme ~7,5 credits par bien. On garde une marge franche
    // plutot que de courir apres un 429 qui casserait aussi le refresh du token.
    // `creditsRestants === null` = valeur inconnue ou illisible -> ON FAIT LA PAUSE.
    // La version precedente traitait l'inconnu comme « tout va bien » : si Beds24
    // cessait de servir l'en-tete, les 40 pages partaient d'affilee sur une cle
    // partagee avec le cron */5 — le 429 que ce bloc pretend eviter, refresh du
    // token compris. Face a l'ignorance, on ralentit ; c'est le seul defaut sur.
    if (creditsRestants !== undefined && (creditsRestants === null || creditsRestants < CREDITS_PLANCHER)) {
      console.log(`[Beds24] backfill : credits ${creditsRestants === null ? 'inconnus' : creditsRestants}, pause 60 s`)
      await attendreCredits(60000)
      creditsRestants = undefined      // undefined = « pas encore mesure sur ce tour »
    }

    const r = await fetch(`${base}&page=${page}`, { headers: { token: beds24Key } })
    // `Number.isFinite` : un en-tete present mais non numerique donnerait NaN, et
    // `NaN < CREDITS_PLANCHER` vaut false — le throttle ne s'enclencherait JAMAIS
    // et le backfill tournerait a plein regime sur une cle partagee avec le cron.
    // C'est exactement le 429 que ce bloc cherche a eviter, et il casserait aussi
    // le refresh du token. Valeur illisible -> on traite comme inconnue.
    const brut = parseFloat(r.headers.get('x-five-min-limit-remaining'))
    creditsRestants = Number.isFinite(brut) ? brut : null

    const d = await r.json()
    if (d.success === false) {
      console.error(`[Beds24] fetchBookingsIntegral ${propertyId} page ${page} echec`, JSON.stringify(d).slice(0, 200))
      return { bookings: out, complet: false, pages: page, raison: 'echec_api' }
    }
    // ⚠ FILTRE COTE CLIENT OBLIGATOIRE, comme dans fetchBookings : Beds24 IGNORE
    // `propId` et rend tout le compte. Le filtre appartient a la fonction, pas a
    // ses appelants — un appelant qui l'oublierait ecrirait les reservations de
    // TOUS les biens sous un seul property_id.
    out.push(...(d.data || []).filter(b => String(b.propertyId) === String(propertyId)))
    if (onProgress) onProgress({ page, cumul: out.length, creditsRestants })
    if (!d.pages?.nextPageExists) {
      return { bookings: out, complet: true, pages: page, raison: null }
    }
  }
  console.warn(`[Beds24] fetchBookingsIntegral ${propertyId} : plafond de ${PAGE_MAX_INTEGRAL} pages atteint`)
  return { bookings: out, complet: false, pages: PAGE_MAX_INTEGRAL, raison: 'plafond_pages' }
}

// ─── Fetch messages ──────────────────────────────────────────────────────────
async function fetchMessages(beds24Key, propertyId, limit = 100) {
  const url = `https://beds24.com/api/v2/bookings/messages?propId=${propertyId}&limit=${limit}`
  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  return (d.data || []).filter(m => String(m.propertyId) === String(propertyId))
}

// ─── Envoi message au voyageur via Beds24 ────────────────────────────────────
// Signature GuestFlow : UNIQUEMENT pour les comptes sans abonnement actif
// (mécanisme viral du plan gratuit). Résolution via getSignatureForKey.
// Contrôlé par SENDVIABEDS24_ENABLED (flag env Vercel) pour bascule safe.
// Fonctionne pour réservations OTA uniquement (Airbnb, Booking.com).
// Les réservations directes (channel vide) échouent silencieusement.
async function sendViaBeds24(beds24Key, bookingId, message) {
  if (!message || !beds24Key || !bookingId) {
    console.warn('[Beds24] sendViaBeds24 appelé avec paramètres manquants')
    return { ok: false, reason: 'missing_params' }
  }

  const signature = await getSignatureForKey(beds24Key)
  const finalMessage = message + signature

  if (!SENDVIABEDS24_ENABLED) {
    console.log(`[Beds24] [DRY RUN] Envoi simulé booking ${bookingId} : "${finalMessage.substring(0, 80)}..."`)
    return { ok: true, dryRun: true }
  }

  try {
    const r = await fetch('https://beds24.com/api/v2/bookings/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'token': beds24Key
      },
      body: JSON.stringify([{ bookingId: Number(bookingId), message: finalMessage }])
    })
    const d = await r.json()

    const result = Array.isArray(d) ? d[0] : d
    if (result?.success === false) {
      console.error(`[Beds24] Envoi échoué booking ${bookingId}:`, result.errors || result)
      return { ok: false, error: result.errors || 'unknown' }
    }

    console.log(`[Beds24] Message envoyé booking ${bookingId}`)
    return { ok: true }
  } catch (err) {
    console.error(`[Beds24] Erreur envoi booking ${bookingId}:`, err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = {
  refreshBeds24Tokens,
  doitRenouveler,
  dureeDeVieMs,
  MARGE_MAX_MS,
  VIE_DE_REPLI_MS,
  fetchProperties,
  fetchBookings,
  fetchBookingsHistory,
  fetchBookingsIntegral,
  CREDITS_PLANCHER,
  fetchMessages,
  sendViaBeds24
}
