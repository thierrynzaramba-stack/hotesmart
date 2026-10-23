#!/usr/bin/env node
// scripts/verifier-dette-78.js — la preuve avant/apres de la dette 78
// (20 octobre 2026, demande de Thierry). REVIEW.md regle 8.
//
// « Une nuit fermee n'est pas une nuit invendue. » `eclater` retire deja des
// nuits de REFERENCE celles qu'une exception ou une fermeture declaree couvre,
// et `calculerIndicateurs` divise `nuiteesRef` par `jours_ouverts` — mais
// AUCUN appelant ne passait `joursExclus` a `joursOuverts`. Le numerateur
// retirait, le denominateur gardait.
//
// ⚠ CE QU'IL PROUVE, ET CE QU'IL NE PROUVE PAS. Il mesure l'AMPLEUR de la
// correction sur les donnees reelles : il appelle `joursOuverts` deux fois,
// avec et sans `joursExclus`, et compare. Il ne prouve PAS que la production
// passe l'option — supprimer `joursExclus: exclus` d'api/yield.js le laisserait
// vert. Le CABLAGE est prouve par `tests/api-yield.test.js`, dont six
// garde-fous rougissent contre le commit precedent (regle 19). Les deux
// artefacts repondent a deux questions ; aucun ne remplace l'autre, et le KB
// ne doit pas citer celui-ci comme « la preuve » du cablage.
//
// CE QU'IL COMPARE, bien par bien et fenetre par fenetre :
//   A (avant) : denominateur qui garde les jours declares fermes
//   B (apres) : denominateur qui les retire, comme le numerateur
//
// ⚠ CE QU'IL ASSERTE, et pas seulement affiche :
//   1. le NUMERATEUR est identique des deux cotes — seul le denominateur bouge ;
//   2. on ne retire jamais plus de jours qu'il n'y en a de declares fermes ;
//   3. la correction ne peut que FAIRE MONTER le taux, jamais le baisser ;
//   4. au moins une fenetre doit porter une fermeture declaree, sinon la preuve
//      est vide — un verificateur qui n'a rien lu doit echouer.
//   5. ⚠ ET LA FENETRE TEMOIN DOIT MONTRER UN ECART. L'assertion 4 ne suffit
//      pas : une fermeture declaree que `retirerDeLaVente` a DEJA fermee au
//      calendrier donne un ecart NUL, legitimement (c'est la forme normale).
//      Les trois fenetres pouvaient donc toutes porter des fermetures et le
//      script conclure « AVANT/APRES CONFORME » sans qu'un seul chiffre ait
//      bouge — un vert qui ne mesure rien, et sur un taux d'occupation c'est
//      pire que pas de mesure. La fenetre TEMOIN exige donc un ecart STRICT sur
//      au moins un bien : si l'exception est supprimee en base ou si la fenetre
//      la manque, le script echoue au lieu de verdir a vide.
//
// Usage : node --env-file=.env.local   scripts/verifier-dette-78.js
//         node --env-file=.env.staging scripts/verifier-dette-78.js [debut] [fin]
//
// LECTURE SEULE : ce script n'ecrit rien.

// ⚠ LE GARDE D'ENVIRONNEMENT AVANT LES `require` APPLICATIFS : `lib/yield/*`
// et `api/*` construisent un client Supabase au CHARGEMENT. Sans cet ordre, un
// oubli de `--env-file` sort une pile Node de dix lignes au lieu du nom de la
// variable manquante.
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents. Passer --env-file.')
  process.exit(1)
}

const { createClient } = require('@supabase/supabase-js')
const { eclater, construirePontDemapped } = require('../lib/yield/eclatement')
const { calculerIndicateurs } = require('../lib/yield/indicateurs')
const { joursOuverts, lignesDuCalendrier, joursDeLaPeriode } = require('../lib/yield/capacite')
const { joursExclus, exceptionsDuBien } = require('../lib/yield/exceptions')

