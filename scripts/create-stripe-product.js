// scripts/create-stripe-product.js
// Cree le produit unique + le prix graduated 3 paliers pour l'abonnement par bien.
// A lancer UNE SEULE FOIS, en mode TEST :
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/create-stripe-product.js
//
// Paliers (graduated = tarif par PALIER, applique au nombre de biens) :
//   biens 1 a 2   : 19,00 EUR / bien / mois
//   biens 3 a 9   : 15,00 EUR / bien / mois
//   biens 10 et + : 10,00 EUR / bien / mois
// => hypothese : montants PAR BIEN (a confirmer). Ajuster unit_amount si besoin.
//
// Idempotence : relancer creerait un doublon. Verifier avant via `stripe prices list`.

const Stripe = require('stripe')
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-07-30.basil' })

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY manquant')

  const existing = await stripe.prices.list({ lookup_keys: ['hotesmart_property'], active: true })
  if (existing.data.length) {
    console.log('Prix hotesmart_property existe deja :', existing.data[0].id, '- rien a faire.')
    return
  }

  const product = await stripe.products.create({
    name: 'HôteSmart — Abonnement par bien',
    metadata: { hotesmart: 'property_subscription' }
  })

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'eur',
    recurring: { interval: 'month' },
    billing_scheme: 'tiered',
    tiers_mode: 'graduated',
    lookup_key: 'hotesmart_property',
    tiers: [
      { up_to: 2,     unit_amount: 1900 },
      { up_to: 9,     unit_amount: 1500 },
      { up_to: 'inf', unit_amount: 1000 }
    ]
  })

  console.log('OK')
  console.log('  product :', product.id)
  console.log('  price   :', price.id)
  console.log('  lookup  : hotesmart_property')
}

main().catch(e => { console.error('ECHEC:', e.message); process.exit(1) })
