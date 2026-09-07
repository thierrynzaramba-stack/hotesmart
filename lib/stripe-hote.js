// lib/stripe-hote.js
// DOC : docs/kb/moteur-reservation.md §10 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §3 bis et §5.1
//
// LE COMPTE STRIPE DE L'HOTE — modele « chaque hote apporte ses cles ».
// Pas de Connect, pas de compte plateforme : le moteur encaisse avec la cle du
// PROPRIETAIRE du bien. L'hote-fondateur n'est pas un cas particulier — sa ligne
// est une ligne comme les autres, et aucune branche `si fondateur` n'existe ici.
//
// LES TROIS EXIGENCES GRAVEES, et ou elles vivent :
//   1. chiffrees, jamais loguees, jamais reaffichees  -> `lib/chiffrement.js`
//      + `etatPublic()`, qui est le SEUL rendu autorise
//   2. onboarding vers des cles RESTREINTES           -> `verifierCle()`
//   3. webhook cree automatiquement a la connexion    -> `creerWebhook()`
//
// ⚠ RIEN DANS CE FICHIER NE JOURNALISE UNE CLE. Les messages d'erreur de Stripe
// recopient volontiers la cle fautive ; ils passent tous par `sansSecrets()`.

const crypto = require('crypto')
const Stripe = require('stripe')
const { chiffrer, dechiffrer, empreinteCle, sansSecrets } = require('./chiffrement')

const API_VERSION = '2025-07-30.basil'

// Les evenements dont le moteur a besoin. Liste FERMEE : un webhook qui ecoute
// tout inonderait l'endpoint d'evenements sans objet, et chacun coute une
// verification de signature.
const EVENEMENTS = [
  'checkout.session.completed',      // le paiement a abouti
  'checkout.session.expired',        // abandon : libere la tenue sans attendre
  'payment_intent.payment_failed',   // refus
  'charge.refunded'                  // remboursement (regle 4 du §2)
]

// Meme recette que partout ailleurs : 32 octets, base64url, 43 caracteres.
const nouveauJeton = () => crypto.randomBytes(32).toString('base64url')

// ⚠ La base peut arriver avec un slash final. `APP_URL` est concatenee telle
// quelle ailleurs dans le depot (api/stripe.js), donc un slash de trop y
// produirait `//api/...`. On normalise ici pour que l'URL envoyee a Stripe — et
// enregistree chez l'hote — ne puisse pas etre malformee par une faute de frappe
// dans une variable d'environnement.
function base () {
  const b = process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app'
  return String(b).trim().replace(/\/+$/, '')
}

const urlWebhook = jeton => `${base()}/api/book-webhook/${jeton}`

function client (cle) {
  return new Stripe(cle, { apiVersion: API_VERSION })
}

// ─── Exigence 2 : la cle est-elle utilisable, et est-elle la bonne sorte ? ────
// On VERIFIE avant de stocker. Une cle fausse doit etre refusee a l'ecran, pas
// decouverte par le premier voyageur devant sa page de paiement.
//
// La verification appelle un droit dont on a REELLEMENT besoin
// (`PaymentIntents: read`) : un controle sur un droit inutilise validerait des
// cles incapables d'encaisser.
async function verifierCle (cleBrute) {
  const cle = String(cleBrute || '').trim()
  if (!cle) return { ok: false, raison: 'cle_vide' }
  if (!/^(rk|sk)_(test|live)_[A-Za-z0-9]+$/.test(cle)) return { ok: false, raison: 'cle_forme_invalide' }

  const empreinte = empreinteCle(cle)
  if (!empreinte.mode) return { ok: false, raison: 'mode_indetermine' }

  // ⚠ SEULES LES CLES RESTREINTES SONT ACCEPTEES (decision Thierry, 7 sept 2026).
  // Une `sk_` donne a HoteSmart les PLEINS POUVOIRS sur le compte Stripe de
  // l'hote : creer des clients, deplacer des fonds, modifier ses abonnements,
  // lire toute son activite. Une `rk_` limite la casse d'une fuite aux droits
  // reellement necessaires.
  //
  // Le refus est ANTERIEUR a l'appel Stripe : on n'envoie meme pas sur le reseau
  // une cle qu'on n'acceptera pas.
  //
  // ⚠ Ce refus a remplace un simple AVERTISSEMENT. Raison gravee : « un
  // avertissement qu'on clique pour passer n'est pas une protection ». Ne pas
  // le reintroduire au motif qu'un hote est bloque — l'ecran le guide pour
  // creer une cle restreinte, c'est la reponse.
  if (!empreinte.restreinte) return { ok: false, raison: 'cle_non_restreinte' }

  try {
    await client(cle).paymentIntents.list({ limit: 1 })
  } catch (e) {
    const code = e && e.statusCode
    // 401 : la cle n'existe pas, ou a ete revoquee.
    if (code === 401) return { ok: false, raison: 'cle_refusee' }
    // 403 : la cle est valide mais restreinte trop court. On le dit precisement —
    // « ca ne marche pas » enverrait l'hote tout recommencer au hasard.
    if (code === 403) return { ok: false, raison: 'droit_paiements_manquant' }
    console.error('[stripe-hote] verification', sansSecrets(e.message))
    return { ok: false, raison: 'stripe_injoignable' }
  }

  return { ok: true, mode: empreinte.mode, last4: empreinte.last4, restreinte: true }
}