const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const jourLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const ajouter = (j, n) => { const [a, m, d] = j.split('-').map(Number); return jourLocal(new Date(a, m - 1, d + n)) }
const pct = (x) => (x == null ? 'non calculable' : (x * 100).toFixed(1).replace('.', ',') + ' %')
const eur = (x) => (x == null ? 'non calculable' : x.toFixed(2).replace('.', ',') + ' €')

let echecs = 0
let avecFermeture = 0
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

// Agrege la fenetre a partir des periodes rendues par le moteur. TO et RevPAR
// de la fenetre = somme des numerateurs / somme des jours ouverts, la formule
// de lib/yield/indicateurs.js.
function agreger (periodes) {
  let nuiteesRef = 0, caRef = 0, ouverts = 0, estimee = false, declaresFermes = 0
  for (const p of periodes) {
    declaresFermes += p.jours_retires_par_declaration || 0
    if (p.jours_ouverts == null) continue
    nuiteesRef += (p.nuitees || 0) - (p.nuitees_exclues_du_taux || 0)
    caRef += (p.ca || 0) - (p.ca_exclu_du_revpar || 0)
    ouverts += p.jours_ouverts
    if (p.capacite_estimee) estimee = true
  }
  return {
    to: ouverts > 0 ? nuiteesRef / ouverts : null,
    revpar: ouverts > 0 ? caRef / ouverts : null,
    nuiteesRef, caRef, ouverts, estimee, declaresFermes
  }
}

