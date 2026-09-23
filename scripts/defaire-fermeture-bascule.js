#!/usr/bin/env node
// scripts/defaire-fermeture-bascule.js — REPARATION : defaire le reliquat de la
// fermeture provisoire de la bascule Channex (10 septembre 2026).
//
// CE QUE C'EST. Le 10 septembre 2026, pendant la bascule de Bagneres, Thierry a
// fait tout fermer a la vente « le temps de verifier la migration », puis a
// rouvert le 11 au soir les seules dates TARIFEES. Les nuits au-dela sont
// restees `stop_sell = true`, `avail = 0`, SANS PRIX, ecrites en UN lot a la
// meme minute. Elles portent une intention de fermeture que personne n'a
// eue : elles auraient du etre « pas encore ouvertes » — sans ligne. Sur un
// bien pilote, le moteur ne rouvre JAMAIS une nuit fermee (« intention
// existante ») : ce reliquat bloque la fenetre.
//
// CE QUE FAIT LE SCRIPT. Il SUPPRIME exactement les lignes de ce lot — et rien
// d'autre — pour rendre ces nuits a l'etat « aucune intention ». Le moteur
// d'ouverture fait ensuite ce pour quoi il est concu : il ouvre les nuits de la
// fenetre AVEC leur prix, dans la meme demande ; les autres restent « pas
// encore ouvertes » et s'ouvriront quand la fenetre les atteindra.
//
// ⚠ SECOND ECRIVAIN DE `calendar_inventory`. Le writer unique est
// `lib/calendrier-writer.js` (porte HTTP `api/calendar.js`, canal interne du
// moteur). Ce script en est un SECOND, assume pour une REPARATION de donnees
// (comme le backfill de l'historique des reservations) : il n'ecrit rien, il
// supprime le reliquat d'un geste d'exception. Il l'annonce dans l'incident
// qu'il pose AVANT d'ecrire. Decision de Thierry, 23 septembre 2026.
//
// Usage :
//   node --env-file=.env.local scripts/defaire-fermeture-bascule.js \
//     --bien=<uuid> --lot=2026-09-10T17:15 --attendu=476          (passage a blanc)
//   ... --go --prod                                                 (ecrit, prod)
//
// ⚠ LE CRITERE SE PROUVE, IL NE SE DECRIT PAS. Une ligne est dans le lot si et
// seulement si : ce bien, date >= aujourd'hui, `updated_at` dans la minute
// `--lot`, `stop_sell = true`, `avail = 0`, AUCUN prix (`rate` nul ou absent).
// Le passage a blanc affiche le compte, les bornes, les trous, et NOMME chaque
// nuit fermee qui n'est PAS dans le lot. `--go` est refuse si le compte n'est
// pas exactement `--attendu`, si une nuit du lot est vendue, ou si une nuit du
// lot est couverte par une fermeture de l'hote (un objet `fermetures`).
//
// ⚠ LA SUPPRESSION EST CONDITIONNELLE : chaque DELETE repete le critere
// (`stop_sell`, `avail`, `rate is null`, bien) en plus de l'id — une ligne
// modifiee entre la lecture et l'ecriture n'est pas emportee.
//
// ⚠ `--simuler-pilote` : ce que le premier passage du pilote ferait si le lot
// etait supprime (calcul en memoire, lecture seule) — par mois, par niveau,
// minimum, maximum, et les prix qui ne collent a AUCUN niveau de la grille.
// C'est une APPROCHE fidele, pas une copie : meme `nuitsAOuvrir`, meme
// `prixDeLaNuit`, memes fermetures et prix de l'hote ; mais les ventes viennent
// de `nuitsVendues`, sans l'etape des prix ni les filtres du canal, et a la date
// du jour (un passage le lendemain ouvre une nuit de plus).
//
// ⚠ APRES UNE VERIFICATION VERTE, LE REPERE DU PILOTE EST EFFACE (review du
// script, 23 septembre 2026) : sinon, le pilote etant deja passe ce jour-la, les
// nuits resteraient « sans ligne » jusqu'au lendemain — fermees chez Channex
// (rien n'y part), mais lues « vendables au prix de base » par la page de
// reservation directe si le bien en a un. Le pilote passe au tick suivant
// (5 minutes), comme a une activation.

