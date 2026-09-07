// api/stripe-hote.js
// DOC : docs/kb/moteur-reservation.md §10 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §5.1
//
// CONNEXION DU COMPTE STRIPE DE L'HOTE — app « Reservation directe ».
// Le seul chemin par lequel une cle Stripe d'hote entre dans HoteSmart.
//
// ⚠ GARDE : domaine `facturation`, niveau `write`. Ce domaine est NON DELEGABLE
// (lib/permissions.js) : seul le TITULAIRE du compte connecte ou remplace une
// cle. Un collaborateur delegue, meme avec tous les autres droits, ne peut pas
// brancher un compte Stripe — ce serait detourner l'argent d'un hote sans qu'il
// le sache.
//
// ⚠ AUCUNE REPONSE DE CET ENDPOINT NE CONTIENT UNE CLE, ni en clair ni chiffree.
// `etatPublic()` est le seul rendu autorise : mode, 4 derniers caracteres, etat
// du webhook. Un chiffre rendu au navigateur est un chiffre qu'on pourra tenter
// de casser hors ligne.
//
// PAS DE GET QUI RENDRAIT LA CLE. Il n'existe aucun « afficher ma cle » :
// l'hote qui l'a perdue en cree une neuve chez Stripe et la remplace ici.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { sansSecrets } = require('../lib/chiffrement')
const {
  etatPublic, connecter, deconnecter, poserSecretWebhookManuel, urlWebhook, EVENEMENTS
} = require('../lib/stripe-hote')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Messages destines a l'hote. Ils disent QUOI FAIRE, pas seulement ce qui a
// rate : « cle refusee » sans la suite renvoie l'hote tout recommencer au hasard.
const MESSAGES = {
  cle_vide: 'Aucune clé saisie.',
  cle_forme_invalide: 'Cette clé n’a pas la forme d’une clé Stripe restreinte (elle doit commencer par rk_).',
  cle_non_restreinte: 'Seules les clés RESTREINTES (rk_) sont acceptées. Une clé secrète complète (sk_) donnerait à HôteSmart les pleins pouvoirs sur votre compte Stripe. Suivez le guide pour créer une clé restreinte.',
  mode_indetermine: 'Impossible de savoir si cette clé est en mode test ou réel. Recopiez-la entièrement.',
  cle_refusee: 'Stripe refuse cette clé. Elle a peut-être été révoquée, ou recopiée incomplètement.',
  droit_paiements_manquant: 'Cette clé restreinte n’a pas le droit « PaymentIntents : lecture ». Ajoutez-le chez Stripe, puis recollez-la.',
  stripe_injoignable: 'Stripe ne répond pas pour le moment. Réessayez dans un instant.',
  secret_forme_invalide: 'Ce secret de webhook n’a pas la forme attendue (il commence par whsec_).',
  non_connecte: 'Aucun compte Stripe connecté.'
}

function corps (req) {
  if (!req.body) return {}
  if (typeof req.body === 'object') return req.body
  try { return JSON.parse(req.body) } catch (e) { return null }
}

async function handler (req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'methode_non_autorisee' })
  }

  // ⚠ `facturation` etant non delegable, `accountUserId` EST l'appelant : il n'y
  // a pas de cas ou l'on agirait sur le compte d'un autre. On utilise quand meme
  // `accountUserId` plutot que `userId` — si le modele de droits changeait, ce
  // code viserait toujours le compte proprietaire, jamais l'appelant.
  const garde = await requirePermission(req, res, { domaine: 'facturation', niveau: 'write' })
  if (!garde.ok) return
  const hote = garde.accountUserId

  // ─── Etat ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('stripe_accounts')
        .select('mode, key_last4, key_restricted, webhook_endpoint_id, webhook_secret_cipher, webhook_url_token, verified_at, last_error')
        .eq('user_id', hote).maybeSingle()
      if (error) throw new Error(error.message)
      const etat = etatPublic(data)
      // L'URL du webhook n'est pas un secret : c'est un point d'entree public
      // dont le jeton ne sert qu'a router. On ne la rend QUE si la creation
      // automatique a echoue — c'est alors ce que l'hote doit recopier.
      // Le repli n'est propose que s'il n'y a AUCUN moyen de recevoir les
      // evenements — ni endpoint automatique, ni secret colle a la main.
      if (data && !data.webhook_endpoint_id && !data.webhook_secret_cipher && data.webhook_url_token) {
        etat.webhook_manuel = { url: urlWebhook(data.webhook_url_token), evenements: EVENEMENTS }
      }
      return res.status(200).json(etat)
    } catch (e) {
      console.error('[stripe-hote] etat', sansSecrets(e.message))
      return res.status(500).json({ error: 'indisponible' })
    }
  }

  // ─── Deconnexion ───────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      await deconnecter(supabase, hote)
      return res.status(200).json({ connecte: false })
    } catch (e) {
      console.error('[stripe-hote] deconnexion', sansSecrets(e.message))
      return res.status(500).json({ error: 'indisponible' })
    }
  }

  const body = corps(req)
  if (!body) return res.status(400).json({ error: 'corps_illisible' })

  // ─── Secret de webhook colle a la main (repli) ─────────────────────────────
  if (body.action === 'webhook_manuel') {
    try {
      const r = await poserSecretWebhookManuel(supabase, hote, body.secret)
      if (!r.ok) return res.status(400).json({ error: r.raison, message: MESSAGES[r.raison] || null })
      return res.status(200).json({ ok: true })
    } catch (e) {
      console.error('[stripe-hote] webhook manuel', sansSecrets(e.message))
      return res.status(500).json({ error: 'indisponible' })
    }
  }

  // ─── Connexion / remplacement ──────────────────────────────────────────────
  try {
    const r = await connecter(supabase, hote, body.cle)
    if (!r.ok) {
      // 400 : c'est la cle qui est en cause, l'hote peut corriger.
      // 502 : c'est Stripe, il n'y a rien a corriger de son cote.
      const code = r.raison === 'stripe_injoignable' ? 502 : 400
      return res.status(code).json({ error: r.raison, message: MESSAGES[r.raison] || null })
    }
    return res.status(200).json(r)
  } catch (e) {
    // ⚠ `sansSecrets` : un message d'erreur Stripe recopie volontiers la cle
    // fautive, et les journaux Vercel la garderaient lisible bien apres.
    console.error('[stripe-hote] connexion', sansSecrets(e.message))
    return res.status(500).json({ error: 'indisponible' })
  }
}

module.exports = handler
