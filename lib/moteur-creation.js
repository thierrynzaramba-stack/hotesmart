// lib/moteur-creation.js
// DOC : docs/kb/moteur-reservation.md §12 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §6.1 et §6.2
//
// LA CREATION DE LA RESERVATION APRES ENCAISSEMENT.
// C'est le point 3 de l'ordre grave au §2, et la moitie qui manquait a
// l'etape 2 : sans elle, un paiement reussi laisse de l'argent encaisse sans
// reservation.
//
// ⚠ REGLE HERITEE DE LA PHASE 2, NON NEGOCIABLE :
// LE POST CRS N'EST JAMAIS REJOUE. Channex n'oppose aucune defense a la
// surreservation (mesure du 6 septembre : HTTP 200, stock a -1). Un POST dont
// on ignore l'issue devient un INCIDENT, jamais une seconde tentative.
// La couche canal le sait deja : `METHODES_REJOUABLES` exclut POST.
//
// LES TROIS ISSUES, ET ELLES NE SE CONFONDENT PAS :
//   succes          -> `booked`, nuits rendues, le feed prend le relais
//   refus CERTAIN   -> remboursement automatique, incident, alarme, e-mail
//   issue INCERTAINE-> NI remboursement NI rejeu, alarme qui REVEILLE
//
// La derniere est la plus importante et la moins intuitive. Rembourser un
// sejour peut-etre cree, c'est offrir un sejour ; le rejouer, c'est en creer
// deux. Seul un humain tranche, en regardant chez le provider.

const Stripe = require('stripe')
const { getProvider } = require('./channels')
const { nuits, libererIntentions } = require('./reservation-directe')
const { ETAT } = require('./moteur-paiement')
const { cleDeLHote, API_VERSION } = require('./stripe-hote')
const { sansSecrets } = require('./chiffrement')
const { reportIncident, envoyerAlerteBrute } = require('./founder-notify')
const { envoyerConfirmation, envoyerRemboursement } = require('./email-voyageur')

// Le claim tient le temps d'un POST provider, pas plus. Un orphelin ne doit pas
// bloquer une tentative pour toujours.
const CLAIM_TTL_MS = 3 * 60 * 1000
const PG_UNICITE = '23505'

// ─── Le claim ────────────────────────────────────────────────────────────────
// Stripe rejoue ses webhooks, et deux livraisons simultanees de
// `checkout.session.completed` creeraient DEUX reservations pour un seul
// paiement. On reclame donc la tentative AVANT tout appel provider, par
// l'unicite de `write_locks.key` — celui qui perd ne poste rien.
//
// ⚠ La verification de statut ne suffit PAS a elle seule : deux traitements
// peuvent lire `paid` avant que l'un n'ecrive. C'est l'INSERT qui tranche.
async function reclamer (supabase, tentativeId) {
  const cle = `resa-crs:${tentativeId}`
  const maintenant = Date.now()
  await supabase.from('write_locks').delete().eq('key', cle)
    .lt('expire_at', new Date(maintenant).toISOString())
  const { error } = await supabase.from('write_locks').insert({
    key: cle, token: String(tentativeId),
    expire_at: new Date(maintenant + CLAIM_TTL_MS).toISOString()
  })
  if (error) {
    if (error.code === PG_UNICITE) return { ok: false, raison: 'deja_en_cours' }
    throw new Error(`claim : ${error.message}`)
  }
  return { ok: true, cle }
}

async function relacher (supabase, cle) {
  try { await supabase.from('write_locks').delete().eq('key', cle) }
  catch (e) { console.error('[moteur-creation] claim non relache', cle, e.message) }
}

// ─── Le payload CRS ──────────────────────────────────────────────────────────
// Construit A PARTIR DE LA TENTATIVE, jamais d'un recalcul. Ce qui a ete montre
// au voyageur et encaisse chez Stripe est ce qui part chez le provider : un
// recalcul pourrait diverger d'un centime, et ce centime serait un ecart entre
// ce qu'on a pris et ce qu'on a vendu.
// ⚠ LE CODE DE RESERVATION EST DETERMINISTE, pas aleatoire.
// `otaReservationCode` est REQUIS par `payloadCRS` (CHAMPS_REQUIS) : son absence
// faisait LEVER la construction du payload — donc chaque paiement finissait en
// argent encaisse sans reservation. Bloqueur trouve en review, reproduit par
// execution.
//
// La saisie manuelle (api/reservation-directe.js) en tire un au hasard, ce qui
// lui suffit. Ici il est DERIVE DE LA TENTATIVE, et c'est ce qui compte : le
// meme sejour rend toujours le meme code, donc une reservation creee peut etre
// RETROUVEE chez le provider a partir de nos donnees. C'est la seule chose qui
// permettra un jour de trancher automatiquement une issue incertaine — « ce
// code existe-t-il chez Channex ? » — au lieu d'aller regarder a la main.
function codeReservation (tentativeId) {
  return `HSM-${String(tentativeId).replace(/-/g, '').slice(0, 16).toUpperCase()}`
}

