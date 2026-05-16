// api/stripe.js — Endpoint unifié Stripe : Checkout, Portal, Cancel, Webhook
// Route via ?action=... pour les calls user, ou via stripe-signature header pour le webhook.

const { createClient } = require('@supabase/supabase-js')
const Stripe = require('stripe')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-07-30.basil'
})

// ─── Désactiver le body parser auto pour permettre la vérification de signature webhook ───
// Sur Vercel, on lit le raw body manuellement.
module.exports.config = {
  api: { bodyParser: false }
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ─── Lookup keys → Price IDs Stripe (mode test) ────────────────────────────
// IMPORTANT : on stocke uniquement les lookup_keys ici, les vrais price_id sont
// résolus à la volée via stripe.prices.list({ lookup_keys: [...] }).
// Avantage : si tu régénères les prices, pas besoin de modifier le code.
const MODULE_PRICES = {
  guestflow: ['guestflow_base', 'guestflow_extra_property'],
  menage:    ['menage_per_property'],
  serrure:   ['serrure_pack_5', 'serrure_extra'],
  caution:   ['caution_per_property']
}

const TRIAL_DAYS = {
  guestflow: 15,
  menage: 15,
  serrure: 15,
  caution: 15
}

const APP_URL = process.env.APP_URL || 'https://hotesmart.vercel.app'

// ─── Helper : récupérer prices Stripe à partir des lookup_keys ─────────────
async function resolvePrices(lookupKeys) {
  const { data: prices } = await stripe.prices.list({
    lookup_keys: lookupKeys,
    active: true,
    limit: 10
  })
  const byKey = {}
  prices.forEach(p => { byKey[p.lookup_key] = p.id })
  return byKey
}

// ─── Helper : construire les line_items selon module + quantity ────────────
async function buildLineItems(module, quantity) {
  const qty = Math.max(1, Math.min(50, Number(quantity) || 1))
  const lookupKeys = MODULE_PRICES[module]
  if (!lookupKeys) throw new Error('Module inconnu: ' + module)
  const prices = await resolvePrices(lookupKeys)

  if (module === 'guestflow') {
    const items = [{ price: prices.guestflow_base, quantity: 1 }]
    if (qty > 1) {
      items.push({ price: prices.guestflow_extra_property, quantity: qty - 1 })
    }
    return items
  }
  if (module === 'menage') {
    return [{ price: prices.menage_per_property, quantity: qty }]
  }
  if (module === 'serrure') {
    const items = [{ price: prices.serrure_pack_5, quantity: 1 }]
    if (qty > 5) {
      items.push({ price: prices.serrure_extra, quantity: qty - 5 })
    }
    return items
  }
  if (module === 'caution') {
    return [{ price: prices.caution_per_property, quantity: qty }]
  }
  throw new Error('Module non géré: ' + module)
}

// ─── Helper : récupérer le stripe_customer_id existant pour l'user, sinon en créer un ───
async function getOrCreateCustomer(userId, userEmail) {
  // Cherche dans subscriptions existantes
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .not('stripe_customer_id', 'is', null)
    .limit(1)
    .maybeSingle()
  if (existing?.stripe_customer_id) return existing.stripe_customer_id

  // Sinon, créer un customer Stripe
  const customer = await stripe.customers.create({
    email: userEmail,
    metadata: { hotesmart_user_id: userId }
  })
  return customer.id
}

// ─── Handler webhook ────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET manquant')
    return res.status(500).json({ error: 'Webhook secret non configuré' })
  }

  const rawBody = await getRawBody(req)
  let event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch (err) {
    console.error('[stripe] webhook signature invalide:', err.message)
    return res.status(400).json({ error: 'Signature invalide' })
  }

  console.log('[stripe] webhook reçu:', event.type)

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.metadata?.hotesmart_user_id
        const module = session.metadata?.hotesmart_module
        if (!userId || !module) {
          console.error('[stripe] metadata manquante sur checkout.session.completed')
          break
        }
        if (session.subscription) {
          // Récup détails sub depuis Stripe pour avoir trial_end, current_period_end, etc.
          const sub = await stripe.subscriptions.retrieve(session.subscription)
          await upsertSubscription(userId, module, sub, session.customer)
        }
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object
        const userId = sub.metadata?.hotesmart_user_id
        const module = sub.metadata?.hotesmart_module
        if (!userId || !module) {
          // Tentative de fallback : retrouver via stripe_subscription_id
          const { data: existing } = await supabase
            .from('subscriptions')
            .select('user_id, module')
            .eq('stripe_subscription_id', sub.id)
            .maybeSingle()
          if (existing) {
            await upsertSubscription(existing.user_id, existing.module, sub, sub.customer)
          } else {
            console.warn('[stripe] subscription sans metadata + introuvable en base:', sub.id)
          }
          break
        }
        await upsertSubscription(userId, module, sub, sub.customer)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        await supabase
          .from('subscriptions')
          .update({ status: 'canceled', cancel_at_period_end: false })
          .eq('stripe_subscription_id', sub.id)
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'active' })
            .eq('stripe_subscription_id', invoice.subscription)
            .in('status', ['trialing', 'past_due', 'incomplete', 'unpaid'])
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription)
        }
        break
      }

      default:
        // Événement non géré, on accuse réception sans rien faire
        break
    }
  } catch (err) {
    console.error('[stripe] erreur traitement event ' + event.type + ':', err)
    // On répond 200 quand même pour que Stripe n'essaye pas en boucle
  }

  return res.json({ received: true })
}

