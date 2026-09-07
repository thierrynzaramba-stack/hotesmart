// api/book-pay.js
// DOC : docs/kb/moteur-reservation.md §11 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §2 (ordre) et §5.2
//
// LE CHEMIN QUI TOUCHE A L'ARGENT. Endpoint public, non authentifie : le jeton
// du lien est le droit d'acces, comme pour la lecture.
//
// ⚠ L'ARGENT VA CHEZ L'HOTE, PAS CHEZ NOUS. La Checkout Session est creee avec
// LA CLE RESTREINTE DE L'HOTE (lib/stripe-hote.js). Pas de Connect, pas de
// compte plateforme, aucune commission. L'hote-fondateur n'est pas un cas
// particulier : sa cle est une ligne comme les autres, et aucune branche
// `si fondateur` n'existe ici.
//
// L'ORDRE, GRAVE AU §2 :
//   1. VERROU + verification capacite / stop-sell / prix  <- rien n'est promis
//   2. tenue des nuits, puis Checkout Session
//   3. creation CRS                                       <- etape 3
//   4. echec de creation apres encaissement -> remboursement + alarme
//
// CE QUI N'EST JAMAIS CRU DU NAVIGATEUR : le montant. Il est recalcule ici par
// le meme `validerSejour` qui a servi a l'afficher. Un client qui poste
// `total: 1` paie le vrai prix ou ne paie pas.

const { createClient } = require('@supabase/supabase-js')
const Stripe = require('stripe')
const { validerSejour, raisonNonVendable } = require('../lib/moteur-reservation')
const { resoudreLien, chargerCalendrier } = require('../lib/moteur-coeur')
const { nuits, poserVerrou, libererVerrou, poserIntentions } = require('../lib/reservation-directe')
const { cleDeLHote, API_VERSION } = require('../lib/stripe-hote')
const { sansSecrets } = require('../lib/chiffrement')
const {
  ETAT, montantStripe, cleIdempotence, cleStripe, tenueExpireA, tenueExpiree,
  sessionExpireDepuisTenue, TENUE_MS, nettoyerVoyageur, langueValide, paiementAutorise
} = require('../lib/moteur-paiement')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Large : le sejour demande peut finir au bout de la fenetre publiee.
const HORIZON = 400

// Tenues simultanees admises par bien. Assez pour plusieurs voyageurs de bonne
// foi, trop peu pour bloquer un calendrier a la main.
const TENUES_MAX = 5

function aujourdhui () { return new Date().toISOString().slice(0, 10) }

// ⚠ Normalise : `APP_URL` est concatenee telle quelle ailleurs dans le depot, et
// un slash final y produirait `//book/...`.
function base () {
  const b = process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app'
  return String(b).trim().replace(/\/+$/, '')
}

// Le corps peut arriver deja parse (Vercel) ou en chaine. On ne suppose ni l'un
// ni l'autre : un corps illisible est un refus propre, pas une exception.
function corps (req) {
  if (!req.body) return {}
  if (typeof req.body === 'object') return req.body
  try { return JSON.parse(req.body) } catch (e) { return null }
}