async function main () {
  const auj = jourLocal(new Date())
  // ⚠ LE COMPTE EST CHOISI PUIS TOUT EST FILTRE DESSUS. La premiere version
  // lisait `properties` pour TOUS les comptes, sans `user_id` et sans
  // pagination — en service key, donc RLS contournee (regle 1 du depot), et
  // tronque a 1000 lignes en silence. Elle prenait ensuite « le compte qui a le
  // plus de biens » : sur staging, c'est la plus grosse fixture de recette,
  // mesuree et presentee comme une preuve sur les biens reels.
  const PAGE = 1000
  const tous = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('properties')
      .select('id, user_id').not('provider_property_id', 'is', null)
      .order('id').range(from, from + PAGE - 1)
    if (error) { console.error('Lecture des biens impossible :', error.message); process.exit(1) }
    tous.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  if (!tous.length) { console.error('ECHEC : aucun bien lu.'); process.exit(1) }
  const parCompte = {}
  for (const b of tous) (parCompte[b.user_id] = parCompte[b.user_id] || []).push(b)
  const compte = Object.keys(parCompte).sort((a, c) => parCompte[c].length - parCompte[a].length)[0]
  // Et on relit les fiches COMPLETES du seul compte retenu : `joursOuverts`
  // depend de `base_price`, `capacity`, `zone_scolaire`, `pilote_*`.
  const { data: lesSiens, error: eB } = await sb.from('properties').select('*')
    .eq('user_id', compte).not('provider_property_id', 'is', null).order('name')
  if (eB) { console.error('Lecture des biens impossible :', eB.message); process.exit(1) }
  console.log(`\nBase    : ${projet}`)
  console.log(`Compte  : ${compte.slice(0, 8)}, ${lesSiens.length} bien(s) raccorde(s)`
    + ` sur ${tous.length} du projet`)

  let lignes = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('bookings_snapshot')
      .select('user_id, booking_id, property_id, snapshot, raw')
      .eq('user_id', compte).order('booking_id').range(from, from + 999)
    if (error) throw new Error(`bookings_snapshot : ${error.message}`)
    lignes = lignes.concat(data || [])
    if (!data || data.length < 1000) break
  }

  // Les trois fenetres de la mesure du 20 octobre 2026, ou celle passee en
  // arguments. La troisieme est celle ou la dette MORD : le passe ancien, sans
  // memoire d'intention, ou la convention « un jour passe sans ligne est repute
  // ouvert » s'applique.
  //
  // ⚠ LES DEUX PREMIERES SONT RELATIVES, LA TROISIEME EST FIGEE, ET C'EST LA
  // REGLE DU DEPOT APPLIQUEE DANS LES DEUX SENS : « dates relatives si on lit
  // l'horloge, dates figees si on injecte le temps ». Les deux premieres
  // interrogent un etat qui suit l'horloge (le passe recent, le futur proche) :
  // relatives. La troisieme designe un FAIT HISTORIQUE — l'exception de
  // 17 jours declaree sur Coeur de vie 23 du 20 septembre au 15 octobre 2025 —
  // qui ne bouge plus : la figer est la seule façon qu'elle reste reproductible.
  // Elle etait relative (auj-395 -> auj-370), donc elle DERIVAIT d'un jour par
  // jour : lancee le 23 octobre 2026 elle couvrait le 23 septembre au
  // 18 octobre 2025, soit trois jours de l'exception hors fenetre, et le temoin
  // de Thierry (66,7 %) n'etait deja plus reproductible.
  const TEMOIN = {
    nom: 'TEMOIN — passe ancien SANS memoire d intention',
    debut: '2025-09-20', fin: '2025-10-15', temoin: true
  }
  const fenetres = process.argv[2] && process.argv[3]
    ? [{ nom: 'fenetre demandee', debut: process.argv[2], fin: process.argv[3] }]
    : [
      { nom: '30 derniers jours', debut: ajouter(auj, -30), fin: ajouter(auj, -1) },
      { nom: 'fermetures a venir (futur)', debut: auj, fin: ajouter(auj, 42) },
      TEMOIN
    ]
  const avecTemoin = fenetres.some(f => f.temoin)

  for (const f of fenetres) {
    console.log(`\n── ${f.nom} : ${f.debut} -> ${f.fin} ──────────────────────`)
    let ecartsDeLaFenetre = 0
    let fermeturesDeLaFenetre = 0
    const l = (s, n) => String(s).padEnd(n)
    console.log('  ' + l('bien', 22) + l('TO avant', 13) + l('TO apres', 13)
      + l('RevPAR avant', 15) + l('RevPAR apres', 15) + 'jours retires')
    for (const bien of lesSiens) {
      const { pont } = construirePontDemapped(lignes, bien.provider)
      const duBien = lignes.filter(x => x.property_id === bien.provider_property_id)
      const exceptions = await exceptionsDuBien(sb, bien.id, f.debut, f.fin)
      const exclus = await joursExclus(sb, bien.id, f.debut, f.fin, { exceptions })
      const eclatements = duBien.map(x => eclater(x, { pont, joursExclus: exclus, defaultProvider: bien.provider }))
      const jours = joursDeLaPeriode(f.debut, f.fin) || []
      const nbExclus = jours.filter(j => (exclus.has ? exclus.has(j) : !!exclus[j])).length
      if (nbExclus) { avecFermeture++; fermeturesDeLaFenetre++ }
      const lignesCal = await lignesDuCalendrier(sb, bien.id, f.debut, f.fin)

      const capa = new Map()
      const capb = new Map()
      for (const j of jours) {
        capa.set(j, await joursOuverts(sb, bien, j, j, { aujourdHui: auj, estimerLePasse: true, lignes: lignesCal }))
        capb.set(j, await joursOuverts(sb, bien, j, j, { aujourdHui: auj, estimerLePasse: true, lignes: lignesCal, joursExclus: exclus }))
      }
      const dans = (ps) => ps.filter(p => p.periode >= f.debut && p.periode <= f.fin)
      const A = agreger(dans(calculerIndicateurs(eclatements, { granularite: 'jour', capacites: capa, capacitePersonnes: bien.capacity })))
      const B = agreger(dans(calculerIndicateurs(eclatements, { granularite: 'jour', capacites: capb, capacitePersonnes: bien.capacity })))
      const retires = A.ouverts - B.ouverts
      // L'ECART, au sens de la recette : le taux a reellement bouge sur ce bien.
      if (retires > 0 && A.to != null && B.to != null && B.to > A.to) ecartsDeLaFenetre++

      // ⚠ LES ASSERTIONS, pas seulement l'affichage.
      if (A.nuiteesRef !== B.nuiteesRef || Math.abs(A.caRef - B.caRef) > 0.005) {
        ko(`${bien.name} / ${f.nom} : le NUMERATEUR a bouge (${A.nuiteesRef} -> ${B.nuiteesRef} nuitees,`
          + ` ${A.caRef.toFixed(2)} -> ${B.caRef.toFixed(2)} EUR) : seul le denominateur devait changer`)
      }
      if (retires < 0) ko(`${bien.name} / ${f.nom} : ${retires} jours retires, le denominateur a GRANDI`)
      if (retires > nbExclus) {
        ko(`${bien.name} / ${f.nom} : ${retires} jours retires pour ${nbExclus} declares fermes`)
      }
      if (retires > 0 && A.to != null && B.to != null && B.to < A.to) {
        ko(`${bien.name} / ${f.nom} : le taux BAISSE (${pct(A.to)} -> ${pct(B.to)})`)
      }
      // ⚠ UNE INEGALITE, PAS UNE EGALITE — et l'egalite faisait echouer le
      // script sur des donnees SAINES. `retirerDeLaVente` enregistre la
      // fermeture ET ferme la nuit au calendrier : la forme NORMALE d'une
      // fermeture d'hote donne donc des jours declares qui n'avaient plus rien
      // a quitter. L'ordre juste est : retires <= annonces <= declares.
      if (!(retires <= B.declaresFermes && B.declaresFermes <= nbExclus)) {
        ko(`${bien.name} / ${f.nom} : ${retires} retires, ${B.declaresFermes} annonces,`
          + ` ${nbExclus} declares — l'ordre retires <= annonces <= declares est rompu`)
      }

      console.log('  ' + l(bien.name, 22) + l(pct(A.to), 13) + l(pct(B.to), 13)
        + l(eur(A.revpar), 15) + l(eur(B.revpar), 15)
        + `${retires} / ${A.ouverts} ouverts`
        + (nbExclus ? `  (${nbExclus} jour(s) declare(s) ferme(s))` : '')
        + (A.estimee || B.estimee ? '  [capacite ESTIMEE]' : ''))
    }

    // ⚠ LE TEMOIN TEMOIGNE, OU LE SCRIPT ECHOUE. C'est la seule fenetre dont on
    // SAIT ce qu'elle doit montrer : une exception declaree sur un passe ancien
    // sans ligne de calendrier, donc des jours reputes ouverts par convention
    // que la correction retire. Zero ecart ici ne veut pas dire « rien a
    // corriger », ça veut dire que la mesure ne mesure plus — exception
    // supprimee, fenetre qui la manque, ou correction debranchee.
    if (f.temoin) {
      if (!fermeturesDeLaFenetre) {
        ko(`${f.nom} : aucune fermeture declaree sur la fenetre temoin.`
          + ' La preuve est vide : verifier que l exception existe encore en base.')
      } else if (!ecartsDeLaFenetre) {
        ko(`${f.nom} : ${fermeturesDeLaFenetre} bien(s) avec fermeture declaree,`
          + ' mais AUCUN ecart de taux. Le temoin ne temoigne plus.')
      } else {
        console.log(`  → temoin : ${ecartsDeLaFenetre} bien(s) dont le taux MONTE.`)
      }
    }
  }

  console.log('')
  if (!avecFermeture) {
    console.error('ECHEC : aucune fenetre ne porte de fermeture declaree.')
    console.error('Un avant/apres sur rien ne prouve rien. Choisir une fenetre qui en contient.')
    process.exit(1)
  }
  console.log(`${avecFermeture} couple(s) bien x fenetre portant au moins une fermeture declaree.`)
  if (!avecTemoin) {
    console.log('⚠ FENETRE PASSEE EN ARGUMENT : c est une MESURE, pas la recette.')
    console.log('  La recette est le lancement sans argument, qui porte la fenetre temoin.')
  }
  if (echecs) { console.error(`\n${echecs} ECHEC(S). Le lot ne doit pas partir.`); process.exit(1) }
  console.log('AVANT/APRES CONFORME : le numerateur est intact, seul le denominateur retire les')
  console.log('jours declares fermes, et il ne retire jamais plus qu il n y en a de declares.')
}

main().catch(e => { console.error('Erreur :', e.message); process.exit(1) })
