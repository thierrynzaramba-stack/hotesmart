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
// Cette relecture couvre LES 500 JOURS POUSSES, et toute date de la fenetre
// que Channex ne rend pas est comptee NON JUGEE — un echantillon ne vaut pas
// un verdict.
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
const { runFullSync, JOURS_POUSSES } = require('../lib/channel-fullsync')
const { buildOccupancyRates } = require('../lib/channel-pricing')

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
  // ⚠ UNE SEULE FENETRE POUR TOUT LE SCRIPT, ET C'EST CELLE DU WRITER.
  // Releve en review : les attendus etaient bati sur TOUT l'historique de
  // `calendar_inventory` alors que `runFullSync` ne pousse que
  // [aujourd'hui, +500 j], et la relecture ne couvrait que l'enveloppe des
  // dates tarifees. Les deux moities du script ne parlaient donc pas de la
  // meme fenetre : 2 dates tarifees passees sortaient du verdict EN SILENCE
  // (36 au coeur, 34 juges), et ~400 dates poussees n'etaient jamais relues.
  const auj = new Date()
  const horizon = []
  for (let i = 0; i < JOURS_POUSSES; i++) {
    horizon.push(new Date(auj.getTime() + i * 86400000).toISOString().slice(0, 10))
  }
  const dansFenetre = new Set(horizon)

  const tarifees = lignes.filter(x => x.rate != null && Number(x.rate) > 0)
  const attendus = new Map(tarifees.filter(x => dansFenetre.has(x.date))
    .map(x => [x.date, Number(x.rate)]))
  const horsFenetre = tarifees.filter(x => !dansFenetre.has(x.date))
  const fermees = new Set(lignes.filter(x => x.stop_sell === true).map(x => x.date))
  console.log(`\n── le coeur : ${lignes.length} date(s) reglee(s)`)
  console.log(`   ${attendus.size} tarifee(s) DANS la fenetre poussee  |  ${fermees.size} fermee(s) par l'hote (stop_sell)`)
  for (const [d, r] of attendus) console.log(`   ${d}  ${r} €`)
  if (horsFenetre.length) {
    // ⚠ NOMMEES, PAS TUES : ces dates portent un prix au coeur mais sortent de
    // la fenetre du writer (passe, ou au-dela de 500 jours). Elles ne sont ni
    // poussees ni relues — le verdict ne les couvre pas, et il doit le DIRE.
    console.log(`\n   ⚠ ${horsFenetre.length} date(s) tarifee(s) HORS de la fenetre poussee — ni poussees ni jugees :`)
    console.log('      ' + horsFenetre.map(x => `${x.date} (${x.rate} €)`).join(', '))
  }

  // ⚠ LE CONTROLE QUI COMPTE, AVANT TOUT ENVOI.
  // Une date de la fenetre ni tarifee ni fermee partirait ouverte, et se
  // vendrait au prix par defaut de l'option du rate plan.
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
  // ⚠ ON RELIT TOUTE LA FENETRE POUSSEE, pas l'enveloppe des dates tarifees.
  const debut = horizon[0]
  const fin = horizon[horizon.length - 1]
  const rr = await get(`/restrictions?filter[property_id]=${bien.provider_property_id}`
    + `&filter[date][gte]=${debut}&filter[date][lte]=${fin}`
    + `&filter[restrictions]=rate,availability,stop_sell`)
  console.log(`   HTTP ${rr.code}  fenetre ${debut} -> ${fin}`)
  // ⚠ UN VIDE N'EST PAS UN SUCCES. Releve en review : sur un 429, un 401, un
  // rate plan remappe ou un payload inattendu, `parRp` valait `{}`, la boucle
  // ne tournait pas, le script imprimait « 0 conformes, 0 ecart » et sortait
  // en 0. Le verdict le plus rassurant du script etait son mode de panne.
  if (rr.code !== 200) throw new Error(`relecture impossible : HTTP ${rr.code} — AUCUN verdict`)
  const parRp = (rr.json && rr.json.data && rr.json.data[bien.provider_rate_plan_id]) || {}
  if (!Object.keys(parRp).length) {
    throw new Error(`relecture vide pour le tarif ${bien.provider_rate_plan_id}`
      + ` — AUCUN verdict (tarifs rendus : ${Object.keys((rr.json && rr.json.data) || {}).join(', ') || 'aucun'})`)
  }
  let bons = 0; let faux = 0; let fermes = 0
  // ⚠ SUR UN BIEN VENDU PAR PERSONNE, LE PRIX DU COEUR N'EST PAS CELUI QUE
  // `/restrictions` REND, ET MA PREMIERE VERSION CRIAIT 34 ECARTS INEXISTANTS.
  // `/restrictions` rend le tarif de l'occupation PRIMAIRE. Sur Cœur de vie 23
  // (`per_person`, capacite 6, 4 inclus, 2 €/personne), l'occupation primaire
  // est 6 : Channex rend donc `prix + 4 €`. Mesure du 11 septembre : coeur 89 €,
  // Channex 93 € — la poussee etait JUSTE, la verification fausse.
  //
  // On calcule l'attendu avec `buildOccupancyRates`, LA FONCTION DU WRITER :
  // toute divergence future entre ce qu'on pousse et ce qu'on verifie devient
  // impossible. `null` = pas de supplement (bien `per_room`) -> le prix nu.
  const attenduChezLeProvider = (prixEur) => {
    const occRates = buildOccupancyRates(
      Math.round(prixEur * 100), bien.capacity, bien.included_guests,
      Math.round((Number(bien.extra_guest_fee) || 0) * 100))
    if (!occRates) return prixEur
    const primaire = occRates[occRates.length - 1]   // l'occupation max = la primaire
    return primaire.rate / 100
  }

  for (const d of Object.keys(parRp).sort()) {
    const v = parRp[d]
    const attenduCoeur = attendus.get(d)
    const chez = v.rate != null ? Number(v.rate) : null
    if (attenduCoeur != null) {
      const attendu = attenduChezLeProvider(attenduCoeur)
      const ok = chez !== null && Math.abs(chez - attendu) < 0.005
      if (ok) bons++; else faux++
      const sup = attendu !== attenduCoeur ? ` (dont ${(attendu - attenduCoeur).toFixed(2)} € de supplement occupation)` : ''
      console.log(`   ${d}  coeur ${attenduCoeur} €  attendu ${attendu} €${sup}  Channex ${chez} €  stop_sell=${v.stop_sell}  ${ok ? '✓' : '✗ ECART'}`)
    } else {
      // ⚠ SUR UNE DATE FERMEE, LE PRIX N'EST PAS LE JUGE — `stop_sell` l'est.
      if (v.stop_sell === true) fermes++
      else {
        faux++
        console.log(`   ${d}  aucun prix au coeur, Channex ${chez} € stop_sell=${v.stop_sell}  ✗ OUVERTE SANS PRIX`)
      }
    }
  }
  // ⚠ LA COUVERTURE FAIT PARTIE DU VERDICT. Une date de la fenetre que Channex
  // ne rend pas n'est pas « conforme » : elle est NON JUGEE, et l'ignorer
  // rendrait un vert sur un echantillon.
  const lues = new Set(Object.keys(parRp))
  const nonJugees = horizon.filter(d => !lues.has(d))
  console.log(`\n   ${bons} date(s) conformes, ${faux} ecart(s), ${fermes} date(s) fermees faute de prix`)
  console.log(`   couverture : ${lues.size}/${horizon.length} date(s) de la fenetre relues`)
  if (nonJugees.length) {
    console.log(`   ⛔ ${nonJugees.length} date(s) NON JUGEE(S) (absentes de la relecture) :`)
    console.log('      ' + nonJugees.slice(0, 20).join(', ') + (nonJugees.length > 20 ? ' …' : ''))
  }
  if (horsFenetre.length) {
    console.log(`   ⚠ ${horsFenetre.length} date(s) tarifee(s) hors fenetre restent hors du verdict`)
  }
  if (faux || nonJugees.length) process.exitCode = 1
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
