// api/book-webhook.js
// DOC : docs/kb/moteur-reservation.md §11 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §5.2
//
// LE WEBHOOK STRIPE DES PAIEMENTS DE RESERVATION.
//
// ⚠ ENDPOINT DEDIE, distinct de `api/stripe.js` (facturation SaaS). Les deux ne
// se melangent nulle part : ni compte Stripe, ni cle, ni secret de signature.
// Toucher a l'autre couperait la facturation des abonnements.
//
// ⚠ UNE URL PAR HOTE : /api/book-webhook/<webhook_url_token>
// Un webhook pose sur le compte PROPRE d'un hote ne porte AUCUN identifiant de
// compte dans son corps — contrairement a Connect. La signature ne peut donc
// etre verifiee qu'avec le bon secret, et le bon secret ne se trouve que si
// l'URL dit de quel hote il s'agit. Le jeton n'est pas un secret : c'est un
// routeur. Le secret, lui, est chiffre en base.
//
// CE QU'IL FAIT ET NE FAIT PAS
// Il enregistre l'issue du paiement. Il NE CREE PAS la reservation — c'est
// l'etape 3. Tant qu'elle n'existe pas, un paiement reussi laisse une tentative
// en `paid` : de l'argent encaisse sans reservation. Cet etat ne doit JAMAIS
// etre silencieux, d'ou l'alarme levee plus bas.
//
// POURQUOI LA SIGNATURE SE VERIFIE SUR LE CORPS BRUT
// Cet endpoint est public et non authentifie. Sans verification, n'importe qui
// pourrait poster un faux `checkout.session.completed` et faire creer une
// reservation gratuite. La signature est la SEULE preuve que Stripe parle, et
// elle se calcule sur les octets EXACTS recus : un corps re-serialise par un
// parseur JSON ne correspond plus, d'ou `bodyParser: false`.

const { createClient } = require('@supabase/supabase-js')
const Stripe = require('stripe')
const { ETAT, transitionPermise } = require('../lib/moteur-paiement')
const { secretWebhookParJeton, cleDeLHote, API_VERSION } = require('../lib/stripe-hote')
const { sansSecrets } = require('../lib/chiffrement')
const { nuits, libererIntentions } = require('../lib/reservation-directe')
const { reportIncident } = require('../lib/founder-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

function corpsBrut (req) {
  return new Promise((resolve, reject) => {
    const bouts = []
    req.on('data', c => bouts.push(c))
    req.on('end', () => resolve(Buffer.concat(bouts)))
    req.on('error', reject)
  })
}

async function handler (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'methode_non_autorisee' })

  // Le jeton vient du chemin, reecrit en `?jeton=` par vercel.json.
  const jeton = String(req.query.jeton || '')

  let secret, hote
  try {
    const r = await secretWebhookParJeton(supabase, jeton)
    if (!r.ok) {
      // 404 pour un jeton inconnu : rien a dire de plus a un appelant anonyme.
      // Un secret illisible est en revanche NOTRE probleme, et Stripe doit
      // rejouer une fois qu'il sera repare — d'ou le 500.
      console.error('[book-webhook] jeton refuse :', r.raison)
      return res.status(r.raison === 'secret_illisible' ? 500 : 404).json({ error: r.raison })
    }
    secret = r.secret
    hote = r.ligne
  } catch (e) {
    console.error('[book-webhook] resolution du jeton', sansSecrets(e.message))
    return res.status(500).json({ error: 'indisponible' })
  }

  // `constructEvent` n'appelle PAS l'API Stripe : il ne se sert que du secret.
  // La cle de l'hote est neanmoins necessaire pour construire le client, et
  // l'etape 3 s'en servira pour rembourser.
  let cle
  try {
    const k = await cleDeLHote(supabase, hote.user_id)
    if (!k.ok) throw new Error(k.raison)
    cle = k.cle
  } catch (e) {
    console.error('[book-webhook] cle hote indisponible', sansSecrets(e.message))
    return res.status(500).json({ error: 'indisponible' })
  }

  let evenement
  try {
    const brut = await corpsBrut(req)
    evenement = new Stripe(cle, { apiVersion: API_VERSION })
      .webhooks.constructEvent(brut, req.headers['stripe-signature'], secret)
  } catch (e) {
    // Signature invalide = ce n'est pas Stripe. 400, et rien d'autre : surtout
    // aucun detail sur ce qui a echoue.
    console.error('[book-webhook] signature refusee', sansSecrets(e.message))
    return res.status(400).json({ error: 'signature_invalide' })
  }

  try {
    await traiter(evenement, hote)
  } catch (e) {
    console.error('[book-webhook] traitement', evenement.type, sansSecrets(e.message))
    // 500 : Stripe rejouera. Repondre 200 sur une erreur perdrait l'evenement
    // definitivement — et avec lui la trace d'un encaissement.
    return res.status(500).json({ error: 'traitement_echoue' })
  }

  return res.status(200).json({ recu: true })
}