// ─── Exigence 3 : creer le webhook sur le compte de l'hote ───────────────────
// Rend { ok, id, secret } — ou { ok:false, raison } SANS jamais basculer en
// silence vers autre chose. Si le droit manque, l'appelant le dit a l'hote et
// bascule sur le repli manuel prevu par la spec.
async function creerWebhook (cle, jeton) {
  try {
    const w = await client(cle).webhookEndpoints.create({
      url: urlWebhook(jeton),
      enabled_events: EVENEMENTS,
      description: 'Reservations directes — ne pas supprimer'
    })
    // Le `secret` n'est rendu QU'A LA CREATION. Ne pas le capter ici obligerait
    // a supprimer le webhook et a le recreer pour en obtenir un.
    if (!w || !w.secret) return { ok: false, raison: 'secret_absent' }
    return { ok: true, id: w.id, secret: w.secret }
  } catch (e) {
    const code = e && e.statusCode
    if (code === 403) return { ok: false, raison: 'droit_webhook_manquant' }
    console.error('[stripe-hote] creation webhook', sansSecrets(e.message))
    return { ok: false, raison: 'webhook_refuse', detail: sansSecrets(e.message).slice(0, 200) }
  }
}

// Suppression au mieux : un webhook deja disparu n'est pas une erreur. Ce qui
// serait une erreur, c'est d'en laisser DEUX vivants — chaque evenement serait
// alors livre deux fois, et l'idempotence des traitements ferait tout le travail
// toute seule, ce qui est exactement ce qu'on ne veut pas lui demander.
async function supprimerWebhook (cle, id) {
  if (!id) return { ok: true }
  try {
    await client(cle).webhookEndpoints.del(id)
    return { ok: true }
  } catch (e) {
    console.error('[stripe-hote] suppression webhook', id, sansSecrets(e.message))
    return { ok: false, raison: sansSecrets(e.message).slice(0, 200) }
  }
}

// ─── Ce que l'ecran a le droit de voir ───────────────────────────────────────
// LE SEUL RENDU AUTORISE. Jamais la cle, jamais le secret du webhook, jamais
// meme leur forme chiffree — un chiffre rendu au navigateur est un chiffre qu'on
// pourra tenter de casser hors ligne.
function etatPublic (ligne) {
  if (!ligne) return { connecte: false }
  return {
    connecte: true,
    mode: ligne.mode,
    last4: ligne.key_last4 || null,
    restreinte: ligne.key_restricted === true,
    // ⚠ TROIS ETATS. `manuel` manquait : un hote qui avait suivi le repli
    // documente et colle un `whsec_` valide lisait quand meme « Webhook
    // manquant », et le bloc de repli restait ouvert indefiniment — alors que
    // `api/book-public.js` le considerait, lui, pret a encaisser. Les deux
    // lectures se contredisaient. Constat de review.
    webhook: ligne.webhook_endpoint_id ? 'automatique'
      : (ligne.webhook_secret_cipher ? 'manuel' : 'manquant'),
    verifie_le: ligne.verified_at || null,
    derniere_erreur: ligne.last_error || null
  }
}