const { createClient } = require('@supabase/supabase-js')
const { finDeFenetre, pilotParYield } = require('../lib/pilote-tarifaire')
const { fermeturesDuBien, nuitsFermees } = require('../lib/fermetures')
const { nuitsVendues, relireMemoire } = require('../lib/nuits-du-moteur')
const { preparerContexte, prixDeLaNuit } = require('../lib/yield/contexte-du-bien')
const { nuitsAOuvrir } = require('../lib/moteur-ouverture')
const { prixHoteDuBien } = require('../lib/prix-hote')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const PROD = 'cjmrizpdyhrcurmgyrhs'

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const bienId = val('bien')
const lot = val('lot')
const attendu = val('attendu') != null ? Number(val('attendu')) : null
const GO = args.includes('--go')
const SIMULER = args.includes('--simuler-pilote')
if (!/^[0-9a-f-]{36}$/i.test(String(bienId || '')) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(lot || ''))) {
  console.error('Usage : --bien=<uuid> --lot=YYYY-MM-DDTHH:MM [--attendu=N] [--simuler-pilote] [--go --prod]'); process.exit(1)
}
if (GO && projet === PROD && !args.includes('--prod')) { console.error('REFUS : --go sur la PRODUCTION exige --prod.'); process.exit(1) }
if (GO && !Number.isInteger(attendu)) { console.error('REFUS : --go exige --attendu=<compte exact>, lu au passage a blanc.'); process.exit(1) }

const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
const sansPrix = l => !(Number(l.rate) > 0)
const fermee = l => l.stop_sell === true || l.avail === 0