// Quel etat vise chaque evenement.
// ⚠ `payment_intent.payment_failed` N'EST PAS ICI, et c'est deliberé.
// Constat de review, deux raisons qui se cumulent :
//   1. il n'est PAS RATTACHABLE. `payment_intent_id` ne s'ecrit qu'a la
//      completion de la Session ; sur une carte refusee la Session n'aboutit
//      jamais, la colonne est nulle, et la tentative reste introuvable.
//   2. meme rattachable, il ne faudrait RIEN en faire. Stripe l'emet sur une
//      carte refusee alors que la Checkout Session reste OUVERTE et que le
//      voyageur peut retenter avec une autre carte. Passer la tentative en
//      `failed` et liberer ses nuits pendant qu'il est encore en train de
//      payer, c'est exactement la surreservation qu'on veut empecher.
// L'abandon reel est dit par `checkout.session.expired`, et c'est lui qui rend
// les nuits. L'evenement reste souscrit chez l'hote : il servira au diagnostic.
const CIBLE = {
  'checkout.session.completed': ETAT.PAYE,
  'checkout.session.expired':   ETAT.EXPIRE,
  'charge.refunded':            ETAT.REMBOURSE
}

async function traiter (evenement, hote) {
  const objet = evenement.data && evenement.data.object
  const cible = CIBLE[evenement.type]
  if (!objet || !cible) return

  // Retrouver la tentative : par la Session pour les evenements Checkout, par le
  // PaymentIntent sinon.
  let tentative = null
  if (evenement.type.startsWith('checkout.session.')) {
    tentative = await parColonne('checkout_session_id', objet.id)
  } else {
    const piId = evenement.type === 'charge.refunded' ? objet.payment_intent : objet.id
    if (piId) tentative = await parColonne('payment_intent_id', piId)
  }

  if (!tentative) {
    // Un paiement qui ne correspond a aucune tentative. Si de l'argent a ete
    // pris, c'est une anomalie qui se voit tout de suite — jamais un silence.
    if (cible === ETAT.PAYE) {
      console.error('[book-webhook] paiement ORPHELIN', objet.id)
      await alerter('paiement_orphelin', hote.user_id, null,
        `Paiement reussi sans tentative correspondante (${objet.id}). Argent encaisse, aucune reservation.`)
    }
    return
  }

  // ⚠ CLOISONNEMENT. Le jeton d'URL dit de quel hote vient l'evenement ; la
  // tentative dit a quel hote elle appartient. Les deux DOIVENT coincider.
  // Sans cette garde, un hote qui devinerait un identifiant de Session pourrait
  // faire passer pour payee la tentative d'un autre compte.
  if (String(tentative.user_id) !== String(hote.user_id)) {
    console.error('[book-webhook] tentative d un AUTRE compte', tentative.id, hote.user_id)
    return
  }

  // ⚠ Stripe REJOUE ses webhooks, et pas toujours dans l'ordre. Une transition
  // interdite n'est pas une erreur : c'est un evenement en retard, qu'on ignore.
  // Sans ce garde-fou, un `completed` rejoue apres l'etape 3 ferait reculer une
  // tentative de `booked` a `paid` — et la reservation serait recreee.
  if (!transitionPermise(tentative.status, cible)) {
    console.log(`[book-webhook] transition ignoree ${tentative.status} -> ${cible}`)
    return
  }
  if (tentative.status === cible) return

  const maj = { status: cible, updated_at: new Date().toISOString() }
  if (cible === ETAT.PAYE && objet.payment_intent) maj.payment_intent_id = objet.payment_intent
  if (cible === ETAT.REFUSE) {
    maj.last_error = String((objet.last_payment_error && objet.last_payment_error.message) || '').slice(0, 500)
  }

  // ⚠ Mise a jour CONDITIONNELLE sur le statut lu. Deux livraisons simultanees
  // du meme evenement passeraient sinon toutes les deux la verification de
  // transition avant que l'une n'ecrive.
  const { data: majs, error } = await supabase
    .from('booking_attempts').update(maj)
    .eq('id', tentative.id).eq('status', tentative.status).select('id')
  if (error) throw new Error(`ecriture tentative : ${error.message}`)
  if (!majs || !majs.length) return        // un autre traitement a gagne

  // ─── Rendre les nuits quand plus rien n'est en cours ───────────────────────
  // Sans cela, un abandon bloque les dates jusqu'au bout de la tenue — une
  // demi-heure pendant laquelle personne d'autre ne peut reserver.
  if (cible === ETAT.EXPIRE) {
    const bien = await bienDe(tentative.property_id)
    if (bien && bien.provider_property_id) {
      await libererIntentions(supabase, {
        userId: tentative.user_id,
        propertyId: String(bien.provider_property_id),
        nuits: nuits(tentative.arrival, tentative.departure),
        // ⚠ ON NE LIBERE QUE LES SIENNES. Sans ce jeton, la liberation de cette
        // tentative effacerait les tenues reposees entre-temps par une AUTRE
        // sur les memes nuits — et rendrait vendables des nuits que quelqu'un
        // est en train de payer. Constat de review.
        token: tentative.id
      })
    }
  }

  if (cible === ETAT.PAYE) {
    // L'ETAT DANGEREUX : encaisse, pas encore reserve. A l'etape 3, la creation
    // CRS s'enchainera ICI. En attendant, l'hote est prevenu — de l'argent qui
    // dort sans reservation ne doit jamais rester invisible.
    console.log('[book-webhook] tentative payee', tentative.id)
    const bien = await bienDe(tentative.property_id)
    await alerter('paiement_sans_reservation', tentative.user_id,
      bien && bien.provider_property_id,
      `Paiement encaisse (${(tentative.amount_cents / 100).toFixed(2)} ${tentative.currency}) ` +
      `pour ${tentative.arrival} → ${tentative.departure}. La creation de la reservation est ` +
      `l'etape 3 : elle n'existe pas encore. A traiter a la main.`)
  }
}

