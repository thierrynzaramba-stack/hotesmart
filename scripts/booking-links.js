// scripts/booking-links.js
// DOC : docs/kb/moteur-reservation.md §7
// Spec : docs/specs/spec-moteur-reservation.md §3 ter (ajouts 1, 2, 4)
//
// Les liens de reservation d'un bien : les lister, en creer, les revoquer.
// En attendant l'app de configuration (etape 3 bis), c'est l'outil de service.
//
// LECTURE SEULE PAR DEFAUT. Rien n'est ecrit sans `--ecrire`.
// Convention des outils de ce depot (scripts/reconcilier-stop-sell.js) :
// on regarde d'abord, on ecrit ensuite, jamais dans le meme geste.
//
// USAGE
//   node scripts/booking-links.js                          # etat de tous les biens
//   node scripts/booking-links.js --bien="colomier"
//   node scripts/booking-links.js --bien="colomier" --creer --label="Site vitrine" --ecrire
//   node scripts/booking-links.js --bien="colomier" --creer --label="Gites" --coef=110 --ecrire
//   node scripts/booking-links.js --revoquer=<token> --ecrire

require('dotenv').config({ path: '.env.local', quiet: true })
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const { raisonNonVendable, multiplicateur } = require('../lib/moteur-reservation')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const arg = n => {
  const p = process.argv.find(a => a.startsWith(`--${n}=`))
  return p ? p.slice(n.length + 3) : null
}
const BIEN = arg('bien')
const LABEL = arg('label')
const COEF = arg('coef')
const REVOQUER = arg('revoquer')
const CREER = process.argv.includes('--creer')
const ECRIRE = process.argv.includes('--ecrire')
const BASE = process.env.APP_URL || 'https://hotesmart.vercel.app'

// Meme recette que api/membres.js:31 — 32 octets, base64url, 43 caracteres.
const nouveauJeton = () => crypto.randomBytes(32).toString('base64url')

// Le jeton n'est affiche EN ENTIER que dans le lien qu'on vient de creer.
// Ailleurs, 8 caracteres suffisent a l'identifier — un jeton complet dans un
// journal de terminal est un lien de reservation qui fuite.
const empreinte = j => (j ? `${j.slice(0, 8)}…` : '—')

const RAISONS = {
  bien_inconnu: 'bien introuvable',
  sans_lien_provider: 'aucun provider_property_id — le calendrier ne verrait AUCUNE reservation',
  sans_prix_de_base: 'aucun base_price — non reservable (decision 1)'
}

async function trouverBiens () {
  const { data, error } = await supabase
    .from('properties')
    .select('id, name, provider, provider_property_id, base_price, currency, capacity')
    .order('name')
  if (error) throw new Error(`lecture properties : ${error.message}`)
  return data
}