function payloadDepuisTentative (t, bien) {
  const jours = {}
  for (const l of t.price_detail || []) jours[l.date] = Number(l.total)

  return {
    otaReservationCode: codeReservation(t.id),
    roomTypeId: bien.provider_room_type_id,
    ratePlanId: bien.provider_rate_plan_id,
    arrival: t.arrival,
    departure: t.departure,
    days: jours,
    amount: Number(t.amount_cents) / 100,
    currency: t.currency || 'EUR',
    customer: {
      name: t.guest_first_name,
      surname: t.guest_last_name,
      mail: t.guest_email,
      phone: t.guest_phone,
      language: t.lang || 'fr'
    },
    occupancy: { adults: Number(t.guests) || 1, children: 0, infants: 0 },
    // ⚠ LA PROVENANCE VA JUSQU'AU BOUT (§3 ter, ajout 4). `ota_name` porte deja
    // l'origine (« Offline ») ; `meta` porte la SOUS-origine — quel moteur, quel
    // site vendeur. C'est ce qui rendra les statistiques par site possibles.
    meta: {
      source: 'hotesmart-engine',
      link_label: String(t.link_label || '').slice(0, 200),
      attempt_id: String(t.id)
    }
  }
}

// ─── Le remboursement ────────────────────────────────────────────────────────
// Integral, immediat, idempotent. La cle d'idempotence est derivee de la
// tentative : deux appels ne remboursent qu'une fois.
async function rembourser (supabase, t) {
  if (!t.payment_intent_id) return { ok: false, raison: 'sans_payment_intent' }
  const k = await cleDeLHote(supabase, t.user_id)
  if (!k.ok) return { ok: false, raison: k.raison }
  try {
    const stripe = new Stripe(k.cle, { apiVersion: API_VERSION })
    await stripe.refunds.create(
      { payment_intent: t.payment_intent_id, reason: 'requested_by_customer' },
      { idempotencyKey: `bkrf_${t.id}` }
    )
    return { ok: true }
  } catch (e) {
    console.error('[moteur-creation] remboursement echec', t.id, sansSecrets(e.message))
    return { ok: false, raison: sansSecrets(e.message).slice(0, 300) }
  }
}

// ─── CE QUE L'ALARME DOIT PORTER ─────────────────────────────────────────────
// ⚠ EXIGENCE DE THIERRY, apres reception de la premiere vraie alarme :
// « le message doit me permettre de trancher SANS OUVRIR UN ECRAN ».
// Donc, dans l'ordre d'utilite : les dates, le montant, le voyageur, l'heure de
// l'encaissement, et le code a chercher chez le provider.
//
// ⚠ Le SMS est tronque a 300 caracteres par `envoyerAlerteBrute` : ce prefixe
// est compact a dessein, et la CAUSE vient apres — mieux vaut perdre la fin de
// l'explication que les faits qui permettent d'agir.
function faits (t) {
  // ⚠ HEURE DE PARIS, PAS UTC. Constat de review : on decoupait la chaine ISO
  // brute, donc un encaissement le 9 septembre a 00h14 s'affichait « paye 08/09
  // 22:14 » — mauvaise heure ET mauvais jour, sur le seul message dont l'objet
  // est de permettre de trancher sans ouvrir un ecran. Le reste du depot
  // formate en Europe/Paris ; celui-ci le doit d'autant plus.
  const paris = (iso, opts) => {
    try {
      return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', ...opts }).format(new Date(iso))
    } catch (e) { return null }
  }
  const jj = d => paris(`${d}T12:00:00Z`, { day: '2-digit', month: '2-digit' }) || '?'
  const paye = t.paid_at
    ? (paris(t.paid_at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) || 'heure illisible')
    : 'heure inconnue'
  // Repli sur la devise, comme `argent()` : « 240.00 undefined » dans une alarme
  // n'aide personne.
  const montant = `${((Number(t.amount_cents) || 0) / 100).toFixed(2)} ${t.currency || 'EUR'}`
  return `${jj(t.arrival)}-${jj(t.departure)} · ${montant}` +
         ` · ${t.guest_email} · paye ${paye} · ${codeReservation(t.id)}`
}

