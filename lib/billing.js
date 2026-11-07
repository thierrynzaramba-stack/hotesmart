// lib/billing.js — Facturation niveau COMPTE (etape C).
//
// Modele cible :
//   - 1 abonnement Stripe unique par compte, produit graduated 3 paliers
//     (lookup_key 'hotesmart_property'), quantite = nombre de biens avec active_at non null.
//   - Trial 15 jours demarre au 1er active_at du compte, SANS CB.
//   - billing_cycle_anchor au 1er du mois : 1re facture au 1er suivant (prorata + mois qui demarre).
//   - Ajout d'un bien -> prorata natif. Retrait -> pas de remboursement : la quantite baisse
//     tout de suite, le nouveau tarif s'applique au cycle suivant (mois entame du).
//   - Archiver un bien recalcule l'abonnement IMMEDIATEMENT (decision de Thierry du
//     7 novembre 2026, « stop abonnement ») : lib/logement/archive.js, en `creer: false`.
//
// GARDE : aucun appel Stripe si le compte est en beta (accounts.is_beta = true).
//
// STATUT : creation + increment implementes. A VALIDER en Stripe TEST avant de sortir
// un compte de la beta (semantique trial+anchor+proration non testee en live).
// La garde serveur post-trial reste en dette (voir CLAUDE/notes).

const { supabase } = require('./cron-shared')
const { sansArchives } = require('./biens-vivants')
const Stripe = require('stripe')
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-07-30.basil' })

const PROPERTY_LOOKUP_KEY = 'hotesmart_property'
const TRIAL_DAYS = 15

async function isBeta(userId) {
  try {
    const { data } = await supabase.from('accounts').select('is_beta').eq('user_id', userId).maybeSingle()
    return data?.is_beta === true
  } catch (e) { return false }
}

// Nombre de biens facturables = biens avec active_at non null (Channex + Beds24 materialises),
// HORS biens archives. Decision de Thierry (lot « filtre biens vivants ») : « la liste exclut
// les archives ». Le filtre passe par `sansArchives`, le seul porteur de la regle.
async function countActiveProperties(userId) {
  const { count, error } = await sansArchives(supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('active_at', 'is', null))
  if (error) throw new Error('count active properties: ' + error.message)
  return count || 0
}

async function resolvePropertyPriceId() {
  const prices = await stripe.prices.list({ lookup_keys: [PROPERTY_LOOKUP_KEY], active: true })
  if (!prices.data.length) throw new Error(`Prix Stripe '${PROPERTY_LOOKUP_KEY}' introuvable (script de creation non lance ?)`)
  return prices.data[0].id
}

// Timestamp Unix (sec) du 1er jour du mois SUIVANT une date donnee, 00:00 UTC.
function firstOfNextMonthSec(fromMs) {
  const d = new Date(fromMs)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0) / 1000)
}

// Email du compte (pour le customer Stripe) via l'API admin (service key).
async function resolveEmail(userId, fallback) {
  if (fallback) return fallback
  try {
    const { data } = await supabase.auth.admin.getUserById(userId)
    return data?.user?.email || null
  } catch (e) { return null }
}

async function getOrCreateCustomer(userId, email) {
  const { data: acct } = await supabase
    .from('accounts').select('stripe_customer_id').eq('user_id', userId).maybeSingle()
  if (acct?.stripe_customer_id) return acct.stripe_customer_id
  const customer = await stripe.customers.create({
    email: await resolveEmail(userId, email),
    metadata: { hotesmart_user_id: userId }
  })
  await supabase.from('accounts')
    .upsert({ user_id: userId, stripe_customer_id: customer.id }, { onConflict: 'user_id' })
  return customer.id
}

