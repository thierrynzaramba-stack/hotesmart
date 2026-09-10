// scripts/pousser-grille-reelle.js
// Pousse vers Channex la grille REELLE du coeur, et FERME les dates sans prix.
//
// Decision de Thierry, 10 septembre 2026 : « pousse maintenant la grille reelle
// du coeur pour La bulle (les 17 nuits tarifees) [...] le reste ferme faute de
// prix ». Geste n°1, avant tout le reste.
//
// ⚠ POURQUOI CE GESTE EST URGENT, MESURE LE MEME JOUR.
// Channex detenait 120 € A PLAT sur les 500 jours (le prix de base de la fiche
// neuve), alors que le coeur porte la vraie grille importee de Beds24 : 99 €
// le 9/09, 160 € le 12 et le 17, 180 € les 18 et 19. Les canaux Booking sont
// passes ACTIFS d'eux-memes (Channex les active quand l'OTA confirme le
// mapping) : ces 120 € partaient donc chez l'OTA, ecrasant les nuits a 160 et
// 180 €.
//
// ⚠ LA FERMETURE VIENT DE L'HOTE, PAS D'UN CONTOURNEMENT — ET C'EST MIEUX.
// J'allais passer `base_price: null` en memoire pour que `runFullSync`, qui
// retombe sur le prix de base avant de conclure « pas de prix », ferme les
// dates non tarifees. Mesure faite avant d'ecrire : Thierry avait deja saisi
// dans le calendrier, a 17:15, **517 dates a `stop_sell = true`** et
// 36 dates tarifees (99 a 180 €). La fermeture est donc une INTENTION
// MEMORISEE dans `calendar_inventory`, pas un etat calcule.
//
// Consequence : on pousse les intentions de l'hote TELLES QU'ELLES SONT EN
// BASE — prix et `stop_sell` — et on ne neutralise `base_price` (en memoire,
// jamais en base) que pour les dates qu'il n'a NI tarifees NI fermees. Sans
// cette neutralisation, ces dates partiraient ouvertes au prix de base, soit
// l'ecrasement exact qu'on repare.
// ⚠ Cet en-tete affirmait « aucun contournement » : c'etait faux, et releve en
// review. La neutralisation en est un — borne, dit, et sans effet en base.
//
// Sur une date fermee, le `rate` pousse n'a aucun effet commercial : ce qui
// ferme est `stop_sell`. On le laisse partir tel quel plutot que de fabriquer
// un etat que l'hote n'a pas demande.
//
// ⚠ LES DATES NI TARIFEES NI FERMEES SONT NOMMEES AVANT TOUT ENVOI, puis
// fermees par la fermeture CALCULEE du writer. L'en-tete annoncait un REFUS :
// c'etait faux, releve en review — le script journalise et poursuit, ce qui est
// le comportement voulu (la regle de l'hote est « le reste ferme faute de
// prix », donc il n'y a rien a refuser). Le juge final reste la relecture
// `GET /restrictions` : une date ouverte sans prix y compte comme un ECART.
//
// Le mecanisme de fermeture est celui du 8 septembre, mesure en staging
// (docs/specs/protocole-staging-tarifs.md) : omettre `rate` NE FERME RIEN — la
// date reste vendable au prix par defaut de l'option du rate plan — et
// `rate: 0` n'est pas applique par Channex. Seul `stop_sell: true` ferme.
//
// DRY RUN par defaut. Relecture systematique apres ecriture.
// USAGE : node scripts/pousser-grille-reelle.js <la-bulle|coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { runFullSync } = require('../lib/channel-fullsync')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')

const CIBLES = {
  'la-bulle': { fiche: '091d9abf-ff86-45ce-8123-3425e6f3900f' },
  'coeur-23': { fiche: 'efe1daf1-652c-4177-b29b-19f1db377c96' }
}
const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/pousser-grille-reelle.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}

const get = async (chemin) => {
  const r = await fetch(`${BASE}${chemin}`, { headers: { 'user-api-key': KEY } })
  let j = null
  try { j = await r.json() } catch { j = null }
  return { code: r.status, json: j }
}