// ─── L'alarme qui REVEILLE ───────────────────────────────────────────────────
// ⚠ EXIGENCE GRAVEE (Thierry, 7 septembre 2026) : l'issue incertaine doit
// declencher une notification REELLE, pas une ligne en base.
//
// D'ou le chemin DOUBLE. `reportIncident` persiste et historise, mais il SE TAIT
// si une alerte du meme type et du meme bien est deja partie dans l'heure —
// juste pour un incident ordinaire, FAUX ici : deux paiements incertains sur le
// meme bien sont deux voyageurs differents, et le second serait etouffe.
// `envoyerAlerteBrute` garantit l'envoi, sans seuil ni anti-spam.
//
// ⚠ Cette fonction porte un avertissement : ne pas elargir son usage sans la
// meme justification que la surreservation. Elle est ici la meme — de l'argent
// encaisse sans reservation ne se rattrape pas tout seul. Le TROISIEME appelant
// devra, lui aussi, se justifier.
async function alerterReveil (t, bien, cause) {
  const detail = `${faits(t)} — ${cause}`
  const nom = bien ? bien.name : `bien ${t.property_id}`
  const propId = bien ? String(bien.provider_property_id || '') : null
  // ⚠ `threshold` TRES HAUT : on veut la TRACE, pas l'envoi.
  // Avec `threshold: 1`, `reportIncident` envoyait lui aussi SMS + e-mail, et le
  // fondateur recevait DEUX FOIS chaque premiere alarme (constat de review).
  // Un seuil inatteignable fait enregistrer la ligne et se taire ; l'envoi est
  // le role d'`envoyerAlerteBrute`, juste en dessous, qui lui ne rate jamais.
  try {
    await reportIncident('paiement_issue_incertaine', {
      userId: t.user_id, propertyId: propId, propertyName: nom, threshold: 1e9, detail
    })
  } catch (e) { console.error('[moteur-creation] incident non enregistre', e.message) }
  try {
    await envoyerAlerteBrute('paiement_issue_incertaine', {
      propertyName: nom, propertyId: propId, detail, prefixe: 'ARGENT EN SUSPENS — '
    })
  } catch (e) { console.error('[moteur-creation] alarme non partie', e.message) }
}