async function upsertSubscription(userId, module, sub, customerId) {
  const row = {
    user_id: userId,
    module: module,
    status: sub.status,
    stripe_customer_id: typeof customerId === 'string' ? customerId : (customerId?.id || null),
    stripe_subscription_id: sub.id,
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    quantity: computeQuantity(module, sub),
    metadata: sub.metadata || {}
  }

  const { error } = await supabase
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id,module' })

  if (error) {
    console.error('[stripe] upsert subscription failed:', error)
    throw error
  }
}

// Reconstitue la "quantity" effective pour le module à partir des line items Stripe
function computeQuantity(module, sub) {
  if (!sub.items?.data?.length) return 1
  if (module === 'guestflow') {
    let total = 0
    for (const it of sub.items.data) {
      if (it.price?.lookup_key === 'guestflow_base') total += it.quantity || 0
      if (it.price?.lookup_key === 'guestflow_extra_property') total += it.quantity || 0
    }
    return total || 1
  }
  if (module === 'serrure') {
    let total = 0
    for (const it of sub.items.data) {
      if (it.price?.lookup_key === 'serrure_pack_5') total += it.quantity || 0
      if (it.price?.lookup_key === 'serrure_extra') total += it.quantity || 0
    }
    // serrure_pack_5 quantity=1 vaut "jusqu'à 5", on compte 5 minimum
    const hasPack = sub.items.data.some(it => it.price?.lookup_key === 'serrure_pack_5')
    if (hasPack) {
      const extra = sub.items.data.find(it => it.price?.lookup_key === 'serrure_extra')
      return 5 + (extra?.quantity || 0)
    }
    return total || 1
  }
  // menage et caution : quantity simple
  return sub.items.data[0]?.quantity || 1
}

// ─── Handler actions user (create_checkout, cancel_subscription, portal) ──
async function handleUserAction(req, res) {
  const userToken = req.headers.authorization?.replace('Bearer ', '')
  if (!userToken) return res.status(401).json({ error: 'Non autorisé' })

  const { data: userData } = await supabase.auth.getUser(userToken)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' })

  const rawBody = await getRawBody(req)
  let body = {}
  try { body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {} } catch (e) {}

  const action = (req.url || '').includes('action=') 
    ? new URL(req.url, 'http://localhost').searchParams.get('action')
    : body.action

  if (action === 'create_checkout') {
    return createCheckout(req, res, user, body)
  }
  if (action === 'cancel_subscription') {
    return cancelSubscription(req, res, user, body)
  }
  if (action === 'portal') {
    return createPortal(req, res, user)
  }

  return res.status(400).json({ error: 'Action inconnue' })
}

async function createCheckout(req, res, user, body) {
  const { module: mod, quantity } = body
  if (!MODULE_PRICES[mod]) {
    return res.status(400).json({ error: 'Module inconnu' })
  }
  const qty = Math.max(1, Math.min(50, Number(quantity) || 1))

  try {
    // 1. Refuser si l'user a déjà une sub active/trialing sur ce module
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', user.id)
      .eq('module', mod)
      .in('status', ['trialing', 'active', 'past_due'])
      .maybeSingle()
    if (existing) {
      return res.status(400).json({ error: 'Vous avez déjà une souscription active pour ce module.' })
    }

    // 2. Customer Stripe (récup ou création)
    const customerId = await getOrCreateCustomer(user.id, user.email)

    // 3. Line items
    const lineItems = await buildLineItems(mod, qty)

    // 4. Créer la Checkout Session avec trial
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      subscription_data: {
        trial_period_days: TRIAL_DAYS[mod] || 15,
        metadata: {
          hotesmart_user_id: user.id,
          hotesmart_module: mod
        }
      },
      payment_method_collection: 'always', // CB obligatoire dès le départ
      metadata: {
        hotesmart_user_id: user.id,
        hotesmart_module: mod
      },
      success_url: APP_URL + '/pages/abonnement.html?success=true&module=' + mod,
      cancel_url: APP_URL + '/pages/abonnement.html?canceled=true&module=' + mod,
      allow_promotion_codes: true,
      locale: 'fr'
    })

    return res.json({ url: session.url, id: session.id })
  } catch (err) {
    console.error('[stripe] create_checkout error:', err)
    return res.status(500).json({ error: err.message })
  }
}

async function cancelSubscription(req, res, user, body) {
  const { module: mod } = body
  if (!MODULE_PRICES[mod]) {
    return res.status(400).json({ error: 'Module inconnu' })
  }
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', user.id)
      .eq('module', mod)
      .maybeSingle()
    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ error: 'Aucune souscription active' })
    }
    // Annulation à fin de période (ne perd pas l'accès immédiatement)
    const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true
    })
    await supabase
      .from('subscriptions')
      .update({ cancel_at_period_end: true })
      .eq('stripe_subscription_id', sub.stripe_subscription_id)
    return res.json({ success: true, cancel_at: updated.cancel_at })
  } catch (err) {
    console.error('[stripe] cancel_subscription error:', err)
    return res.status(500).json({ error: err.message })
  }
}

async function createPortal(req, res, user) {
  try {
    const { data: anySub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .not('stripe_customer_id', 'is', null)
      .limit(1)
      .maybeSingle()
    if (!anySub?.stripe_customer_id) {
      return res.status(404).json({ error: 'Aucun compte de facturation trouvé' })
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: anySub.stripe_customer_id,
      return_url: APP_URL + '/pages/abonnement.html',
      locale: 'fr'
    })
    return res.json({ url: portal.url })
  } catch (err) {
    console.error('[stripe] portal error:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ─── Handler principal ────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, stripe-signature')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })

  // Si signature Stripe présente → webhook
  if (req.headers['stripe-signature']) {
    return handleWebhook(req, res)
  }
  // Sinon → action user authentifiée
  return handleUserAction(req, res)
}
