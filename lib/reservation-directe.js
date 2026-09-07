// lib/reservation-directe.js
// DOC : docs/kb/reservation-directe.md (modif = MEME COMMIT)
//
// Verrou anti-surreservation et ecriture d'une reservation directe.
// Spec : docs/specs/spec-reservation-manuelle.md §4 (amendement du 6 sept 2026).
//
// POURQUOI CE MODULE EXISTE
// Channex n'oppose AUCUNE defense a la surreservation — mesure du protocole CRS
// du 6 septembre : une reservation creee sur des dates dont la disponibilite vaut
// 0 est acceptee en HTTP 200, et le stock passe simplement a -1. La protection
// vit donc integralement ici. Ce n'est pas un durcissement optionnel : c'est le
// seul rempart avant que deux voyageurs ne se retrouvent le meme soir dans le
// meme logement.
//
// Le verrou est la DEFENSE ; la detection au cycle (lib/cron-overbooking.js) est
// le filet derriere, pour les surreservations qui arrivent par d'autres chemins
// (deux OTA qui vendent la meme nuit avant que la fermeture ne se propage).

// ⚠ `./channels` est requis PARESSEUSEMENT, au point d'appel (ligne ~279).
// Le charger ici chargerait toute la chaine provider — dont des modules qui
// instancient un client Supabase des leur import. Or ce fichier expose aussi des
// helpers de dates et d'occupation purs (`nuits`, `occupationParNuit`), que le
// moteur de reservation direct et ses tests consomment sans jamais toucher a un
// provider. L'import eager leur imposait un environnement complet pour calculer
// une soustraction de dates.
const { readStatus, STATUS } = require('./bookings-snapshot-status')