// ─── La creation ─────────────────────────────────────────────────────────────
async function creerDepuisTentative (supabase, tentativeId) {
  const claim = await reclamer(supabase, tentativeId)
  if (!claim.ok) return { ok: false, raison: claim.raison }

  try {
    const { data: t, error } = await supabase
      .from('booking_attempts').select('*').eq('id', tentativeId).maybeSingle()
    if (error) throw new Error(`lecture tentative : ${error.message}`)
    if (!t) return { ok: false, raison: 'tentative_inconnue' }
    // Sous claim, on relit : un autre traitement a pu aboutir entre-temps.
    if (t.status !== ETAT.PAYE) return { ok: false, raison: 'statut_inattendu', statut: t.status }

    const { data: bien, error: eBien } = await supabase
      .from('properties')
      .select('id, name, address, checkin_time, checkout_time, user_id, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id')
      .eq('id', t.property_id).maybeSingle()
    if (eBien) throw new Error(`lecture properties : ${eBien.message}`)

    // ⚠ Un bien mal configure est un refus CERTAIN : rien n'a ete poste, on peut
    // rembourser sans risque. Ne pas le confondre avec une issue incertaine.
    if (!bien || bien.provider !== 'channex' || !bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      return await echecCertain(supabase, t, bien, 'bien_non_configure',
        `Bien non configure pour l'ecriture CRS (provider=${bien ? bien.provider : '?'}).`)
    }

    // Le label du lien, pour la provenance.
    const { data: lien } = await supabase
      .from('booking_links').select('label').eq('id', t.link_id).maybeSingle()

    const canal = getProvider(bien.provider)
    const resa = payloadDepuisTentative({ ...t, link_label: lien ? lien.label : '' }, bien)

    // ⚠ LE DETAIL DE PRIX EST UNE PRECONDITION, pas une surprise du provider.
    // Constate en validation reelle : un `price_detail` vide donnait `days = {}`,
    // `payloadCRS` refusait LOCALEMENT, et l'exception tombait dans le
    // fourre-tout « issue incertaine » — argent encaisse, aucun remboursement,
    // et une alarme qui reveille pour rien. Or rien n'avait ete envoye : c'est
    // l'echec le plus CERTAIN qui soit.
    const nuitsAttendues = nuits(t.arrival, t.departure)
    const jours = Object.keys(resa.days || {})
    if (jours.length !== nuitsAttendues.length || nuitsAttendues.some(n => resa.days[n] == null)) {
      return await echecCertain(supabase, t, bien, 'detail_prix_invalide',
        `Le detail de prix ne couvre pas le sejour (${jours.length} jour(s) pour ` +
        `${nuitsAttendues.length} nuit(s)). Rien n'a ete envoye au provider.`)
    }

    // ⚠ UNE EXCEPTION ICI EST UN ECHEC CERTAIN, et c'est demontrable :
    // `channelCall` ATTRAPE les pannes reseau et rend `{ ok: false, status: 0 }`
    // au lieu de lever. La seule facon dont `createBooking` puisse LEVER est le
    // refus de `payloadCRS`, qui valide AVANT le `fetch`. Une exception signifie
    // donc que rien n'est parti — on peut rembourser sans risque.
    let envoi
    try {
      envoi = await canal.createBooking(bien.provider_property_id, resa)
    } catch (e) {
      return await echecCertain(supabase, t, bien, 'payload_refuse',
        `Le payload a ete refuse avant tout envoi : ${e.message}. Rien n'a ete transmis au provider.`)
    }

    // 403 = l'app booking_crs n'est pas installee. Rejeu SUR : un 403 signifie
    // que rien n'a ete cree. C'est le seul rejeu autorise sur ce POST, et il est
    // herite de la phase 2.
    if (!envoi.ok && envoi.status === 403) {
      console.warn('[moteur-creation] app booking_crs absente sur', bien.provider_property_id)
      const inst = await canal.installerCRS(bien.provider_property_id)
      // ⚠ PAS DE SECOND `try/catch` ICI, et c'est deliberé (constat de review) :
      // `payloadCRS` est deterministe et recoit le MEME objet `resa`. S'il n'a
      // pas leve au premier appel, il ne peut pas lever ici. Un garde qui ne
      // peut rien attraper donne une confiance qu'il ne porte pas.
      if (inst.ok) envoi = await canal.createBooking(bien.provider_property_id, resa)
    }

    if (envoi.ok) {
      // ⚠ `.select()` OBLIGATOIRE. Sans lui, un update qui ne touche AUCUNE ligne
      // rend `{ error: null }` et passe pour un succes. Constat de review :
      // l'hote qui rembourse a la main pendant que le POST est en vol fait
      // passer la tentative a `refunded` ; notre update ne touchait alors rien,
      // on rendait `ok: true`, on liberait les nuits et on envoyait au voyageur
      // une confirmation pour une reservation remboursee — alors que la
      // reservation existe bel et bien chez le provider.
      const { data: majs, error: eMaj } = await supabase.from('booking_attempts')
        .update({
          status: ETAT.RESERVE, provider_booking_id: String(envoi.id || ''),
          last_error: null, updated_at: new Date().toISOString()
        })
        .eq('id', t.id).eq('status', ETAT.PAYE).select('id')
      if (eMaj || !majs || !majs.length) {
        // La reservation EXISTE chez le provider et nous n'avons pas su l'ecrire.
        // C'est une issue incertaine du point de vue de nos donnees : surtout
        // pas de remboursement, surtout pas de rejeu.
        await alerterReveil(t, bien,
          `Reservation CREEE chez le provider (${envoi.id}, code ${codeReservation(t.id)}) mais statut non ` +
          `enregistre : ${eMaj ? eMaj.message : 'la tentative a change d etat entre-temps'}. NE PAS REJOUER.`)
        return { ok: false, raison: 'statut_non_enregistre', bookingId: envoi.id }
      }

      // Les nuits sont desormais portees par la reservation elle-meme : le feed
      // va la remonter dans le cœur. On rend la tenue.
      await libererIntentions(supabase, {
        userId: t.user_id, propertyId: String(bien.provider_property_id),
        nuits: nuits(t.arrival, t.departure), token: t.id
      })
      await prevenirVoyageur(supabase, t, bien, 'confirmation', String(envoi.id || ''))
      return { ok: true, bookingId: envoi.id }
    }

    // ⚠ LA FRONTIERE. `status: 0` est ce que rend la couche canal quand l'appel
    // n'a pas abouti — panne reseau, coupure pendant la lecture du corps. On ne
    // sait PAS si Channex a cree la reservation.
    if (!envoi.status || envoi.status === 0) {
      await alerterReveil(t, bien,
        'POST CRS d\'issue INCERTAINE. NE PAS REJOUER : chercher le code chez le provider avant tout geste.')
      await supabase.from('booking_attempts')
        .update({ last_error: 'issue_incertaine', updated_at: new Date().toISOString() })
        .eq('id', t.id)
      return { ok: false, raison: 'issue_incertaine' }
    }

    // Refus explicite du provider : rien n'a ete cree, on rembourse.
    return await echecCertain(supabase, t, bien, 'echec_crs',
      `Provider a refuse la creation (HTTP ${envoi.status}) : ${JSON.stringify(envoi.erreurs || {}).slice(0, 300)}`)
  } finally {
    await relacher(supabase, claim.cle)
  }
}