;(async () => {
  console.log(`Projet Supabase : ${projet} — ${GO ? 'ECRITURE (--go)' : 'passage a blanc'}\n`)
  const auj = jourParis()
  const { data: bien, error: eB } = await sb.from('properties').select('*').eq('id', bienId).maybeSingle()
  if (eB || !bien) { console.error('ECHEC : bien illisible —', eB ? eB.message : 'introuvable'); process.exit(1) }
  console.log(`Bien : ${bien.name} (${bien.id}) — pilote ${bien.pilote_tarifaire}, fenetre ${bien.pilote_fenetre_valeur || '-'} ${bien.pilote_fenetre_type || ''}`)

  // Toutes les lignes a venir du bien, paginees (PostgREST s'arrete a 1000).
  const lignes = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('calendar_inventory').select('id, date, rate, avail, stop_sell, updated_at')
      .eq('property_id', bien.id).gte('date', auj).order('date').range(from, from + 999)
    if (error) { console.error('ECHEC : calendar_inventory —', error.message); process.exit(1) }
    lignes.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  // ⚠ `rate == null`, pas « sans prix » au sens large : c'est EXACTEMENT ce que
  // le DELETE exige (`is('rate', null)`). Une ligne a `rate = 0` n'est pas dans
  // le lot — l'ecart se voit au passage a blanc, pas au milieu d'une suppression.
  const dansLeLot = l => String(l.updated_at || '').slice(0, 16) === lot && l.stop_sell === true && l.avail === 0 && l.rate == null
  const leLot = lignes.filter(dansLeLot)
  const horsLot = lignes.filter(l => fermee(l) && !dansLeLot(l))

  // Ce qui interdirait de supprimer : une vente, une fermeture de l'hote.
  const fin = leLot.length ? leLot[leLot.length - 1].date : auj
  let vendues = new Set()
  if (leLot.length && bien.provider_property_id) vendues = await nuitsVendues(sb, bien, auj, fin)
  const fermetures = leLot.length ? await fermeturesDuBien(sb, bien.id, auj, fin) : []
  const parLHote = nuitsFermees(fermetures, auj, fin)
  const lotVendues = leLot.filter(l => vendues.has(l.date))
  const lotFermeesHote = leLot.filter(l => parLHote.has(l.date))

  // Les trous dans le lot (des nuits rouvertes entre-temps) : a DIRE.
  const trous = []
  for (let i = 1; i < leLot.length; i++) {
    const a = new Date(`${leLot[i - 1].date}T00:00:00Z`); a.setUTCDate(a.getUTCDate() + 1)
    const attenduJour = a.toISOString().slice(0, 10)
    if (leLot[i].date !== attenduJour) trous.push(`${attenduJour} .. veille du ${leLot[i].date}`)
  }

  console.log(`\n## LE LOT — minute ${lot}, stop_sell, avail 0, sans prix, a partir du ${auj}`)
  console.log(`compte : ${leLot.length}${attendu != null ? ` (attendu : ${attendu}) ${leLot.length === attendu ? '✔' : '✖ DIFFERENT'}` : ''}`)
  if (leLot.length) console.log(`bornes : ${leLot[0].date} → ${leLot[leLot.length - 1].date}`)
  console.log(`trous dans le lot (nuits rouvertes ou ecrites depuis) : ${trous.length ? trous.join(' ; ') : 'aucun'}`)
  console.log(`nuits du lot VENDUES : ${lotVendues.length}${lotVendues.length ? ' — ' + lotVendues.map(l => l.date).join(', ') : ''}`)
  console.log(`nuits du lot couvertes par une FERMETURE de l'hote : ${lotFermeesHote.length}${lotFermeesHote.length ? ' — ' + lotFermeesHote.map(l => l.date).join(', ') : ''}`)
  console.log(`\n## LES NUITS FERMEES QUI NE SONT PAS DANS LE LOT (elles ne seront PAS touchees) : ${horsLot.length}`)
  for (const l of horsLot) console.log(`  ${l.date} — ecrite ${l.updated_at.slice(0, 19)}, prix ${sansPrix(l) ? 'aucun' : l.rate + ' €'}, stop_sell ${l.stop_sell}, avail ${l.avail}`)

  const refus = []
  if (!leLot.length) refus.push('lot vide')
  if (attendu != null && leLot.length !== attendu) refus.push(`compte ${leLot.length} ≠ attendu ${attendu}`)
  if (lotVendues.length) refus.push(`${lotVendues.length} nuit(s) vendue(s) dans le lot`)
  if (lotFermeesHote.length) refus.push(`${lotFermeesHote.length} nuit(s) couverte(s) par une fermeture de l'hote`)

  if (SIMULER) await simulerPilote(bien, auj, lignes, leLot)

  if (!GO) {
    console.log(`\nPassage a blanc : rien n a ete ecrit.${refus.length ? ' --go serait REFUSE : ' + refus.join(' ; ') + '.' : ''}`)
    process.exit(refus.length ? 1 : 0)
  }
  if (refus.length) { console.error(`\nREFUS du --go : ${refus.join(' ; ')}.`); process.exit(1) }

  // ── L'INCIDENT, AVANT D'ECRIRE (regle « une ecriture de masse s'annonce »).
  const t0 = new Date(Date.now() - 1000).toISOString()
  const { reportIncident } = require('../lib/founder-notify')
  await reportIncident('ecriture_de_masse_annoncee', {
    userId: bien.user_id, propertyId: bien.id, propertyName: bien.name,
    detail: {
      message: `Reparation : suppression de ${leLot.length} lignes calendar_inventory (reliquat de la fermeture provisoire de la bascule du 10 septembre 2026).`,
      script: 'scripts/defaire-fermeture-bascule.js', date: new Date().toISOString(), lot,
      bornes: [leLot[0].date, leLot[leLot.length - 1].date], compte: leLot.length,
      critere: 'meme bien, date >= aujourd hui, updated_at dans la minute du lot, stop_sell = true, avail = 0, sans prix',
      second_ecrivain: 'Ce script est un SECOND ECRIVAIN de calendar_inventory, dont le writer unique est lib/calendrier-writer.js. Exception ASSUMEE pour une reparation de donnees, decidee par Thierry le 23 septembre 2026 : les nuits auraient du etre « pas encore ouvertes » (sans ligne) ; la regle « writer unique » reste la regle.'
    }
  })
  // ⚠ RELIRE L'INCIDENT : `reportIncident` ne verifie pas l'erreur de son
  // insert. Sans trace en base, on ne supprime pas.
  const { data: trace, error: eT } = await sb.from('automation_incidents').select('id')
    .eq('type', 'ecriture_de_masse_annoncee').eq('property_id', bien.id).gte('created_at', t0)
  if (eT || !(trace || []).length) { console.error('REFUS : l incident n est pas en base —', eT ? eT.message : 'aucune ligne', '— rien n a ete supprime.'); process.exit(1) }
  console.log(`\nIncident pose et relu (ecriture_de_masse_annoncee, ${trace[0].id}), avec la mention « second ecrivain ».`)

  // ── LA SUPPRESSION, CONDITIONNELLE, PAR PAQUETS.
  let supprimees = 0
  const ids = leLot.map(l => l.id)
  // La minute du lot, en bornes : une ligne REECRITE depuis la lecture (meme
  // fermee, meme sans prix) porte un `updated_at` neuf — c'est un vrai geste,
  // elle n'est pas emportee.
  const debutMinute = `${lot}:00Z`
  const finMinute = new Date(Date.parse(debutMinute) + 60000).toISOString()
  for (let i = 0; i < ids.length; i += 100) {
    const paquet = ids.slice(i, i + 100)
    const { data, error } = await sb.from('calendar_inventory').delete()
      .in('id', paquet).eq('property_id', bien.id).eq('stop_sell', true).eq('avail', 0).is('rate', null)
      .gte('updated_at', debutMinute).lt('updated_at', finMinute)
      .select('id')
    if (error) { console.error(`ECHEC au paquet ${i / 100 + 1} :`, error.message, `— ${supprimees} supprimee(s) avant l echec.`); process.exit(1) }
    supprimees += (data || []).length
  }
  console.log(`Supprimees : ${supprimees} / ${leLot.length}`)

  // ── LA VERIFICATION, APRES : on RELIT comme a la lecture initiale (paginee
  // par bien et par date) — pas un `.in` geant dans l'URL, qui echouerait en
  // 414 et crierait « impossible » apres une suppression reussie.
  const apres = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('calendar_inventory').select('id, date, rate, avail, stop_sell, updated_at')
      .eq('property_id', bien.id).gte('date', auj).order('date').range(from, from + 999)
    if (error) { console.error('VERIFICATION IMPOSSIBLE :', error.message, `— ${supprimees} ligne(s) supprimee(s).`); process.exit(1) }
    apres.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const restent = apres.filter(dansLeLot).length
  const horsIntacts = horsLot.filter(h => apres.some(a => a.id === h.id && a.updated_at === h.updated_at && a.rate === h.rate && a.stop_sell === h.stop_sell && a.avail === h.avail)).length
  console.log(`Verification : lignes du lot restantes ${restent} (attendu 0) · nuits hors lot intactes ${horsIntacts} / ${horsLot.length}${horsLot.length ? ' (' + horsLot.map(h => h.date).join(', ') + ')' : ''}`)
  const vert = restent === 0 && horsIntacts === horsLot.length && supprimees === leLot.length
  if (!vert) { console.error('VERIFICATION ROUGE : le repere du pilote n est PAS efface.'); process.exit(1) }

  // ── LE REPERE DU PILOTE, EFFACE : les nuits s'ouvrent au tick suivant.
  const { effacerMarqueur } = require('../lib/ouverture-marqueur')
  const { error: eM } = await effacerMarqueur(sb, bien.id)
  if (eM) { console.error('Repere du pilote NON efface :', eM.message, '— les nuits s ouvriront au passage de demain.'); process.exit(1) }
  console.log('Repere du pilote efface : le prochain passage du cron (5 minutes au plus) ouvre les nuits de la fenetre AVEC leur prix.')
  console.log(`A surveiller : le repere « ouverture:${bien.id} » revient avec « ouvertes ≈ ${leLot.filter(l => l.date <= (finDeFenetre(bien, auj) || '')).length} ».`)
  process.exit(0)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })

// Ce que le premier passage du pilote ferait si le lot etait supprime.
async function simulerPilote (bien, auj, lignes, leLot) {
  console.log('\n## SIMULATION DU PREMIER PASSAGE DU PILOTE, lot supprime (en memoire, rien n est ecrit)')
  if (!pilotParYield(bien)) { console.log('bien non pilote : le moteur ne passera pas.'); return }
  const fin = finDeFenetre(bien, auj)
  // Par DATE : `relireMemoire` ne lit pas l'id des lignes.
  const datesLot = new Set(leLot.map(l => l.date))
  const apres = (await relireMemoire(sb, bien, auj, fin)).filter(l => !datesLot.has(l.date))
  const lignesApres = lignes.filter(l => !datesLot.has(l.date) && l.date <= fin)
  const ctx = await preparerContexte(sb, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin, lignesCal: undefined })
  const fermetures = await fermeturesDuBien(sb, bien.id, auj, fin)
  const vendues = bien.provider_property_id ? await nuitsVendues(sb, bien, auj, fin) : new Set()
  const prixHote = await prixHoteDuBien(sb, bien.id, auj, fin)
  const niveauDe = new Map()
  const prixCalcule = new Map()
  for (let d = auj; d <= fin; ) {
    const s = prixDeLaNuit(ctx, d, { ouverte: true, vendue: vendues.has(d) })
    if (s && s.prix != null) { prixCalcule.set(d, Math.round(Number(s.prix) * 100)); niveauDe.set(d, s.niveau_effectif || s.niveau) }
    const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10)
  }
  const o = nuitsAOuvrir({ bien, aujourdHui: auj, lignes: apres.length ? apres : lignesApres, fermetures, prixCalcule, vendues, prixHote })
  console.log(`fenetre : ${auj} → ${fin}`)
  console.log(`comptes : ${JSON.stringify(o.comptes)}`)
  const nuits = o.nuits.filter(n => n.ouvrir)
  const prix = nuits.map(n => n.prix_centimes / 100)
  if (!nuits.length) { console.log('aucune nuit ne s ouvrirait.'); return }
  console.log(`nuits qui s ouvriraient : ${nuits.length} · de ${nuits[0].date} a ${nuits[nuits.length - 1].date} · prix min ${Math.min(...prix)} € · max ${Math.max(...prix)} €`)
  const grille = (ctx.grille.base && ctx.grille.base.niveaux) || []
  const prixNiveaux = new Map(grille.map(n => [Math.round(Number(n.prix) * 100), n.nom || n.label || n.niveau]))
  console.log(`grille du bien : ${grille.map(n => `${n.nom || n.label || n.niveau} ${n.prix} €`).join(' · ')}`)
  const parMois = {}
  for (const n of nuits) {
    const m = n.date.slice(0, 7), niv = prixNiveaux.get(n.prix_centimes) || 'HORS GRILLE'
    const e = parMois[m] = parMois[m] || { nuits: 0, somme: 0, niveaux: {} }
    e.nuits++; e.somme += n.prix_centimes / 100; e.niveaux[niv] = (e.niveaux[niv] || 0) + 1
  }
  console.log('par mois :')
  for (const [m, e] of Object.entries(parMois)) console.log(`  ${m} — ${String(e.nuits).padStart(3)} nuits · moyenne ${(e.somme / e.nuits).toFixed(0)} € · ${Object.entries(e.niveaux).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  const horsGrille = nuits.filter(n => !prixNiveaux.has(n.prix_centimes))
  console.log(`prix qui ne collent a AUCUN niveau de la grille : ${horsGrille.length}${horsGrille.length ? ' — ' + horsGrille.slice(0, 20).map(n => `${n.date} ${n.prix_centimes / 100} €`).join(', ') : ''}`)
  const sansPrixOuv = o.comptes.sans_prix || 0
  if (sansPrixOuv) console.log(`⚠ ${sansPrixOuv} nuit(s) resteraient fermees faute de prix (prix de base vide).`)
}