// ─── Les nuits d'un sejour ───────────────────────────────────────────────────
// Une reservation du 12 au 15 occupe les nuits du 12, 13 et 14 — PAS celle du 15.
// C'est ce qui permet a l'arrivee suivante de commencer le 15 sans conflit, et
// c'est exactement ce que fait Channex (mesure : sejour 12->15, seules les nuits
// 12, 13 et 14 passent a 0).
function nuits (arrivee, depart) {
  const out = []
  if (!arrivee || !depart) return out
  const d = new Date(`${arrivee}T00:00:00Z`)
  const fin = new Date(`${depart}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || Number.isNaN(fin.getTime())) return out
  while (d < fin) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

// ─── Occupation nuit par nuit ────────────────────────────────────────────────
// Compte, pour chaque nuit, combien de reservations `confirmed` l'occupent.
// TOUTES ORIGINES : OTA, saisie manuelle, futur moteur direct. Le cœur est la
// seule source — c'est tout l'objet de l'architecture « provider -> cœur -> apps ».
//
// `exclure` : id d'une reservation a ignorer, pour qu'une MODIFICATION ne se
// compte pas elle-meme comme un conflit avec son propre etat actuel.
//
// `statuts` : quels statuts canoniques occupent une nuit. Le defaut reste
// [CONFIRMED] — le comportement du verrou de la phase 2 est INCHANGE.
// Le moteur de reservation direct, lui, passe [CONFIRMED, BLOCKED] : un blocage
// proprietaire occupe le logement (c'est la definition meme de `blocked` dans
// lib/bookings-snapshot-status.js) sans generer de menage. L'hote peut vouloir
// passer outre son propre blocage en saisie manuelle ; un VOYAGEUR ne le peut
// jamais. Voir docs/kb/moteur-reservation.md.
function occupationParNuit (snapshots, { exclure, statuts } = {}) {
  const retenus = statuts && statuts.length ? statuts : [STATUS.CONFIRMED]
  const par = {}
  for (const ligne of snapshots || []) {
    if (exclure && String(ligne.booking_id) === String(exclure)) continue
    const snap = ligne.snapshot || {}
    if (!retenus.includes(readStatus(snap, snap.provider))) continue
    for (const n of nuits(snap.arrival, snap.departure)) par[n] = (par[n] || 0) + 1
  }
  return par
}

// ─── La regle ────────────────────────────────────────────────────────────────
// Une nuit est PLEINE quand le nombre de reservations qui l'occupent atteint le
// nombre d'unites louables du bien. On refuse « quand il ne reste plus d'unite »,
// pas « quand il existe deja une reservation » : a 1 unite les deux formulations
// coincident, au-dela seule la premiere est juste.
//
// ⚠ `inventory_units`, JAMAIS `capacity` : cette derniere compte les PERSONNES
// accueillies (Colomiers = 4), pas les logements louables.
function nuitsIndisponibles (occupation, nuitsVoulues, unites) {
  const u = Math.max(1, Number(unites) || 1)
  return nuitsVoulues.filter(n => (occupation[n] || 0) >= u)
}

// ─── Reservations en attente du feed ─────────────────────────────────────────
// ⚠ LE CŒUR NE SAIT PAS ENCORE. Entre l'acceptation par Channex et l'apparition
// de la reservation dans `bookings_snapshot` (retour par le feed, au cycle
// suivant), la nuit parait LIBRE alors qu'elle est vendue.
// Scenario reel : l'hote saisit A (12->15), lit « envoyee », puis saisit B
// (13->14) trente secondes plus tard. La verification de B ne voit pas A, Channex
// n'oppose aucune defense, et la surreservation est creee PAR NOTRE PROPRE
// CHEMIN — celui qui se presente comme le seul rempart.
//
// On pose donc une intention par nuit vendue, dans la meme table que le verrou.
// TTL court mais superieur au cycle : le temps que le feed remonte. Si le feed
// tarde, l'intention expire et la nuit redevient libre — c'est le bon compromis :
// bloquer indefiniment sur un marqueur orphelin serait pire.
const INTENTION_TTL_MS = 20 * 60 * 1000

const cleIntention = (userId, propertyId, nuit) => `resa-nuit:${userId}:${propertyId}:${nuit}`

async function poserIntentions (supabase, { userId, propertyId, nuits: liste }) {
  const maintenant = Date.now()
  const expire = new Date(maintenant + INTENTION_TTL_MS).toISOString()

  // ⚠ PURGE DES INTENTIONS EXPIREES, a chaque pose.
  // Sans elle, rien ne les supprimait jamais : `poserVerrou` ne nettoie que SA
  // propre cle, et l'upsert ci-dessous ne touche que les nuits demandees. Les
  // marqueurs d'un sejour passe restaient donc en base indefiniment — sans
  // consequence fonctionnelle (la lecture filtre sur `expire_at`), mais la table
  // n'aurait fait que grossir. Constate en production apres le premier test reel.
  const { error: ePurge } = await supabase.from('write_locks')
    .delete()
    .like('key', 'resa-nuit:%')
    .lt('expire_at', new Date(maintenant).toISOString())
  if (ePurge) console.error('[resa-directe] purge des intentions echouee', ePurge.message)

  const lignes = liste.map(n => ({ key: cleIntention(userId, propertyId, n), expire_at: expire }))
  // `upsert` : une intention deja posee (retry) ne doit pas faire echouer l'appel.
  const { error } = await supabase.from('write_locks').upsert(lignes, { onConflict: 'key' })
  if (error) console.error('[resa-directe] intentions non posees', error.message)
}

// Nuits deja vendues par nous et pas encore visibles dans le cœur.
async function intentionsEnCours (supabase, { userId, propertyId, nuits: liste }) {
  const cles = liste.map(n => cleIntention(userId, propertyId, n))
  const { data, error } = await supabase
    .from('write_locks').select('key')
    .in('key', cles)
    .gt('expire_at', new Date().toISOString())
  // Erreur de lecture : on ne peut pas conclure « aucune intention » sans risquer
  // la surreservation qu'on cherche a empecher. On remonte.
  if (error) throw new Error(`lecture write_locks : ${error.message}`)
  const par = {}
  for (const l of data || []) {
    const nuit = String(l.key).split(':').pop()
    par[nuit] = (par[nuit] || 0) + 1
  }
  return par
}

// Les nuits sous intention sur une FENETRE, sans avoir a enumerer ses cles.
// Le calendrier public balaie 365 jours : un `.in()` de 365 cles de ~60 caracteres
// depasserait la longueur d'URL admise par PostgREST en GET, et la requete
// echouerait — c'est-a-dire, sur ce chemin, un calendrier qui montre libres des
// nuits que nous venons nous-memes de vendre.
//
// Le prefixe de cle porte deja `userId` et `propertyId` : le filtre est donc
// aussi cloisonne que celui de `intentionsEnCours`. La connaissance du FORMAT de
// cle reste ici, avec `cleIntention`, et nulle part ailleurs.
async function intentionsSurFenetre (supabase, { userId, propertyId, debut, fin }) {
  const prefixe = `resa-nuit:${userId}:${propertyId}:`
  const { data, error } = await supabase
    .from('write_locks').select('key')
    .like('key', `${prefixe}%`)
    .gte('key', `${prefixe}${debut}`)
    .lte('key', `${prefixe}${fin}`)
    .gt('expire_at', new Date().toISOString())
  // Meme regle que partout sur ce chemin : une erreur de lecture ne peut pas
  // passer pour « aucune intention » sans rouvrir la surreservation.
  if (error) throw new Error(`lecture write_locks : ${error.message}`)
  const par = {}
  for (const l of data || []) {
    const nuit = String(l.key).slice(prefixe.length)
    if (nuit) par[nuit] = (par[nuit] || 0) + 1
  }
  return par
}

// ─── Verification ────────────────────────────────────────────────────────────
// Lecture du cœur uniquement. Rend { ok, nuits, conflits, unites }.
async function verifierDisponibilite (supabase, { userId, propertyId, arrival, departure, exclure }) {
  const voulues = nuits(arrival, departure)
  if (!voulues.length) return { ok: false, raison: 'dates_invalides', nuits: [], conflits: [] }

  const { data: bien, error: eBien } = await supabase
    .from('properties')
    .select('inventory_units, name, provider')
    .eq('user_id', userId)
    .eq('provider_property_id', String(propertyId))
    .maybeSingle()
  if (eBien) throw new Error(`lecture properties : ${eBien.message}`)
  if (!bien) return { ok: false, raison: 'bien_inconnu', nuits: voulues, conflits: [] }

  // ⚠ Le filtre user_id est OBLIGATOIRE : `provider_property_id` n'a aucune
  // unicite globale (deux hotes peuvent porter le meme identifiant provider).
  const { data: snaps, error } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, snapshot')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .gte('snapshot->>departure', voulues[0])
    .lte('snapshot->>arrival', voulues[voulues.length - 1])
  // ⚠ Une erreur de lecture ne doit JAMAIS passer pour « aucun conflit » : on
  // remonte. Un verrou qui s'ouvre parce que la base n'a pas repondu ne protege
  // rien — c'est le pire des deux mondes.
  if (error) throw new Error(`lecture bookings_snapshot : ${error.message}`)

  const occupation = occupationParNuit(snaps, { exclure })
  // Les reservations que NOUS venons de creer et que le feed n'a pas encore
  // rendues comptent comme occupantes : sans elles, deux saisies rapprochees
  // passeraient toutes deux la verification.
  const attente = await intentionsEnCours(supabase, { userId, propertyId, nuits: voulues })
  for (const [nuit, n] of Object.entries(attente)) occupation[nuit] = (occupation[nuit] || 0) + n
  const conflits = nuitsIndisponibles(occupation, voulues, bien.inventory_units)
  return {
    ok: conflits.length === 0,
    raison: conflits.length ? 'nuits_completes' : null,
    nuits: voulues,
    conflits,
    unites: Math.max(1, Number(bien.inventory_units) || 1),
    provider: bien.provider,
    occupation
  }
}

// ─── Verrou d'ecriture par bien ──────────────────────────────────────────────
// Entre la verification et la creation, rien ne doit s'intercaler : deux saisies
// simultanees qui verifient toutes deux « il reste une unite » creeraient deux
// reservations. Le verrou est pose sur (user_id, property_id) via un INSERT dont
// l'unicite fait office d'exclusion mutuelle — aucune extension requise.
//
// ⚠ LA TABLE EST `write_locks`, SURTOUT PAS `locks` : cette derniere porte les
// SERRURES CONNECTEES (label, brand, seam_device_id — cf. lib/cron-access.js).
// Y ecrire melangerait des verrous applicatifs a du materiel Seam.
//
// `expire_at` : un verrou orphelin (processus tue entre la pose et la liberation)
// ne doit pas bloquer le bien pour toujours. Court, car la sequence tient en
// quelques secondes.
const VERROU_TTL_MS = 60 * 1000

// Violation de contrainte d'unicite : le verrou est REELLEMENT tenu par quelqu'un.
// Tout autre code d'erreur (table absente, droit manquant, panne) est un incident
// technique — le confondre avec « occupe » afficherait « une autre saisie est en
// cours » indefiniment, alors que la table n'existe simplement pas encore.
const PG_UNICITE = '23505'

async function poserVerrou (supabase, { userId, propertyId }) {
  const cle = `resa-directe:${userId}:${propertyId}`
  const maintenant = Date.now()
  // Jeton de propriete : sans lui, un processus dont la sequence a depasse le TTL
  // supprimerait au `finally` le verrou pris entre-temps par un AUTRE — et
  // l'exclusion mutuelle tomberait precisement dans le cas lent pour lequel elle
  // existe (un POST Channex lent, un 403 suivi d'une installation et d'un rejeu).
  const jeton = `${maintenant}-${Math.random().toString(36).slice(2, 10)}`

  // Nettoyage prealable des verrous expires : sans cela, un orphelin bloquerait
  // le bien jusqu'a intervention humaine.
  await supabase.from('write_locks').delete().eq('key', cle).lt('expire_at', new Date(maintenant).toISOString())
  const { error } = await supabase.from('write_locks').insert({
    key: cle,
    token: jeton,
    expire_at: new Date(maintenant + VERROU_TTL_MS).toISOString()
  })
  if (error) {
    if (error.code === PG_UNICITE) return { ok: false, cle, raison: 'occupe' }
    console.error('[resa-directe] verrou non pose', cle, error.code || '', error.message)
    return { ok: false, cle, raison: 'verrou_indisponible', erreur: error.message }
  }
  return { ok: true, cle, jeton }
}

// ⚠ ON NE SUPPRIME QUE SON PROPRE VERROU (`.eq('token', …)`).
async function libererVerrou (supabase, cle, jeton) {
  try {
    let q = supabase.from('write_locks').delete().eq('key', cle)
    if (jeton) q = q.eq('token', jeton)
    await q
  } catch (e) { console.error('[resa-directe] liberation verrou echec', cle, e.message) }
}

// ─── Creation d'une reservation directe ──────────────────────────────────────
// Sequence : verrou -> verification -> ecriture CRS -> liberation.
//
// ⚠ LE CŒUR N'EST PAS ECRIT ICI. La reservation y entrera par le feed/webhook
// standard, comme n'importe quelle reservation OTA — c'est la regle
// « provider -> cœur -> apps », et c'est aussi ce qui garantit que menage,
// messages et codes fonctionnent sans code specifique.
//
// ⚠ ECHEC CRS = VERROU LIBERE, RIEN D'ECRIT NULLE PART.
async function creerReservationDirecte (supabase, { userId, propertyId, resa }) {
  const verrou = await poserVerrou(supabase, { userId, propertyId })
  if (!verrou.ok) {
    return verrou.raison === 'occupe'
      ? { ok: false, raison: 'verrou_occupe', message: 'Une autre saisie est en cours sur ce bien.' }
      : { ok: false, raison: 'verrou_indisponible', erreur: verrou.erreur,
          message: "Le verrou de securite est indisponible. Rien n'a ete enregistre." }
  }

  try {
    const dispo = await verifierDisponibilite(supabase, {
      userId, propertyId, arrival: resa.arrival, departure: resa.departure
    })
    if (!dispo.ok) {
      return {
        ok: false, raison: dispo.raison, conflits: dispo.conflits, unites: dispo.unites,
        message: dispo.raison === 'nuits_completes'
          ? `Plus d'unite disponible sur : ${dispo.conflits.join(', ')}.`
          : 'Dates ou bien invalides.'
      }
    }

    // ⚠ ROUTAGE PAR LE PROVIDER DU BIEN, jamais « channex » en dur (regle du
    // CLAUDE.md : tout code canal via lib/channels/). Cable en dur, ce module
    // aurait poste chez Channex une reservation portant un propId Beds24.
    // L'ecriture CRS n'existe que cote Channex : un bien Beds24 est refuse ici,
    // explicitement, plutot que d'echouer plus loin de facon obscure.
    if (dispo.provider !== 'channex') {
      return { ok: false, raison: 'provider_sans_ecriture',
               message: `La saisie directe n'est pas disponible sur ce bien (${dispo.provider}).` }
    }
    const { getProvider } = require('./channels')
    const canal = getProvider(dispo.provider)
    let envoi = await canal.createBooking(propertyId, resa)

    // 403 = l'app booking_crs n'est pas installee sur ce bien. Le parc anterieur
    // au 6 septembre 2026 est dans ce cas (Colomiers compris) : on installe et on
    // rejoue UNE fois. Le POST n'etant pas rejouable en cas de panne reseau, ce
    // rejeu-ci est sur : un 403 signifie que rien n'a ete cree.
    if (!envoi.ok && envoi.status === 403) {
      console.warn('[resa-directe] app booking_crs absente sur', propertyId, '— installation a la volee')
      const inst = await canal.installerCRS(propertyId)
      if (inst.ok) envoi = await canal.createBooking(propertyId, resa)
    }

    if (!envoi.ok) {
      return { ok: false, raison: 'echec_crs', status: envoi.status, erreurs: envoi.erreurs,
               message: "La reservation n'a pas pu etre transmise. Rien n'a ete enregistre." }
    }
    // Vendu chez Channex : on marque les nuits AVANT de rendre la main, pour que
    // la saisie suivante les voie occupees meme si le feed n'a pas encore remonte.
    await poserIntentions(supabase, { userId, propertyId, nuits: dispo.nuits })
    return { ok: true, bookingId: envoi.id, nuits: dispo.nuits }
  } finally {
    await libererVerrou(supabase, verrou.cle, verrou.jeton)
  }
}

module.exports = {
  nuits,
  poserIntentions,
  intentionsEnCours,
  intentionsSurFenetre,
  INTENTION_TTL_MS,
  occupationParNuit,
  nuitsIndisponibles,
  verifierDisponibilite,
  poserVerrou,
  libererVerrou,
  creerReservationDirecte,
  VERROU_TTL_MS
}