// ─── Ce qui part au voyageur ─────────────────────────────────────────────────
// ⚠ `telephone_hote` vit dans `knowledge`, PAS sur `properties` : cette derniere
// n'a aucune colonne `phone` (verifie — `lib/cron-messages.js` la lit pourtant,
// et rend donc toujours une chaine vide ; dette notee au KB).
// La cle de `knowledge.property_id` est l'identifiant PROVIDER, comme partout.
async function contactHote (supabase, userId, providerPropId) {
  try {
    const { data } = await supabase.from('knowledge')
      .select('value').eq('user_id', userId)
      .eq('property_id', String(providerPropId)).eq('key', 'telephone_hote').maybeSingle()
    return data ? data.value : null
  } catch (e) { return null }
}

function argent (cents, devise) {
  return `${(Number(cents) / 100).toFixed(2)} ${devise || 'EUR'}`
}

// ⚠ L'E-MAIL NE BLOQUE JAMAIS. La reservation existe chez le provider ; un envoi
// rate est un service non rendu, pas une reservation a defaire. On journalise.
async function prevenirVoyageur (supabase, t, bien, sorte, reference) {
  const tel = bien ? await contactHote(supabase, t.user_id, bien.provider_property_id) : null
  const commun = {
    email: t.guest_email, prenom: t.guest_first_name, lang: t.lang,
    bien: bien ? bien.name : '', adresse: bien ? bien.address : null,
    arrivee: t.arrival, depart: t.departure,
    nuits: nuits(t.arrival, t.departure).length,
    voyageurs: t.guests, total: argent(t.amount_cents, t.currency),
    politique: t.cancellation_policy || 'non_remboursable',
    heure_arrivee: bien ? bien.checkin_time : null,
    heure_depart: bien ? bien.checkout_time : null,
    telephone_hote: tel, reference
  }
  const r = sorte === 'remboursement'
    ? await envoyerRemboursement(commun)
    : await envoyerConfirmation(commun)
  if (!r.ok) console.error('[moteur-creation] e-mail voyageur non parti', t.id, sorte, r.raison)
  return r
}