// Point d'entree unique : appele quand le nombre de biens actifs du compte change.
// Idempotent : lit le nombre reel de biens actifs et aligne l'abonnement dessus.
// Retourne un objet de trace (jamais throw pour ne pas casser l'appelant : erreurs loggees).
//
// ⚠ `opts.creer === false` : on ALIGNE un abonnement existant, on n'en CREE
// jamais. C'est le mode de l'archivage (decision de Thierry du 7 novembre
// 2026 : « stop abonnement ») — retirer un bien ne doit pas ouvrir un essai
// Stripe sur un compte qui n'en avait pas. Sans l'option, rien ne change.
async function syncAccountBilling(userId, email, opts = {}) {
  try {
    if (await isBeta(userId)) return { skipped: 'beta' }

    const qty = await countActiveProperties(userId)
    const { data: acct } = await supabase
      .from('accounts')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('user_id', userId)
      .maybeSingle()

    // Plus aucun bien actif : on annule en fin de periode (mois entame du, pas de remboursement).
    if (qty === 0) {
      if (acct?.stripe_subscription_id) {
        await stripe.subscriptions.update(acct.stripe_subscription_id, { cancel_at_period_end: true })
        await supabase.from('accounts').update({ sub_quantity: 0 }).eq('user_id', userId)
      }
      return { qty: 0 }
    }

    // ⚠ AVANT LA RESOLUTION DU PRIX (constat 3 de la revue de 9fc95ec9) : `prices.list`
    // est un appel Stripe. Sans abonnement et sans droit d'en creer, il n'y a rien a
    // aligner — une panne Stripe ou un prix introuvable ne doit pas produire un echec.
    if (!acct?.stripe_subscription_id && opts.creer === false) return { qty, skipped: 'sans_abonnement' }

    const priceId = await resolvePropertyPriceId()

    // 1re activation du compte : creation de l'abonnement en trial, SANS CB.
    if (!acct?.stripe_subscription_id) {
      const customerId = await getOrCreateCustomer(userId, email)
      const nowMs = Date.now()
      const trialEndSec = Math.floor(nowMs / 1000) + TRIAL_DAYS * 24 * 3600
      const anchorSec = firstOfNextMonthSec(trialEndSec * 1000)
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId, quantity: qty }],
        trial_end: trialEndSec,
        billing_cycle_anchor: anchorSec,          // 1er du mois : 1re facture au 1er suivant, prorata inclus
        proration_behavior: 'create_prorations',
        collection_method: 'charge_automatically',
        // Aucune CB pendant le trial : si pas de moyen de paiement a la fin, on met en pause
        // (la garde serveur post-trial coupera l'acces aux features payantes — dette documentee).
        trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
        metadata: { hotesmart_user_id: userId }
      })
      await supabase.from('accounts').upsert({
        user_id: userId,
        stripe_subscription_id: sub.id,
        sub_status: sub.status,
        sub_quantity: qty,
        trial_started_at: new Date(nowMs).toISOString(),
        trial_ends_at: new Date(trialEndSec * 1000).toISOString()
      }, { onConflict: 'user_id' })
      return { created: true, qty, subscription: sub.id }
    }

    // Abonnement existant : alignement de la quantite sur le nombre de biens actifs.
    const sub = await stripe.subscriptions.retrieve(acct.stripe_subscription_id)
    // ⚠ UN ABONNEMENT TERMINE NE SE MODIFIE PLUS chez Stripe : on le DIT au lieu
    // d'echouer sur l'update (constat 1 de la revue de 9fc95ec9). Le recreer — et
    // avec quel essai — est une decision produit, posee a Thierry.
    if (sub.status === 'canceled') {
      console.error('[billing] abonnement termine, rien ne peut etre aligne', userId)
      return { qty, error: 'abonnement_termine' }
    }
    const item = sub.items.data[0]
    const currentQty = item?.quantity || 0
    // ⚠ UN ARRET PROGRAMME SE LEVE DES QU'UN BIEN EST DE NOUVEAU FACTURABLE — constat 1
    // (argent) de la revue de 9fc95ec9. Archiver le dernier bien pose
    // `cancel_at_period_end` SANS toucher a la quantite ; un nouveau bien active ensuite
    // rendait `qty === currentQty`, donc « inchange », et l'abonnement s'arretait quand
    // meme en fin de periode, avec un bien actif.
    const leverArret = sub.cancel_at_period_end === true
    if (qty === currentQty && !leverArret) return { qty, unchanged: true }

    const increasing = qty > currentQty
    const maj = {}
    if (qty !== currentQty) {
      maj.items = [{ id: item.id, quantity: qty }]
      // Ajout -> prorata natif immediat. Retrait -> 'none' : pas de remboursement,
      // le nouveau tarif s'applique au prochain cycle (mois entame du).
      maj.proration_behavior = increasing ? 'create_prorations' : 'none'
    }
    if (leverArret) maj.cancel_at_period_end = false
    await stripe.subscriptions.update(acct.stripe_subscription_id, maj)
    await supabase.from('accounts').update({ sub_quantity: qty }).eq('user_id', userId)
    return {
      qty, updated: true,
      direction: qty === currentQty ? 'same' : (increasing ? 'up' : 'down'),
      ...(leverArret ? { arret_leve: true } : {})
    }
  } catch (err) {
    console.error('[billing] syncAccountBilling echec', userId, err.message)
    return { error: err.message }
  }
}

module.exports = {
  PROPERTY_LOOKUP_KEY,
  TRIAL_DAYS,
  countActiveProperties,
  syncAccountBilling
}