async function parColonne (colonne, valeur) {
  const { data, error } = await supabase
    .from('booking_attempts').select('*').eq(colonne, String(valeur)).maybeSingle()
  if (error) throw new Error(`lecture tentative : ${error.message}`)
  return data
}

// ⚠ `automation_incidents.property_id` est cle sur l'identifiant PROVIDER dans
// tout le depot, jamais sur l'UUID. `booking_attempts` porte l'UUID. Y ecrire
// l'UUID rangerait les incidents du moteur dans un espace de cles a part, et
// l'anti-spam ne les grouperait pas avec les autres incidents du meme bien.
async function bienDe (uuid) {
  try {
    const { data } = await supabase
      .from('properties').select('provider_property_id').eq('id', uuid).maybeSingle()
    return data
  } catch (e) { return null }
}

// L'alarme ne doit jamais faire echouer le webhook : Stripe rejouerait
// l'evenement, et l'alerte partirait en boucle.
async function alerter (type, userId, propId, detail) {
  try {
    await reportIncident(type, { userId, propertyId: propId, threshold: 1, detail })
  } catch (e) {
    console.error('[book-webhook] alerte non partie', sansSecrets(e.message))
  }
}

module.exports = handler
// ⚠ APRES l'affectation de `module.exports`, jamais avant : `module.exports = handler`
// remplace l'objet entier et effacerait un `config` pose plus haut. Sans ce
// `config`, Vercel parse le corps, la signature se calcule sur des octets
// re-serialises, et TOUT evenement est rejete comme invalide.
// (Defaut reellement present dans api/stripe.js — voir la dette au KB.)
module.exports.config = { api: { bodyParser: false } }
