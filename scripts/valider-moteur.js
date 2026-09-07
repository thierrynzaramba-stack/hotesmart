// scripts/valider-moteur.js
// DOC : docs/kb/moteur-reservation.md — Spec : §6.7 et §7 (etape 4)
//
// VALIDATION DU MOTEUR EN CONDITIONS REELLES.
// Deroule les chemins que la spec exige d'eprouver « un par un », contre le
// deploiement de production, en mode test Stripe.
//
// ⚠ DEUX MODES, et le defaut n'ecrit RIEN.
//   sans option : lectures seules — calendrier, devis, confirmations, jetons.
//   --paiement  : ajoute les chemins qui CREENT des tentatives et des Checkout
//                 Sessions chez l'hote, et qui TIENNENT des nuits 45 minutes.
//
// ⚠ CE SCRIPT NE PEUT PAS TOUT FAIRE. Payer exige un navigateur et une carte de
// test ; recevoir un webhook exige que Stripe le signe. Ces deux-la sont des
// gestes humains, listes a la fin.
//
// USAGE : node scripts/valider-moteur.js [--bien=colomier] [--paiement]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = (process.env.APP_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')
const arg = n => { const p = process.argv.find(a => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : null }
const BIEN = arg('bien') || 'colomier'
const PAIEMENT = process.argv.includes('--paiement')

let ok = 0, ko = 0
function verdict (nom, reussi, detail) {
  if (reussi) { ok++; console.log(`  \x1b[32m✓\x1b[0m ${nom}${detail ? ' — ' + detail : ''}`) }
  else { ko++; console.log(`  \x1b[31m✗\x1b[0m ${nom}${detail ? ' — ' + detail : ''}`) }
}

// ⚠ UN ALEA RESEAU N'EST PAS UN ECHEC DE VALIDATION. Constate : une coupure
// transitoire faisait tomber tout le deroule au milieu, et on ne savait plus ce
// qui avait ete verifie. On retente les LECTURES ; les POST, jamais — rejouer un
// POST de paiement creerait une seconde tentative.
async function appel (chemin, options, essai = 0) {
  try {
    const r = await fetch(`${BASE}${chemin}`, options)
    let j = null
    try { j = await r.json() } catch (e) { /* corps non JSON */ }
    return { status: r.status, json: j }
  } catch (e) {
    const lecture = !options || !options.method || options.method === 'GET'
    if (lecture && essai < 3) {
      await new Promise(r => setTimeout(r, 1000 * (essai + 1)))
      return appel(chemin, options, essai + 1)
    }
    return { status: 0, json: null, erreur: e.message }
  }
}

const jour = n => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// Dates explicites : la validation reelle porte sur des nuits que l'hote a
// ouvertes lui-meme, pas sur une fenetre relative choisie par l'outil.
const ARRIVEE = arg('arrivee')
const DEPART = arg('depart')

;(async () => {
  const { data: biens } = await supabase.from('properties')
    .select('id, name, base_price, currency, capacity, user_id, provider_property_id')
  const bien = biens.find(b => b.name.toLowerCase() === BIEN.toLowerCase())
    || biens.find(b => b.name.toLowerCase().includes(BIEN.toLowerCase()))
  if (!bien) { console.log(`Bien « ${BIEN} » introuvable.`); process.exit(1) }

  const { data: liens } = await supabase.from('booking_links')
    .select('token, label, price_coefficient, active').eq('property_id', bien.id).eq('active', true)
  if (!liens || !liens.length) { console.log(`Aucun lien actif sur « ${bien.name} ».`); process.exit(1) }
  const jeton = liens[0].token

  // ⚠ LE COMPTE STRIPE EST CELUI DE L'HOTE DU BIEN, pas « le » compte.
  // Constate a la validation : le bien de test appartient a un AUTRE compte que
  // celui qui a connecte Stripe, et le moteur refusait — a juste titre. Sans ce
  // controle en tete, l'outil affichait deux echecs trompeurs au lieu de dire
  // la seule chose utile.
  const { data: compte } = await supabase.from('stripe_accounts')
    .select('mode, key_last4, webhook_endpoint_id, webhook_secret_cipher')
    .eq('user_id', bien.user_id).maybeSingle()

  console.log(`\nBien   : ${bien.name} (${bien.base_price} ${bien.currency}, ${bien.capacity} pers.)`)
  console.log(`Hote   : ${bien.user_id.slice(0, 8)}… — Stripe ${compte ? `connecte (${compte.mode}, ****${compte.key_last4}, webhook ${compte.webhook_endpoint_id ? 'auto' : (compte.webhook_secret_cipher ? 'manuel' : 'MANQUANT')})` : '\x1b[31mNON CONNECTE\x1b[0m'}`)
  console.log(`Lien   : ${liens[0].label} — ${liens[0].price_coefficient} %`)
  console.log(`Cible  : ${BASE}`)
  console.log(`Mode   : ${PAIEMENT ? 'AVEC paiement (cree des tentatives et tient des nuits)' : 'LECTURE SEULE'}\n`)

  // ─── Lectures ──────────────────────────────────────────────────────────────
  console.log('── Le calendrier public')
  const cal = await appel(`/api/book-public?token=${jeton}`)
  verdict('la page repond', cal.status === 200, `HTTP ${cal.status}`)
  verdict('le bien est ouvert', cal.json && cal.json.ouvert === true)
  verdict('la politique d\'annulation est exposee AVANT le paiement',
    !!(cal.json && cal.json.bien && cal.json.bien.politique_annulation),
    cal.json && cal.json.bien && cal.json.bien.politique_annulation)
  const dispo = (cal.json && cal.json.nuits || []).filter(n => n.disponible)
  verdict('des nuits sont vendables', dispo.length > 0, `${dispo.length} nuits`)
  const brut = JSON.stringify(cal.json || {})
  verdict('aucun champ interne ne fuit',
    !/user_id|provider_property_id|price_coefficient|secret/.test(brut))
  verdict('aucune nuit ne dit POURQUOI elle est indisponible',
    !(cal.json && (cal.json.nuits || []).some(n => n.raison !== undefined)))

  console.log('\n── Les jetons')
  verdict('jeton inconnu -> 404', (await appel(`/api/book-public?token=${'b'.repeat(43)}`)).status === 404)
  verdict('jeton malforme -> 404', (await appel('/api/book-public?token=court')).status === 404)
  verdict('webhook, jeton inconnu -> 404',
    (await appel(`/api/book-webhook/${'a'.repeat(43)}`, { method: 'POST' })).status === 404)

  console.log('\n── La confirmation')
  verdict('uuid inexistant -> 404',
    (await appel(`/api/book-public?token=${jeton}&action=confirmation&t=11112222-3333-4444-5555-666677778888`)).status === 404)
  verdict('identifiant malforme -> 404',
    (await appel(`/api/book-public?token=${jeton}&action=confirmation&t=abc`)).status === 404)

  console.log('\n── Le devis (le montant a une seule source)')
  const a = ARRIVEE || jour(20), d3 = DEPART || jour(23)
  const devis = await appel(`/api/book-public?token=${jeton}&action=devis&arrivee=${a}&depart=${d3}&personnes=2`)
  // ⚠ Le total attendu se calcule sur les prix REELLEMENT rendus par le
  // calendrier, pas sur `base_price` : une exception de prix posee par l'hote
  // prime (decision 1), et l'outil doit valider ce que le voyageur voit.
  const parDate = {}
  for (const n of (cal.json && cal.json.nuits) || []) parDate[n.date] = n
  const nuitsDuSejour = []
  for (let x = new Date(a + 'T00:00:00Z'); x < new Date(d3 + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1)) {
    nuitsDuSejour.push(x.toISOString().slice(0, 10))
  }
  const attendu = Math.round(nuitsDuSejour.reduce((t, j) => t + ((parDate[j] && parDate[j].prix) || 0), 0) * 100) / 100
  verdict(`${nuitsDuSejour.length} nuits sont devisees`, devis.json && devis.json.ok === true && devis.json.nuits === nuitsDuSejour.length,
    devis.json && devis.json.raison)
  verdict('le total = somme des prix affiches (exceptions comprises)',
    devis.json && devis.json.total === attendu, `${devis.json && devis.json.total} attendu ${attendu}`)
  const trop = await appel(`/api/book-public?token=${jeton}&action=devis&arrivee=${a}&depart=${d3}&personnes=${bien.capacity + 1}`)
  verdict('au-dela de la capacite -> refus', trop.json && trop.json.raison === 'trop_de_voyageurs')
  const inv = await appel(`/api/book-public?token=${jeton}&action=devis&arrivee=${d3}&depart=${a}&personnes=2`)
  verdict('dates inversees -> refus', inv.json && inv.json.ok === false)

  // ─── Paiement ──────────────────────────────────────────────────────────────
  console.log('\n── Le paiement')
  const corps = v => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: jeton, arrivee: a, depart: d3, personnes: 2, lang: 'fr',
      prenom: 'Test', nom: 'Validation', email: 'validation@exemple.test', tel: '0600000000', ...v })
  })

  // ⚠ LE MODE LECTURE SEULE NE POSTE PLUS. Defaut de cet outil, constate en
  // validation : il postait sur /api/book-pay « pour verifier que la garde est
  // fermee ». Une fois la garde OUVERTE, ce test creait une vraie tentative,
  // une vraie Checkout Session et tenait trois nuits 45 minutes — dans le mode
  // qui promet de ne rien ecrire. Un outil de verification qui ecrit sans le
  // dire est pire qu'un outil absent.
  // L'etat de la garde se lit desormais SANS effet de bord.
  if (PAIEMENT && !compte) {
    console.log('  \x1b[33m•\x1b[0m l\'hote de ce bien n\'a AUCUN compte Stripe connecte : le moteur refuse')
    console.log('    de vendre pour lui, et c\'est le comportement voulu. Choisissez un bien')
    console.log('    dont le proprietaire a connecte sa cle, ou connectez-la pour celui-ci.')
  } else if (!PAIEMENT) {
    // Sonde SANS effet de bord : un corps vide echoue sur le jeton manquant bien
    // avant d'atteindre la moindre ecriture. `paiement_indisponible` dit que la
    // garde est fermee ; toute autre reponse dit qu'elle est ouverte.
    const g = await appel('/api/book-pay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })
    // ⚠ TROIS ISSUES, PAS DEUX. Constat de review : `appel()` ne rejoue jamais un
    // POST, donc un alea reseau rend `{status:0}` — et l'outil annoncait « garde
    // OUVERTE ». Un 500 ou une page HTML donnaient le meme verdict. Ne pas
    // savoir n'est pas savoir.
    if (!g.status) {
      console.log(`  \x1b[33m•\x1b[0m etat de la garde INDETERMINE (${g.erreur || 'pas de reponse'}).`)
    } else if (g.json && g.json.error === 'paiement_indisponible') {
      console.log('  \x1b[33m•\x1b[0m garde FERMEE (BOOKING_ENGINE_PAYMENT ≠ true).')
    } else if (g.json && g.json.error) {
      console.log('  \x1b[33m•\x1b[0m garde OUVERTE (BOOKING_ENGINE_PAYMENT = true) — relancer')
      console.log('    avec --paiement pour les chemins d\'encaissement.')
    } else {
      console.log(`  \x1b[33m•\x1b[0m reponse inattendue (HTTP ${g.status}) : etat INDETERMINE.`)
    }
  } else {
    // ⚠ Le serveur verifie la CONFIGURATION DE PAIEMENT avant les coordonnees du
    // voyageur, et c'est le bon ordre : si l'hote n'a pas de compte, corriger sa
    // faute de frappe ne servirait a rien — autant le dire tout de suite.
    const mauvais = await appel('/api/book-pay', corps({ email: 'pas-un-email' }))
    verdict('e-mail invalide -> refus AVANT encaissement', mauvais.status === 400,
      mauvais.json && (mauvais.json.raison || mauvais.json.error))
    const capa = await appel('/api/book-pay', corps({ personnes: bien.capacity + 1 }))
    verdict('capacite depassee -> refus AVANT encaissement', capa.status === 409 || capa.status === 400)

    const s1 = await appel('/api/book-pay', corps({}))
    verdict('une Session est creee', s1.status === 200 && !!(s1.json && s1.json.url),
      s1.json && (s1.json.url ? s1.json.url.slice(0, 42) + '…' : JSON.stringify(s1.json)))
    if (s1.json && s1.json.url) {
      const s2 = await appel('/api/book-pay', corps({}))
      verdict('IDEMPOTENCE : la seconde soumission rend LA MEME Session',
        s2.json && s2.json.url === s1.json.url)
      const chevA = nuitsDuSejour[1] || jour(21)
    const chevD = nuitsDuSejour[2] || jour(22)
    const conc = await appel('/api/book-pay', corps({ arrivee: chevA, depart: chevD }))
      verdict('dates chevauchantes -> refus AVANT encaissement',
        conc.status === 409, conc.json && (conc.json.raison || conc.json.error))
      console.log(`\n  \x1b[36mURL DE PAIEMENT\x1b[0m (carte de test 4242 4242 4242 4242) :`)
      console.log(`  ${s1.json.url}\n`)
    }
  }

  console.log(`\n${ok} verifications passees, ${ko} en echec.\n`)
  process.exit(ko ? 1 : 0)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