// ─── L'echec CERTAIN : on rembourse ──────────────────────────────────────────
async function echecCertain (supabase, t, bien, raison, detail) {
  const remb = await rembourser(supabase, t)
  const nom = bien ? bien.name : `bien ${t.property_id}`
  const propId = bien ? String(bien.provider_property_id || '') : null

  await supabase.from('booking_attempts').update({
    status: remb.ok ? ETAT.REMBOURSE : ETAT.PAYE,
    last_error: `${raison} — ${detail}`.slice(0, 500),
    updated_at: new Date().toISOString()
  }).eq('id', t.id)

  // La tenue n'a plus lieu d'etre : aucune reservation n'existe.
  if (bien && bien.provider_property_id) {
    await libererIntentions(supabase, {
      userId: t.user_id, propertyId: String(bien.provider_property_id),
      nuits: nuits(t.arrival, t.departure), token: t.id
    })
  }

  if (remb.ok) {
    // Rembourse : l'hote doit le savoir, mais rien n'est en suspens.
    try {
      // ⚠ LES FAITS D'ABORD, ICI AUSSI. Constat de Thierry a la reception :
      // cet e-mail disait la cause et le montant, mais ni les dates, ni le
      // voyageur, ni l'heure, ni le code — il fallait ouvrir un ecran pour
      // savoir de quelle reservation on parlait. L'exigence vaut pour TOUTE
      // notification d'argent, pas seulement pour celles qui reveillent.
      await reportIncident('reservation_remboursee', {
        userId: t.user_id, propertyId: propId, propertyName: nom, threshold: 1,
        detail: `${faits(t)} — REMBOURSE. ${detail}`
      })
    } catch (e) { console.error('[moteur-creation] incident non enregistre', e.message) }
    await prevenirVoyageur(supabase, t, bien, 'remboursement', null)
    return { ok: false, raison, rembourse: true }
  }

  // ⚠ ECHEC DE CREATION **ET** ECHEC DE REMBOURSEMENT : de l'argent est
  // encaisse, aucune reservation n'existe, et nous n'avons pas su le rendre.
  // C'est le pire etat du produit — il REVEILLE.
  await alerterReveil(t, bien,
    `${detail} REMBOURSEMENT ECHOUE (${remb.raison}). Encaisse sans reservation. A TRAITER A LA MAIN.`)
  return { ok: false, raison, rembourse: false }
}

// ─── LE RATTRAPAGE DES TENTATIVES BLOQUEES ───────────────────────────────────
// ⚠ CONSTAT DE REVIEW, ET C'EST UN TROU STRUCTUREL.
// La creation s'enchaine dans le webhook, apres le passage a `paid`. Si la
// fonction Vercel expire ou meurt PENDANT le POST CRS, Stripe rejoue
// `checkout.session.completed` — mais le webhook sort immediatement, la
// tentative etant deja `paid`. Argent encaisse, aucune reservation, AUCUNE
// alarme, et rien ne relisait la file.
//
// ⚠ CE RATTRAPAGE N'ESSAIE PAS DE CREER. On ne sait pas si le POST est parti :
// le rejouer, c'est risquer deux reservations pour un paiement — precisement ce
// que la regle heritee de la phase 2 interdit. Il ALERTE, une fois par
// tentative, et un humain tranche en cherchant `HSM-<...>` chez le provider.
//
// C'est pour cela que le code de reservation est DETERMINISTE : il rend la
// verification possible. Un rapprochement automatique — « ce code existe-t-il
// chez Channex ? » — devient constructible le jour ou on en aura besoin.
const BLOQUEE_APRES_MS = 10 * 60 * 1000
const MARQUE_SIGNALEE = 'bloquee_signalee'

async function rattraperBloquees (supabase, { maintenant, limite = 20 } = {}) {
  const seuil = new Date((maintenant || Date.now()) - BLOQUEE_APRES_MS).toISOString()
  const { data, error } = await supabase
    .from('booking_attempts').select('*')
    .eq('status', ETAT.PAYE).lt('updated_at', seuil).limit(limite)
  if (error) throw new Error(`lecture des tentatives bloquees : ${error.message}`)

  // Deja signalee : on ne re-alerte pas a chaque cycle. Une alarme qui crie en
  // boucle finit ignoree, et celle-ci doit rester lisible.
  const aSignaler = (data || []).filter(t => !String(t.last_error || '').startsWith(MARQUE_SIGNALEE))
  for (const t of aSignaler) {
    const { data: bien } = await supabase.from('properties')
      .select('name, provider_property_id').eq('id', t.property_id).maybeSingle()
    await alerterReveil(t, bien,
      'BLOQUEE en « paye » depuis plus de 10 min. Si le code existe chez le provider, ' +
      'la reservation est creee ; sinon elle ne l\'est pas. NE PAS REJOUER a l\'aveugle.')
    await supabase.from('booking_attempts')
      .update({ last_error: `${MARQUE_SIGNALEE}:${new Date().toISOString()}`, updated_at: new Date().toISOString() })
      .eq('id', t.id).eq('status', ETAT.PAYE)
  }
  if (aSignaler.length) console.error(`[moteur-creation] ${aSignaler.length} tentative(s) bloquee(s) signalee(s)`)
  return { signalees: aSignaler.length, vues: (data || []).length }
}

module.exports = {
  BLOQUEE_APRES_MS, MARQUE_SIGNALEE, rattraperBloquees,
  CLAIM_TTL_MS, reclamer, relacher, codeReservation, alerterReveil,
  payloadDepuisTentative, rembourser, creerDepuisTentative, faits
}