// ─── La cle, pour s'en servir ────────────────────────────────────────────────
// Le SEUL chemin qui rend une cle en clair, et il ne sert qu'au serveur, au
// moment d'encaisser. Il n'est expose par aucun endpoint.
async function cleDeLHote (supabase, userId) {
  const { data, error } = await supabase
    .from('stripe_accounts')
    .select('id, user_id, secret_key_cipher, mode, webhook_url_token, verified_at')
    .eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`lecture stripe_accounts : ${error.message}`)
  if (!data) return { ok: false, raison: 'non_connecte' }
  try {
    return { ok: true, cle: dechiffrer(data.secret_key_cipher), mode: data.mode, ligne: data }
  } catch (e) {
    // Dechiffrement impossible : la cle de chiffrement a change, ou la ligne est
    // alteree. On ne devine pas — on refuse d'encaisser.
    console.error('[stripe-hote] dechiffrement impossible', userId, e.message)
    return { ok: false, raison: 'secret_illisible' }
  }
}

// Le secret du webhook d'un hote, retrouve par le jeton de son URL. C'est ce qui
// rend la verification de signature possible : le corps d'un webhook pose sur le
// compte propre d'un hote ne dit pas de quel compte il vient.
async function secretWebhookParJeton (supabase, jeton) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(jeton || ''))) return { ok: false, raison: 'jeton_invalide' }
  const { data, error } = await supabase
    .from('stripe_accounts')
    .select('id, user_id, webhook_secret_cipher, mode')
    .eq('webhook_url_token', jeton).maybeSingle()
  if (error) throw new Error(`lecture stripe_accounts : ${error.message}`)
  if (!data || !data.webhook_secret_cipher) return { ok: false, raison: 'jeton_inconnu' }
  try {
    return { ok: true, secret: dechiffrer(data.webhook_secret_cipher), ligne: data }
  } catch (e) {
    console.error('[stripe-hote] secret webhook illisible', data.id, e.message)
    return { ok: false, raison: 'secret_illisible' }
  }
}

