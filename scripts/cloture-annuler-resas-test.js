// scripts/cloture-annuler-resas-test.js
// Cloture du chantier « canal e-mail pour les reservations directes ».
//
// ANNULE LES RESERVATIONS DE TEST OFFLINE DE COLOMIERS.
//
// USAGE
//   node scripts/cloture-annuler-resas-test.js [--execute]
//     par defaut : DRY RUN (n'annule rien)
//
// ⚠ IL PASSE PAR L'ENDPOINT, PAS PAR CHANNEX EN DIRECT.
// `api/reservation-directe.js` (DELETE) porte le calcul des `days` — Channex
// revalide TOUT le payload a chaque ecriture et rejette une annulation
// partielle, avec un reliquat a poser sur la derniere nuit pour que la somme
// tombe juste au centime. Reconstruire ce payload ici, c'est se preparer un 422
// et surtout DEUX implementations d'une meme regle. On s'authentifie donc comme
// l'hote et on appelle le chemin reel, avec toutes ses gardes.
//
// ⚠ IL NE TOUCHE QUE CE QU'IL A IDENTIFIE COMME UN TEST, et il le montre avant.
// Colomiers est un bien REEL : une vraie reservation directe d'un vrai voyageur
// y est possible. Le script liste, on lit, puis on execute.
//
// ⚠ ET IL PEUT NE PAS AVOIR LE DROIT — c'est arrive, et c'est une BONNE
// nouvelle. `TEST_EMAIL` est un membre DELEGUE du compte qui possede Colomiers
// (`is_owner: false`), pas son proprietaire : l'endpoint a rendu 403 « Droits
// insuffisants » sur les quatre annulations. La garde de `requirePermission`
// fait exactement ce pour quoi elle a ete ecrite.
//
// On ne la contourne pas. Ni en donnant le droit au compte de test « juste pour
// ce script », ni en repassant par la service key et `cancelBooking` en direct :
// les deux reviendraient a desarmer, pour une commodite, ce que le chantier
// « profils et droits » a mis dix etapes a poser. Le script DIT alors quoi faire
// a la main — quatre clics dans la fiche du calendrier, par le proprietaire.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')

const BASE = process.env.HOTESMART_URL || 'https://hotesmart.vercel.app'
const COLOMIERS = '0544fd9a-6579-44e7-b75e-19c63a2019ba'

// Les adresses du product owner : c'est ce qui distingue un test d'une vente.
// ⚠ CETTE LISTE NE SE DEVINE PAS, ELLE SE DECLARE. Le script a refuse de
// toucher une reservation portant `thierry.nzaramba@spltmie.fr` — inconnue de
// la liste — alors que c'etait bien un essai. Il a eu RAISON : Colomiers est un
// bien reel, et « ca ressemble a une adresse du proprietaire » n'est pas une
// preuve. L'adresse est ajoutee ici parce que Thierry l'a nommee, pas parce que
// le script l'a deduite.
const ADRESSES_DE_TEST = [/@exemple\.test$/i, /^thierrynzaramba@gmail\.com$/i,
                          /^nzaramba/i, /^coeurdevie65@/i,
                          /^thierry\.nzaramba@spltmie\.fr$/i]

const masque = e => { const s = String(e || ''); const i = s.indexOf('@')
  return i < 1 ? '(aucune)' : s.slice(0, 2) + '***@' + s.slice(i + 1) }
const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

async function jeton () {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const { data, error } = await anon.auth.signInWithPassword({
    email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD
  })
  if (error) throw new Error(`authentification impossible : ${error.message}`)
  return { token: data.session.access_token, userId: data.user.id }
}

async function main () {
  log(EXECUTE ? '*** MODE ANNULATION REELLE ***' : 'DRY RUN — rien n\'est annule')
  console.log('')

  const { data: rows, error } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, property_id, user_id, snapshot')
    .eq('property_id', COLOMIERS)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) throw new Error(`lecture : ${error.message}`)

  const offline = (rows || []).filter(r =>
    String(r.snapshot?.source || '').trim().toLowerCase() === 'offline')

  const actives = offline.filter(r => r.snapshot.status === 'confirmed')
  const deja = offline.filter(r => r.snapshot.status !== 'confirmed')

  console.log(`Reservations Offline sur Colomiers : ${offline.length}`)
  console.log(`  deja annulees : ${deja.length}`)
  console.log(`  actives       : ${actives.length}`)
  console.log('')

  const aAnnuler = []
  for (const r of actives) {
    const s = r.snapshot
    const estTest = ADRESSES_DE_TEST.some(re => re.test(String(s.guestEmail || '')))
    const etiquette = estTest ? 'TEST' : '⚠ PAS RECONNUE COMME UN TEST'
    console.log(`  ${r.booking_id}`)
    console.log(`    ${s.arrival} -> ${s.departure} | ${[s.firstName, s.lastName].filter(Boolean).join(' ')}`)
    console.log(`    ${masque(s.guestEmail)} | ${s.amount ?? '—'} ${s.currency || ''} | ${etiquette}`)
    console.log('')
    if (estTest) aAnnuler.push(r)
  }

  const nonReconnues = actives.length - aAnnuler.length
  if (nonReconnues) {
    log(`⚠ ${nonReconnues} reservation(s) NON reconnue(s) comme test : elles ne seront PAS touchees.`)
    log('  Si l\'une d\'elles doit l\'etre, annulez-la depuis la fiche du calendrier.')
    console.log('')
  }

  log(`${aAnnuler.length} reservation(s) a annuler`)
  if (!EXECUTE) {
    console.log('')
    log('DRY RUN termine. LIRE la liste ci-dessus, puis --execute.')
    return
  }
  if (!aAnnuler.length) return

  const { token, userId } = await jeton()

  // ⚠ ON VERIFIE LE DROIT AVANT, pour dire pourquoi plutot que d'echouer quatre
  // fois de suite avec un « 403 » que personne n'interprete.
  const { data: profil } = await supabase.from('profiles')
    .select('is_owner').eq('member_user_id', userId)
    .eq('account_user_id', aAnnuler[0].user_id).maybeSingle()
  if (!profil || profil.is_owner !== true) {
    console.log('')
    log(`⚠ LE COMPTE ${userId.slice(0, 8)} N'EST PAS PROPRIETAIRE de ces biens.`)
    log('  L\'endpoint refusera (403 « Droits insuffisants »), et il a raison :')
    log('  annuler une reservation demande le droit `reservations:write`.')
    console.log('')
    log('  A FAIRE A LA MAIN, par le proprietaire, depuis /biens-calendrier :')
    for (const r of aAnnuler) {
      log(`    ${r.snapshot.arrival} -> ${r.snapshot.departure}  (${r.booking_id.slice(0, 8)})`)
    }
    log('  ouvrir la bulle, « Annuler la réservation », confirmer.')
    process.exitCode = 1
    return
  }

  console.log('')
  let ok = 0
  for (const r of aAnnuler) {
    const res = await fetch(`${BASE}/api/reservation-directe`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ propertyId: r.property_id, bookingId: r.booking_id })
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok && j.ok) { ok++; log(`annulee : ${r.booking_id.slice(0, 8)}`) }
    else log(`⚠ ECHEC ${r.booking_id.slice(0, 8)} : HTTP ${res.status} ${j.message || j.error || ''}`)
  }

  console.log('')
  log(`${ok} / ${aAnnuler.length} annulation(s) transmise(s) au canal`)
  log('Les dates se rouvrent au prochain passage du feed (5 min).')
  log('Relancer ce script ensuite : les annulees doivent avoir bascule.')
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