module.exports = async function handler (req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'methode_non_autorisee' })

  // ─── GARDE DE L'ETAPE 2 ────────────────────────────────────────────────────
  // Tant que la creation (etape 3) n'existe pas, un paiement reussi laisserait
  // de l'argent encaisse sans reservation. L'absence de la variable est le
  // comportement SUR.
  if (!paiementAutorise()) return res.status(503).json({ error: 'paiement_indisponible' })

  const body = corps(req)
  if (!body) return res.status(400).json({ error: 'corps_illisible' })

  const { lien, bien, erreur } = await resoudreLien(supabase, body.token)
  if (erreur) return res.status(erreur === 'indisponible' ? 500 : 404).json({ error: erreur })

  const blocage = raisonNonVendable(bien)
  if (blocage) return res.status(409).json({ error: 'ferme', raison: blocage })

  // ─── La cle de l'HOTE ──────────────────────────────────────────────────────
  // Sans compte Stripe connecte, il n'y a rien a encaisser. On le dit avant de
  // toucher au calendrier — inutile de tenir des nuits pour rien.
  let cleHote
  try {
    cleHote = await cleDeLHote(supabase, bien.user_id)
  } catch (e) {
    console.error('[book-pay] lecture cle hote', sansSecrets(e.message))
    return res.status(500).json({ error: 'indisponible' })
  }
  if (!cleHote.ok) return res.status(409).json({ error: 'paiement_non_configure', raison: cleHote.raison })

  const v = nettoyerVoyageur(body)
  if (!v.ok) return res.status(400).json({ error: 'voyageur_invalide', raison: v.raison })
  const langue = langueValide(body.lang)

  const arrivee = String(body.arrivee || '')
  const depart = String(body.depart || '')
  const personnes = Number(body.personnes)

  // ─── L'identite de la vente, AVANT tout calcul de prix ─────────────────────
  // ⚠ L'ORDRE COMPTE, et la cle NE PORTE PAS LE MONTANT. Constat de review :
  // le montant y figurait, et il DESARMAIT la protection qu'il croyait
  // renforcer. Une fois les nuits tenues, le calendrier les compte prises,
  // `validerSejour` echoue, `montantStripe` rend `null` — et la cle calculee au
  // retour du voyageur differait de celle de sa vente. La tentative deja PAYEE
  // devenait introuvable, et il lisait « ces nuits ne sont plus disponibles » a
  // propos de nuits qu'il venait de payer.
  const cle = cleIdempotence({
    lienId: lien.id, arrival: arrivee, departure: depart,
    personnes, email: v.voyageur.email
  })

  let tentative = null
  try {
    const { data, error } = await supabase
      .from('booking_attempts').select('*').eq('idempotency_key', cle).maybeSingle()
    if (error) throw new Error(error.message)
    tentative = data
  } catch (e) {
    console.error('[book-pay] lecture tentative', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }

  // Deja payee : on ne recree RIEN, surtout pas une seconde Session.
  if (tentative && (tentative.status === ETAT.PAYE || tentative.status === ETAT.RESERVE)) {
    return res.status(200).json({ deja_paye: true, statut: tentative.status })
  }
  // ⚠ UN REMBOURSEMENT EST TERMINAL. Constat de review : le meme voyageur qui
  // resoumettait le meme sejour retombait sur la meme cle, et l'upsert remettait
  // la ligne a `pending` — en ecrasant la trace du remboursement et en gardant
  // l'ancien `payment_intent_id`. On refuse : une nouvelle vente apres
  // remboursement se fait sur un autre sejour, ou par un geste de l'hote.
  if (tentative && tentative.status === ETAT.REMBOURSE) {
    return res.status(409).json({ error: 'deja_rembourse' })
  }

  const stripe = new Stripe(cleHote.cle, { apiVersion: API_VERSION })

  // ⚠ NOTRE PROPRE TENUE EST RETIREE DE L'OCCUPATION.
  // Sans cela, une tentative se refuse ELLE-MEME : ses nuits, qu'elle vient de
  // tenir, lui reviennent comme « deja prises ». Les cles `resa-nuit:` ne disent
  // pas a qui elles sont — c'est a l'appelant de nommer les siennes.
  const tenueVivante = !!(tentative && tentative.status === ETAT.EN_ATTENTE && !tenueExpiree(tentative))
  const nuitsVoulues = nuits(arrivee, depart)
  const tenuePropre = tenueVivante ? nuits(tentative.arrival, tentative.departure) : []

  // Une Session encore ouverte : on la rend telle quelle.
  if (tenueVivante && tentative.checkout_session_id) {
    try {
      const ouverte = await stripe.checkout.sessions.retrieve(tentative.checkout_session_id)
      if (ouverte && ouverte.url && ouverte.status === 'open') {
        return res.status(200).json({
          url: ouverte.url, tentative: tentative.id,
          montant: tentative.amount_cents, devise: tentative.currency, mode: cleHote.mode
        })
      }
    } catch (e) {
      console.error('[book-pay] Session introuvable', sansSecrets(e.message))
      // On recree : mieux vaut une nouvelle Session qu'une URL de paiement morte.
    }
  }

  // ─── Point 1 : le refus arrive AVANT l'encaissement ────────────────────────
  let devis
  try {
    const calendrier = await chargerCalendrier(supabase, bien, lien, aujourdhui(), HORIZON, tenuePropre)
    devis = validerSejour({ calendrier, bien, lien, arrival: arrivee, departure: depart, personnes })
  } catch (e) {
    console.error('[book-pay] calendrier', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }
  if (!devis.ok) {
    return res.status(409).json({
      error: 'sejour_indisponible', raison: devis.raison,
      minimum: devis.minimum || null, maximum: devis.maximum || null
    })
  }

  const montant = montantStripe(devis, bien.currency)
  if (montant == null) {
    console.error('[book-pay] montant incalculable', bien.id)
    return res.status(500).json({ error: 'indisponible' })
  }

  // ─── Verrou : verifier ET tenir sans que rien ne s'intercale ───────────────
  // Sans lui, deux voyageurs qui verifient les memes nuits en meme temps les
  // voient libres tous les deux, tiennent tous les deux, et paient tous les
  // deux. C'est LE VERROU DE LA PHASE 2, meme cle : la saisie manuelle de
  // l'hote et le moteur direct s'excluent mutuellement, ce qui est voulu.
  const verrou = await poserVerrou(supabase, {
    userId: bien.user_id, propertyId: String(bien.provider_property_id)
  })
  if (!verrou.ok) return res.status(409).json({ error: 'reessayez', raison: verrou.raison })

  let ligne
  try {
    // ⚠ GARDE ANTI-ACCAPAREMENT. Cet endpoint est public et non authentifie :
    // quelques POST valides suffiraient a tenir toutes les nuits d'un bien
    // pendant 35 minutes, et a remplir le compte Stripe de l'hote de Sessions.
    // Ce n'est PAS une limitation de debit — elle reste une dette — mais elle
    // rend le deni de reservation bien plus couteux.
    if (!tenueVivante) {
      const { data: enCours, error: eCours } = await supabase
        .from('booking_attempts').select('id')
        .eq('property_id', bien.id).eq('status', ETAT.EN_ATTENTE)
        .gt('hold_expires_at', new Date().toISOString())
      if (eCours) throw new Error(`lecture des tenues : ${eCours.message}`)
      if ((enCours || []).length >= TENUES_MAX) {
        return res.status(429).json({ error: 'trop_de_tentatives' })
      }
    }

    // Re-verification SOUS VERROU : le calendrier lu plus haut date d'avant le
    // verrou, et une autre vente a pu passer entre les deux.
    const frais = await chargerCalendrier(supabase, bien, lien, aujourdhui(), HORIZON, tenuePropre)
    const devis2 = validerSejour({ calendrier: frais, bien, lien, arrival: arrivee, departure: depart, personnes })
    if (!devis2.ok) return res.status(409).json({ error: 'sejour_indisponible', raison: devis2.raison })

    // Le prix a bouge entre l'affichage et la soumission : on REFUSE plutot que
    // d'encaisser un montant que le voyageur n'a pas vu.
    const montant2 = montantStripe(devis2, bien.currency)
    if (montant2 !== montant) {
      return res.status(409).json({ error: 'prix_modifie', total: devis2.total, devise: bien.currency })
    }

    // ⚠ LA TENUE NE SE PROLONGE PAS A CHAQUE APPEL — l'expiration de la Session
    // en derive, et la deplacer sans raison ferait changer un parametre
    // d'idempotence. Mais si elle est trop entamee pour porter une Session de
    // 30 minutes, on la RENOUVELLE plutot que de refuser : refuser bloquerait
    // les dates pendant toute la duree restante, sans recours. Constat de review.
    // La cle envoyee a Stripe porte la tenue : un renouvellement produit donc
    // une cle differente, ce qui est exactement ce que Stripe attend.
    let tenue = tenueVivante ? tentative.hold_expires_at : tenueExpireA()
    if (sessionExpireDepuisTenue(tenue) == null) tenue = tenueExpireA()

    const champs = {
      link_id: lien.id, property_id: bien.id, user_id: bien.user_id,
      arrival: arrivee, departure: depart, guests: personnes,
      guest_first_name: v.voyageur.prenom, guest_last_name: v.voyageur.nom,
      guest_email: v.voyageur.email, guest_phone: v.voyageur.tel,
      lang: langue,
      amount_cents: montant, currency: bien.currency || 'EUR',
      price_coefficient: lien.price_coefficient,
      price_detail: devis2.detail,
      status: ETAT.EN_ATTENTE,
      idempotency_key: cle,
      hold_expires_at: tenue,
      updated_at: new Date().toISOString()
    }

    // ⚠ PAS D'UPSERT AVEUGLE SUR LE STATUT. Constat de review : il remettait la
    // ligne a `pending` quoi qu'il arrive. Si le webhook ecrivait `paid` entre
    // notre lecture et cette ecriture (deux onglets, un fetch rejoue), on
    // ecrasait `paid` — l'alarme « paiement sans reservation » avait deja tire
    // et ne retirerait pas, donc de l'argent encaisse restait invisible et les
    // nuits se liberaient a l'expiration.
    // L'ecriture est donc CONDITIONNELLE sur le statut qu'on a lu.
    if (tentative) {
      const { data, error } = await supabase.from('booking_attempts')
        .update(champs).eq('id', tentative.id).eq('status', tentative.status).select('*')
      if (error) throw new Error(`ecriture tentative : ${error.message}`)
      if (!data || !data.length) {
        // Quelqu'un d'autre a fait avancer la tentative entre-temps.
        return res.status(409).json({ error: 'reessayez', raison: 'statut_modifie' })
      }
      ligne = data[0]
    } else {
      const { data, error } = await supabase.from('booking_attempts')
        .insert(champs).select('*').maybeSingle()
      if (error) throw new Error(`ecriture tentative : ${error.message}`)
      ligne = data
    }

    // Les nuits sont tenues MAINTENANT, sous verrou, AU NOM DE CETTE TENTATIVE.
    // Le `token` est ce qui empeche la liberation d'une AUTRE tentative
    // d'effacer celle-ci — et donc de rendre vendables des nuits en cours de
    // paiement.
    // ⚠ L'ECHEC DE POSE DOIT REMONTER. Constat de review : il n'etait que
    // journalise, et le voyageur partait payer sur Stripe pendant que ses nuits
    // restaient vendables a tout le monde — exactement la surreservation que la
    // tenue existe pour empecher. Partout ailleurs sur ce chemin une erreur de
    // lecture est relancee ; l'ecriture merite le meme traitement.
    const pose = await poserIntentions(supabase, {
      userId: bien.user_id, propertyId: String(bien.provider_property_id),
      nuits: nuitsVoulues, ttlMs: TENUE_MS, token: ligne.id
    })
    if (pose && pose.ok === false) throw new Error(`tenue non posee : ${pose.raison}`)
  } catch (e) {
    console.error('[book-pay] tentative', e.message)
    return res.status(500).json({ error: 'indisponible' })
  } finally {
    // Toujours libere : la Session se cree hors verrou, l'appel Stripe etant
    // beaucoup plus lent que le TTL de 60 s.
    await libererVerrou(supabase, verrou.cle, verrou.jeton)
  }

  // ─── Point 2 : la Checkout Session, sur le compte de l'HOTE ────────────────
  // L'expiration DERIVE de la tenue : stable d'un appel a l'autre, et toujours
  // AVANT elle. L'inverse laisserait payer, sur une page encore ouverte, des
  // nuits deja reliberees.
  // La tenue vient d'etre posee ou renouvelee sous verrou : elle porte forcement
  // une Session. Un `null` ici signalerait une incoherence de nos propres
  // constantes, pas une situation normale.
  const expire = sessionExpireDepuisTenue(ligne.hold_expires_at)
  if (expire == null) {
    console.error('[book-pay] tenue trop courte apres pose', ligne.id, ligne.hold_expires_at)
    return res.status(500).json({ error: 'indisponible' })
  }

  const retour = `${base()}/book/${encodeURIComponent(lien.token)}`
  let session
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: String(bien.currency || 'EUR').toLowerCase(),
          unit_amount: montant,
          product_data: {
            // ⚠ MARQUE BLANCHE : ce libelle est ce que le voyageur lit sur la
            // page Stripe et sur son releve bancaire. Le nom du BIEN, jamais le
            // notre.
            name: bien.name,
            description: `${devis.nuits.length} nuit(s) · ${arrivee} → ${depart} · ${personnes} voyageur(s)`
          }
        }
      }],
      success_url: `${retour}?paiement=ok`,
      cancel_url: `${retour}?paiement=annule`,
      client_reference_id: ligne.id,
      customer_email: v.voyageur.email,
      locale: langue,
      expires_at: expire,
      metadata: {
        source: 'hotesmart-engine',
        attempt_id: ligne.id,
        // La PROVENANCE (§3 ter, ajout 4) : elle voyage jusqu'a la reservation.
        link_label: String(lien.label || '').slice(0, 200),
        property: String(bien.provider_property_id || ''),
        arrival: arrivee, departure: depart, guests: String(personnes)
      }
      // ⚠ CLE D'IDEMPOTENCE DISTINCTE DE CELLE DE LA VENTE. Stripe REFUSE (400)
      // une cle rejouee avec des parametres differents pendant 24 h : reutiliser
      // la cle de vente bloquait le voyageur sur ces dates une journee entiere
      // des que le montant ou l'expiration changeait. Constat de review.
    }, { idempotencyKey: cleStripe(ligne.id, montant, ligne.hold_expires_at) })
  } catch (e) {
    console.error('[book-pay] Checkout Session', sansSecrets(e.message))
    // La tentative reste `pending`, ses nuits tenues : elles se libereront a
    // l'expiration. On ne les libere pas ici — un echec reseau ne prouve pas que
    // Stripe n'a rien cree.
    return res.status(502).json({ error: 'paiement_indisponible' })
  }

  try {
    await supabase.from('booking_attempts')
      .update({ checkout_session_id: session.id, updated_at: new Date().toISOString() })
      .eq('id', ligne.id)
  } catch (e) {
    // La Session existe mais nous ne savons plus laquelle : le webhook ne
    // pourra pas rattacher le paiement. On le dit fort.
    console.error('[book-pay] rattachement Session perdu', ligne.id, session.id, e.message)
  }

  return res.status(200).json({
    url: session.url,
    tentative: ligne.id,
    montant,
    devise: bien.currency || 'EUR',
    // Le voyageur doit savoir qu'il est sur une page de test — sinon il croit
    // avoir paye.
    mode: cleHote.mode
  })
}
