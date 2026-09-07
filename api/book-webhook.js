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
const { creerDepuisTentative, alerterReveil } = require('../lib/moteur-creation')

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
  let cible = CIBLE[evenement.type]
  if (!objet || !cible) return

  // ⚠ UN REMBOURSEMENT PARTIEL N'EST PAS UN REMBOURSEMENT. Constat de review :
  // Stripe emet `charge.refunded` pour TOUT remboursement, y compris un geste
  // commercial de 20 EUR sur un sejour de 240. Le prendre pour un remboursement
  // integral faisait basculer la tentative dans l'etat TERMINAL `refunded` —
  // toute revente au meme voyageur devenait impossible (`deja_rembourse`), et
  // depuis peu ses nuits etaient liberees par-dessus le marche.
  if (evenement.type === 'charge.refunded') {
    const total = Number(objet.amount) || 0
    const rendu = Number(objet.amount_refunded) || 0
    if (objet.refunded !== true && rendu < total) {
      console.log(`[book-webhook] remboursement PARTIEL ignore (${rendu}/${total})`)
      return
    }
  }

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
  if (cible === ETAT.PAYE) {
    if (objet.payment_intent) maj.payment_intent_id = objet.payment_intent
    // ⚠ L'HEURE DE L'ENCAISSEMENT, ecrite ICI et nulle part ailleurs.
    // `updated_at` ne peut pas en tenir lieu : le rattrapage l'ecrit a chaque
    // signalement, et l'alarme afficherait l'heure de l'alarme au lieu de celle
    // du paiement. Sur un message qui parle d'argent, une date fausse est pire
    // qu'une date absente.
    maj.paid_at = new Date().toISOString()
  }
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
  // ⚠ UN REMBOURSEMENT LIBERE AUSSI LES NUITS — MAIS JAMAIS PENDANT UNE CREATION.
  // Constate a la validation reelle : la tentative passait bien en `refunded`,
  // mais ses nuits restaient tenues jusqu'a l'expiration, bloquees alors que plus
  // rien n'engageait personne.
  //
  // ⚠ ET LE CORRECTIF A OUVERT UNE FENETRE DE SURRESERVATION (constat de review).
  // La transition `paid -> refunded` est permise : si l'hote rembourse PENDANT
  // que le POST CRS est en vol, cette branche supprimait les tenues, le feed
  // n'avait pas encore la reservation, le calendrier public revoyait les nuits
  // libres — et un second voyageur pouvait les acheter avant que le POST du
  // premier n'aboutisse. Channex ne s'y oppose pas (stock a -1).
  //
  // Le claim `resa-crs:<id>` dit exactement « une creation est en cours ». Tant
  // qu'il existe, on ne touche pas aux tenues : le chemin de creation les rendra
  // lui-meme, ou elles expireront.
  const creationEnVol = cible === ETAT.REMBOURSE && await claimActif(tentative.id)
  if ((cible === ETAT.EXPIRE || cible === ETAT.REMBOURSE) && !creationEnVol) {
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
    // ─── LE POINT 3 DE L'ORDRE GRAVE (§2) ───────────────────────────────────
    // `paid` est l'etat DANGEREUX : de l'argent est encaisse et aucune
    // reservation n'existe. Il doit durer le moins longtemps possible, d'ou
    // l'enchainement IMMEDIAT ici plutot qu'un passage par une file.
    //
    // `creerDepuisTentative` se reclame lui-meme (verrou `resa-crs:`) : deux
    // livraisons simultanees de `completed` ne peuvent pas creer deux
    // reservations. Il gere aussi ses trois issues — succes, refus certain
    // (remboursement), issue incertaine (alarme qui reveille).
    console.log('[book-webhook] tentative payee, creation', tentative.id)
    let creation
    try {
      creation = await creerDepuisTentative(supabase, tentative.id)
    } catch (e) {
      // ⚠ UNE EXCEPTION ICI NE DOIT PAS FAIRE ECHOUER LE WEBHOOK. Stripe
      // rejouerait `completed`, et le rejeu retomberait sur `transitionPermise`
      // qui l'ignorerait (la tentative est deja `paid`) : la creation ne serait
      // JAMAIS retentee, et personne ne le saurait. On alerte, et on rend 200.
      // ⚠ `alerterReveil`, PAS `alerter`. Constat de review : `alerter` passe par
      // `reportIncident`, qui se tait si une alerte du meme type et du meme bien
      // est deja partie dans l'heure — deux paiements bloques sur le meme bien
      // dans la meme heure, et LE SECOND VOYAGEUR EST SILENCIEUX. C'est
      // exactement l'anti-spam que l'exigence gravee demande de contourner.
      console.error('[book-webhook] creation', tentative.id, e.message)
      const bien = await bienDe(tentative.property_id)
      // Les faits (dates, montant, voyageur, heure du paiement, code) sont
      // ajoutes par `alerterReveil` : ici on ne dit que la CAUSE.
      await alerterReveil({ ...tentative, paid_at: tentative.paid_at || new Date().toISOString() }, bien,
        `Creation interrompue par une erreur (${e.message}). Verifier chez le provider AVANT tout geste.`)
      return
    }

    if (!creation.ok && creation.raison !== 'deja_en_cours') {
      console.error('[book-webhook] creation non aboutie', tentative.id, creation.raison)
    }
  }
}

// Une creation est-elle en cours pour cette tentative ? Le claim de
// `lib/moteur-creation.js` est la seule source de verite la-dessus.
async function claimActif (tentativeId) {
  // ⚠ L'ERREUR SE LIT DANS `error`, PAS DANS UN `catch`. Constat de review,
  // verifie par execution : postgrest-js NE LEVE JAMAIS sans `.throwOnError()`
  // — il convertit meme une panne fetch en `{ data: null, error }`.
  // Le `try/catch` precedent etait donc du CODE MORT : sur la moindre erreur,
  // `data` valait `null`, `!!data` valait `false`, on concluait « aucune
  // creation en vol » et on liberait les tenues PENDANT le POST CRS. C'est
  // exactement la fenetre de surreservation que ce garde pretend fermer.
  const { data, error } = await supabase.from('write_locks')
    .select('key').eq('key', `resa-crs:${tentativeId}`)
    .gt('expire_at', new Date().toISOString()).maybeSingle()
  if (error) {
    // On ne sait pas : on suppose qu'une creation est en cours. Garder une tenue
    // de trop coute une reservation ratee ; la lever de trop coute une
    // surreservation.
    console.error('[book-webhook] lecture du claim echouee', error.message)
    return true
  }
  return !!data
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
      .from('properties').select('name, provider_property_id').eq('id', uuid).maybeSingle()
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
// Expose pour que le garde anti-surreservation soit eprouve pour de vrai, et
// non par une lecture de source — c'est ce qui avait laisse passer le code mort.
module.exports.claimActif = claimActif