async function main () {
  // ─── Revocation ────────────────────────────────────────────────────────────
  // Ciblee par jeton, JAMAIS en masse. Le constat de review sur la version
  // precedente : `--regenerer` sans `--bien` revoquait les liens de TOUS les
  // biens d'un coup — une frappe oubliee cassait tous les liens colles sur les
  // sites des hotes. Ici il n'existe simplement aucune forme non ciblee.
  if (REVOQUER) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(REVOQUER)) {
      console.log('Jeton de mauvaise forme : 43 caracteres base64url attendus.')
      return
    }
    const { data: lien, error } = await supabase
      .from('booking_links')
      .select('id, label, active, property_id')
      .eq('token', REVOQUER)
      .maybeSingle()
    if (error) throw new Error(`lecture booking_links : ${error.message}`)
    if (!lien) { console.log('Aucun lien ne porte ce jeton.'); return }

    console.log(`\nLien « ${lien.label || '(sans etiquette)'} » — actif : ${lien.active}`)
    if (!ECRIRE) { console.log('ACTION : revoquer — relancer avec --ecrire\n'); return }
    // On DESACTIVE, on ne supprime pas : la provenance des reservations deja
    // creees par ce lien doit rester lisible (ajout 4).
    const { error: e } = await supabase.from('booking_links').update({ active: false }).eq('id', lien.id)
    if (e) throw new Error(`revocation : ${e.message}`)
    console.log('REVOQUE — la page publique de ce lien repond desormais 404.\n')
    return
  }

  const biens = await trouverBiens()
  const cibles = BIEN ? biens.filter(b => b.name.toLowerCase().includes(BIEN.toLowerCase())) : biens

  if (!cibles.length) {
    console.log(`Aucun bien ne correspond a "${BIEN}".`)
    console.log('Biens connus :', biens.map(b => b.name).join(' | '))
    return
  }

  // ─── Creation ──────────────────────────────────────────────────────────────
  // EXIGE `--bien`, et exige qu'il designe UN SEUL bien. Creer un lien sur tout
  // le parc parce qu'on a oublie un filtre n'est pas un accident acceptable.
  if (CREER) {
    if (!BIEN) { console.log('--creer exige --bien="<nom>" : jamais de creation en masse.'); return }
    if (cibles.length > 1) {
      console.log(`"${BIEN}" designe ${cibles.length} biens : ${cibles.map(b => b.name).join(' | ')}`)
      console.log('Preciser jusqu a n en designer qu un seul.')
      return
    }
    const bien = cibles[0]
    const blocage = raisonNonVendable(bien)
    if (blocage) {
      console.log(`\n${bien.name} : ${RAISONS[blocage] || blocage}.`)
      console.log('Le lien serait cree mais la page publique repondrait « ferme ».')
    }
    const coef = COEF == null ? 100 : Number(COEF)
    if (!Number.isFinite(coef) || coef <= 0 || coef > 1000) {
      console.log(`Coefficient invalide : "${COEF}". Attendu : un pourcentage dans ]0, 1000].`)
      return
    }
    console.log(`\n── ${bien.name}`)
    console.log(`   etiquette   : ${LABEL || '(aucune)'}`)
    console.log(`   coefficient : ${coef} %  ->  x${multiplicateur(coef)}`)
    if (!ECRIRE) { console.log('   ACTION      : creer — relancer avec --ecrire\n'); return }

    const token = nouveauJeton()
    const { error } = await supabase.from('booking_links').insert({
      property_id: bien.id, token, label: LABEL || '', price_coefficient: coef, active: true
    })
    if (error) throw new Error(`creation : ${error.message}`)
    console.log('   CREE')
    console.log(`   lien        : ${BASE}/book/${token}\n`)
    return
  }

  // ─── Etat ──────────────────────────────────────────────────────────────────
  console.log('\nMode : LECTURE SEULE — aucune ecriture\n')
  const { data: liens, error } = await supabase
    .from('booking_links')
    .select('id, property_id, token, label, price_coefficient, active, created_at')
    .order('created_at')
  if (error) throw new Error(`lecture booking_links : ${error.message}`)

  for (const b of cibles) {
    const blocage = raisonNonVendable(b)
    const siens = (liens || []).filter(l => l.property_id === b.id)
    console.log(`── ${b.name} (${b.provider})`)
    console.log(`   prix de base : ${b.base_price == null ? 'AUCUN' : b.base_price + ' ' + (b.currency || 'EUR')}`)
    console.log(`   vendable     : ${blocage ? 'NON — ' + (RAISONS[blocage] || blocage) : 'oui'}`)
    if (!siens.length) { console.log('   liens        : aucun — pas de page publique\n'); continue }
    for (const l of siens) {
      console.log(`   ${l.active ? '●' : '○'} ${empreinte(l.token)}  ${String(l.price_coefficient).padStart(4)} %  ${l.label || '(sans etiquette)'}${l.active ? '' : '  [REVOQUE]'}`)
    }
    console.log('')
  }
  console.log('Le lien complet ne s affiche qu a la creation (--creer --ecrire).\n')
}

main().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