async function main () {
  const { data: bien, error } = await supabase.from('properties')
    .select('id, name, user_id, provider, provider_property_id, migration_target_property_id, provider_room_type_id, provider_rate_plan_id, inventory_units, capacity, included_guests, extra_guest_fee, base_price, currency, rate_sync_mode')
    .eq('id', CIBLES[CLE].fiche).single()
  if (error) throw new Error(error.message)

  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN'}  ${bien.name}`)
  console.log(`   provider=${bien.provider}  cle=${bien.provider_property_id}`)
  console.log(`   base_price en base = ${bien.base_price} € (NON modifie, ignore pour cette poussee)`)
  console.log(`   rate_sync_mode = ${bien.rate_sync_mode}`)

  // Tout le calendrier du coeur, pagine : une lecture tronquee ferait croire
  // qu'une date est sans intention alors qu'elle en porte une.
  const lignes = []
  let de = 0
  for (;;) {
    const { data, error: eCi } = await supabase.from('calendar_inventory')
      .select('date, rate, stop_sell').eq('property_id', bien.id).order('date').range(de, de + 499)
    if (eCi) throw new Error(`calendar_inventory : ${eCi.message}`)
    lignes.push(...(data || []))
    if (!data || data.length < 500) break
    de += 500
  }
  const attendus = new Map(lignes.filter(x => x.rate != null && Number(x.rate) > 0)
    .map(x => [x.date, Number(x.rate)]))
  const fermees = new Set(lignes.filter(x => x.stop_sell === true).map(x => x.date))
  console.log(`\n── le coeur : ${lignes.length} date(s) reglee(s)`)
  console.log(`   ${attendus.size} tarifee(s)  |  ${fermees.size} fermee(s) par l'hote (stop_sell)`)
  for (const [d, r] of attendus) console.log(`   ${d}  ${r} €`)

  // ⚠ LE CONTROLE QUI COMPTE, AVANT TOUT ENVOI.
  // Une date de la fenetre ni tarifee ni fermee partirait ouverte, et se
  // vendrait au prix par defaut de l'option du rate plan.
  const auj = new Date()
  const horizon = []
  for (let i = 0; i < 500; i++) {
    horizon.push(new Date(auj.getTime() + i * 86400000).toISOString().slice(0, 10))
  }
  const niTarifeeNiFermee = horizon.filter(d => !attendus.has(d) && !fermees.has(d))
  if (niTarifeeNiFermee.length) {
    console.log(`\n── ${niTarifeeNiFermee.length} date(s) ni tarifee(s) ni fermee(s) par l'hote :`)
    console.log('   ' + niTarifeeNiFermee.slice(0, 25).join(', ') + (niTarifeeNiFermee.length > 25 ? ' …' : ''))
    console.log('   -> FERMETURE CALCULEE (regle de l\'hote : « le reste ferme faute de prix »)')
  } else {
    console.log(`\n✓ chaque date de la fenetre est tarifee ou fermee par l'hote`)
  }

  // ⚠ `base_price: null` EN MEMOIRE, ET LA RAISON EST LA REGLE DE L'HOTE.
  // « Le reste ferme faute de prix ». `runFullSync` retombe sur `base_price`
  // avant de conclure « pas de prix » : avec 120 € en base, les dates sans
  // exception partiraient OUVERTES a 120 € — l'ecrasement exact qu'on repare.
  // On le neutralise pour CETTE poussee seulement.
  //
  // ⚠ ON N'ECRIT RIEN DANS `calendar_inventory.stop_sell`, et c'est la regle
  // gravee : la memoire d'intention n'appartient QU'A L'HOTE. Ces dates sont
  // fermees comme ETAT CALCULE — elles rouvriront d'elles-memes a la poussee
  // suivante des qu'un prix sera saisi, sans rien a defaire.
  //
  // ⚠ ET LE PIEGE, DIT PLUTOT QUE TU : la colonne `base_price` garde 120 €.
  // Une poussee ulterieure qui la lira rouvrira ces dates a 120 €. Aujourd'hui
  // rien ne le fera — `rate_sync_mode = 'keep'`, aucun cron ne pousse — mais
  // pour desarmer durablement il faut soit tarifer ces dates, soit vider
  // `base_price`. Decision de l'hote, pas du script.
  const res = await runFullSync({ ...bien, base_price: null }, { dryRun: !ECRIRE })
  console.log(`\n── full sync ${ECRIRE ? '' : '(essai a blanc)'}`)
  for (const [k, v] of Object.entries(res)) {
    if (Array.isArray(v)) console.log(`   ${k} : ${v.length}${v.length && v.length <= 8 ? ' — ' + v.join(', ') : ''}`)
    else if (v && typeof v === 'object') console.log(`   ${k} : ${JSON.stringify(v)}`)
    else console.log(`   ${k} : ${v}`)
  }

  if (!ECRIRE) { console.log('\nEssai a blanc — rien pousse. Relancer avec --ecrire.'); return }

  // ── RELECTURE : les prix chez Channex egalent-ils ceux du coeur ? ──────────
  // ⚠ C'EST LA SEULE PREUVE QUI COMPTE. Un `POST` a 200 dit que la tache est
  // acceptee, pas qu'elle est appliquee : Channex traite en asynchrone.
  console.log('\n── relecture (GET /restrictions), apres 6 s de traitement')
  await new Promise(r => setTimeout(r, 6000))
  const dates = [...attendus.keys()].sort()
  const debut = dates[0]
  const fin = new Date(new Date(dates[dates.length - 1]).getTime() + 20 * 86400000).toISOString().slice(0, 10)
  const rr = await get(`/restrictions?filter[property_id]=${bien.provider_property_id}`
    + `&filter[date][gte]=${debut}&filter[date][lte]=${fin}`
    + `&filter[restrictions]=rate,availability,stop_sell`)
  const parRp = (rr.json && rr.json.data && rr.json.data[bien.provider_rate_plan_id]) || {}
  let bons = 0; let faux = 0; let fermes = 0
  console.log(`   HTTP ${rr.code}`)
  for (const d of Object.keys(parRp).sort()) {
    const v = parRp[d]
    const attendu = attendus.get(d)
    const chez = v.rate != null ? Number(v.rate) : null
    if (attendu != null) {
      const ok = chez !== null && Math.abs(chez - attendu) < 0.005
      if (ok) bons++; else faux++
      console.log(`   ${d}  coeur ${attendu} €  Channex ${chez} €  stop_sell=${v.stop_sell}  ${ok ? '✓' : '✗ ECART'}`)
    } else {
      // ⚠ SUR UNE DATE FERMEE, LE PRIX N'EST PAS LE JUGE — `stop_sell` l'est.
      if (v.stop_sell === true) fermes++
      else {
        faux++
        console.log(`   ${d}  aucun prix au coeur, Channex ${chez} € stop_sell=${v.stop_sell}  ✗ OUVERTE SANS PRIX`)
      }
    }
  }
  console.log(`\n   ${bons} date(s) conformes, ${faux} ecart(s), ${fermes} date(s) fermees faute de prix`)
  if (faux) process.exitCode = 1
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