// ─── Connecter (ou remplacer) ────────────────────────────────────────────────
// L'ordre compte, et il est le suivant :
//   1. verifier la cle           — rien n'est stocke avant
//   2. supprimer l'ancien webhook AVEC L'ANCIENNE CLE, tant qu'on l'a encore
//   3. creer le nouveau webhook
//   4. ecrire, tout chiffre
//
// L'etape 2 avant l'ecriture n'est pas un detail : une fois l'ancienne cle
// ecrasee, l'ancien webhook devient impossible a supprimer, et il continue de
// livrer des evenements que plus aucun secret ne verifie.
async function connecter (supabase, userId, cleBrute) {
  const v = await verifierCle(cleBrute)
  if (!v.ok) return v

  const cle = String(cleBrute).trim()

  const { data: existante, error: eLect } = await supabase
    .from('stripe_accounts').select('*').eq('user_id', userId).maybeSingle()
  if (eLect) throw new Error(`lecture stripe_accounts : ${eLect.message}`)

  // ⚠ On RETIENT si l'ancien endpoint a reellement ete supprime : sans cela, un
  // echec de re-creation laissait en base l'id d'un endpoint DETRUIT et un
  // secret qui ne correspondait plus a rien. L'ecran affichait alors « webhook
  // automatique » (pas de repli propose), `book-public` declarait le paiement
  // actif, les voyageurs payaient — et aucun evenement n'etait jamais livre.
  // Constat de review.
  let ancienSupprime = false
  if (existante && existante.webhook_endpoint_id) {
    let ancienne = null
    try { ancienne = dechiffrer(existante.secret_key_cipher) } catch (e) { /* illisible : on ne peut plus rien supprimer */ }
    if (ancienne) {
      const sup = await supprimerWebhook(ancienne, existante.webhook_endpoint_id)
      ancienSupprime = sup.ok
    }
  }

  // Le jeton d'URL est CONSERVE d'une reconnexion a l'autre quand il existe :
  // le changer sans raison invaliderait une URL deja enregistree ailleurs.
  const jeton = (existante && existante.webhook_url_token) || nouveauJeton()
  const w = await creerWebhook(cle, jeton)

  const ligne = {
    user_id: userId,
    secret_key_cipher: chiffrer(cle),
    key_last4: v.last4,
    mode: v.mode,
    key_restricted: v.restreinte,
    webhook_url_token: jeton,
    // Trois cas, et un seul conserve l'ancien :
    //   creation reussie        -> le nouveau
    //   echec, ancien SUPPRIME  -> rien (l'ancien ne repond plus)
    //   echec, ancien intact    -> l'ancien (il marche encore)
    // ⚠ NE PAS EFFACER UN SECRET QUI MARCHE : quand la creation automatique
    // echoue et que l'hote avait colle un `whsec_` a la main, remettre ce champ
    // a `null` le detruisait alors que son webhook survivait chez Stripe — les
    // paiements aboutissaient, plus rien n'etait verifiable, la tentative
    // restait `pending` sans alarme. Constat de review.
    webhook_endpoint_id: w.ok ? w.id
      : (ancienSupprime ? null : (existante ? existante.webhook_endpoint_id : null)),
    webhook_secret_cipher: w.ok ? chiffrer(w.secret)
      : (ancienSupprime ? null : (existante ? existante.webhook_secret_cipher : null)),
    verified_at: new Date().toISOString(),
    // Le repli manuel est un ETAT, pas un echec silencieux : il s'affiche.
    last_error: w.ok ? null : w.raison,
    updated_at: new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('stripe_accounts').upsert(ligne, { onConflict: 'user_id' })
    .select('*').maybeSingle()
  if (error) throw new Error(`ecriture stripe_accounts : ${error.message}`)

  return {
    ok: true,
    etat: etatPublic(data),
    // Le repli manuel prevu par la spec : l'hote cree le webhook lui-meme.
    webhook_manuel: w.ok ? null : { raison: w.raison, url: urlWebhook(jeton), evenements: EVENEMENTS }
  }
}

// L'hote colle lui-meme le `whsec_` quand la creation automatique a echoue.
async function poserSecretWebhookManuel (supabase, userId, secretBrut) {
  const secret = String(secretBrut || '').trim()
  if (!/^whsec_[A-Za-z0-9]+$/.test(secret)) return { ok: false, raison: 'secret_forme_invalide' }
  // ⚠ `.update()` sur ZERO ligne ne leve pas. Sans `.select()`, la fonction
  // annoncait « secret enregistre, la confirmation est branchee » alors qu'aucun
  // compte n'existait. Constat de review : un message faux sur un chemin
  // d'argent ne coute rien a corriger et beaucoup a laisser.
  const { data, error } = await supabase.from('stripe_accounts')
    .update({ webhook_secret_cipher: chiffrer(secret), last_error: null, updated_at: new Date().toISOString() })
    .eq('user_id', userId).select('id')
  if (error) throw new Error(`ecriture stripe_accounts : ${error.message}`)
  if (!data || !data.length) return { ok: false, raison: 'non_connecte' }
  return { ok: true }
}

// Deconnecter : on supprime le webhook chez l'hote AVANT d'effacer la ligne.
// L'inverse laisserait un webhook orphelin qui frappe une URL morte.
async function deconnecter (supabase, userId) {
  const { data, error } = await supabase
    .from('stripe_accounts').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`lecture stripe_accounts : ${error.message}`)
  if (!data) return { ok: true, deja: true }

  if (data.webhook_endpoint_id) {
    try {
      const cle = dechiffrer(data.secret_key_cipher)
      await supprimerWebhook(cle, data.webhook_endpoint_id)
    } catch (e) { console.error('[stripe-hote] webhook non supprime', sansSecrets(e.message)) }
  }
  const { error: eSup } = await supabase.from('stripe_accounts').delete().eq('user_id', userId)
  if (eSup) throw new Error(`suppression stripe_accounts : ${eSup.message}`)
  return { ok: true }
}

module.exports = {
  API_VERSION, EVENEMENTS,
  base, urlWebhook, nouveauJeton,
  verifierCle, creerWebhook, supprimerWebhook,
  etatPublic, cleDeLHote, secretWebhookParJeton,
  connecter, poserSecretWebhookManuel, deconnecter
}
