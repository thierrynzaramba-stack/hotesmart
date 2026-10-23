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
// vert. Le CABLAGE est prouve par les tests, et par L'INVARIANT DES TROIS
// BLOCS en particulier (`tests/api-yield.test.js`) : dans une seule reponse,
// `realise`, le « a date » et la projection doivent diviser par le MEME
// denominateur et citer le MEME TO N-1. Le compte annonce ici etait « six
// garde-fous dans api-yield » : faux, mesure par contre-epreuve — 4 dans
// `api-yield` et 3 dans `capacite-yield`. Un compte faux dans un en-tete se lit
// comme une mesure. Les deux
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
// ⚠ LE LECTEUR DU DEPOT, PAS UNE TROISIEME COPIE — releve en re-review.
// Les cinq lignes de pagination recopiees ici etaient `lireReservations` mot
// pour mot, MOINS sa borne `RESERVATIONS_MAX` : les deux autres copies REFUSENT
// au-dela (l'endpoint rend 413), celle-ci continuait de paginer et imprimait un
// TO/RevPAR calcule sur un historique que l'endpoint qu'elle pretend prouver
// aurait refuse de calculer. C'est le mode de defaillance que le registre
// enregistre pour le neuvieme rouge du 14 septembre. Et la chaine de projection
// vivait dans trois fichiers : en retirer `user_id` dans un seul ferait clef
// `construirePontDemapped` sur `undefined`, en silence.
const { lireReservations } = require('../lib/yield/grille-du-bien')

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

// ⚠ LE COMPTE SE DESIGNE, IL NE SE DEVINE PAS — releve en re-review, deux
// defauts dans le meme geste. (a) La lecture de decouverte n'avait aucun
// `.eq('user_id', ...)` : REVIEW.md regle 1 l'exige sur tout traitement par
// lot, et son pourquoi est litteral — « la RLS ne protege pas le service key,
// qui la contourne par conception ». (b) Le compte etait choisi par
// heuristique, « celui qui a le plus de biens » : ce lot vient de FIGER la
// fenetre temoin pour la rendre reproductible, et le compte restait mobile —
// le jour ou un CLIENT a cinq biens, la recette publiee au KB mesure un autre
// hote, et le garde-fou casse sur un evenement de CROISSANCE.
// La decouverte ne lit donc QUE `user_id` (aucune donnee de bien), elle
// s'annonce, et elle ne MESURE rien : elle rend la main avec le code 2.
const compteDemande = (process.argv.find(a => a.startsWith('--compte=')) || '').slice(9) || null
const positionnels = process.argv.slice(2).filter(a => !a.startsWith('--'))

async function decouvrir () {
  const { data, error } = await sb.from('properties')
    .select('user_id').not('provider_property_id', 'is', null).limit(1000)
  if (error) { console.error('Lecture impossible :', error.message); process.exit(1) }
  const compte = {}
  for (const b of (data || [])) compte[b.user_id] = (compte[b.user_id] || 0) + 1
  console.error('\nAUCUN COMPTE DESIGNE. La recette nomme le compte qu elle mesure.')
  console.error('Comptes porteurs de biens raccordes, sur ce projet :')
  for (const [id, n] of Object.entries(compte).sort((a, c) => c[1] - a[1])) {
    console.error(`  --compte=${id}   (${n} bien(s))`)
  }
  console.error('\nRelancer avec --compte=<uuid>.')
  process.exit(2)
}

async function main () {
  const auj = jourLocal(new Date())
  if (!compteDemande) return decouvrir()
  // ⚠ LE COMPTE EST CHOISI PUIS TOUT EST FILTRE DESSUS. La premiere version
  // lisait `properties` pour TOUS les comptes, sans `user_id` et sans
  // pagination — en service key, donc RLS contournee (regle 1 du depot), et
  // tronque a 1000 lignes en silence. Elle prenait ensuite « le compte qui a le
  // plus de biens » : sur staging, c'est la plus grosse fixture de recette,
  // mesuree et presentee comme une preuve sur les biens reels.
  const compte = compteDemande
  // Les fiches COMPLETES du seul compte designe : `joursOuverts` depend de
  // `base_price`, `capacity`, `zone_scolaire`, `pilote_*`. ET PAGINEE : le
  // commentaire d'a cote declarait refuser la troncature silencieuse de
  // PostgREST a 1000 lignes, et cette lecture-la n'avait pas de `.range()`.
  const PAGE = 1000
  const lesSiens = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('properties').select('*')
      .eq('user_id', compte).not('provider_property_id', 'is', null)
      .order('id').range(from, from + PAGE - 1)
    if (error) { console.error('Lecture des biens impossible :', error.message); process.exit(1) }
    lesSiens.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  if (!lesSiens.length) {
    console.error(`ECHEC : aucun bien raccorde sur le compte ${compte.slice(0, 8)}.`)
    process.exit(1)
  }
  lesSiens.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  console.log(`\nBase    : ${projet}`)
  console.log(`Compte  : ${compte.slice(0, 8)}, ${lesSiens.length} bien(s) raccorde(s)`)

  const lignes = await lireReservations(sb, compte)

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
  const fenetres = positionnels[0] && positionnels[1]
    ? [{ nom: 'fenetre demandee', debut: positionnels[0], fin: positionnels[1] }]
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
      // Le MEME portefeuille eclate SANS les exclusions : seul temoin possible
      // du fait que le numerateur est net (voir l'assertion plus bas).
      const eclatementsBruts = duBien.map(x => eclater(x, { pont, defaultProvider: bien.provider }))
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
      const brut = agreger(dans(calculerIndicateurs(eclatementsBruts, { granularite: 'jour', capacites: capa, capacitePersonnes: bien.capacity })))
      const retires = A.ouverts - B.ouverts
      // ⚠ L'ECART SE MESURE SUR LE DENOMINATEUR, PAS SUR LE TAUX — releve en
      // re-review, et mon garde-fou echouait PRECISEMENT quand la correction
      // marche le mieux. Il exigeait `B.to > A.to`, donc deux taux non nuls :
      // (a) si la declaration couvre TOUS les jours ouverts, `B.ouverts` vaut
      // 0, `agreger` rend `to: null`, et le script sortait en erreur en
      // accusant le cablage de production — alors que le denominateur est passe
      // a zero exactement comme voulu, ce que `tests/api-yield.test.js` asserte
      // par ailleurs ; (b) si la fenetre n'a rien vendu en reference, les deux
      // taux valent 0 et l'ecart etait declare nul. Le temoin de la dette 78
      // est le DENOMINATEUR qui se retrecit ; le taux n'en est qu'une
      // consequence, et une consequence qui n'existe pas toujours.
      if (retires > 0) ecartsDeLaFenetre++

      // ⚠ LES ASSERTIONS, pas seulement l'affichage.
      //
      // ⚠ CE QUE L'ANCIENNE ASSERTION 1 NE POUVAIT PAS VOIR — releve en
      // re-review, et c'est un faux garde-fou de manuel. Elle comparait
      // `A.nuiteesRef` a `B.nuiteesRef` « pour verifier que seul le
      // denominateur bouge » : or `eclatements` est construit UNE fois, avec le
      // meme `exclus`, et partage par les deux calculs. Les deux numerateurs
      // etaient donc identiques PAR CONSTRUCTION, et le `ko()` ne pouvait pas
      // tirer — y compris si `eclater` et `joursOuverts` etaient cables sur des
      // ensembles d'exclusion DIFFERENTS, qui est precisement le defaut
      // `finPeriodes` que ce lot corrige. Une tolerance flottante sur deux
      // valeurs egales par construction, c'est une assertion decorative.
      //
      // Ce qui est VRAI et falsifiable : le numerateur doit etre NET. On le
      // prouve en eclatant une seconde fois SANS les exclusions — si le
      // netting disparaissait, les deux numerateurs se rejoindraient.
      if (nbExclus > 0 && !(brut.nuiteesRef >= A.nuiteesRef)) {
        ko(`${bien.name} / ${f.nom} : numerateur brut ${brut.nuiteesRef} < net ${A.nuiteesRef}`
          + ' : incoherent, le netting ne peut qu enlever des nuits')
      }
      if (retires > 0 && brut.nuiteesRef === A.nuiteesRef && A.nuiteesRef > 0) {
        ko(`${bien.name} / ${f.nom} : le numerateur n est PAS net — ${A.nuiteesRef} nuitees`
          + ' des deux cotes alors que des nuits vendues tombent dans la declaration.'
          + ' `eclater` ne marque plus `hors_reference`, et le denominateur retire seul :'
          + ' la dette 78 inversee.')
      }
      if (retires < 0) ko(`${bien.name} / ${f.nom} : ${retires} jours retires, le denominateur a GRANDI`)
      if (retires > nbExclus) {
        ko(`${bien.name} / ${f.nom} : ${retires} jours retires pour ${nbExclus} declares fermes`)
      }
      if (retires > 0 && A.to != null && B.to != null && B.to < A.to) {
        ko(`${bien.name} / ${f.nom} : le taux BAISSE (${pct(A.to)} -> ${pct(B.to)})`)
      }
      // ⚠ UNE EGALITE SUR LE COMPTEUR, UNE INEGALITE SUR LES DECLARES — et
      // c'est la correction d'un garde-fou TROP FAIBLE, relevee en re-review.
      // L'ordre `retires <= annonces <= declares` est satisfait par le compteur
      // D'AVANT le correctif : celui-la posait `annonces = tous les jours
      // COUVERTS`, donc `annonces == nbExclus`, et l'ordre tenait encore. Le
      // script aurait donc sorti « AVANT/APRES CONFORME » en code 0 avec le
      // compteur menteur rebranche — sur l'artefact que le KB cite comme preuve
      // d'ampleur et que Thierry lance sur la PRODUCTION.
      // Ce qui est vrai : le compteur annonce EXACTEMENT ce que le denominateur
      // a perdu. `retires === annonces`, et seule la comparaison aux DECLARES
      // reste une inegalite — parce que `retirerDeLaVente` ferme deja la nuit
      // au calendrier, donc un jour declare peut n'avoir rien eu a quitter.
      if (retires !== B.declaresFermes) {
        ko(`${bien.name} / ${f.nom} : ${retires} jours quittent le denominateur mais`
          + ` ${B.declaresFermes} sont annonces — le compteur ne dit pas ce qui a ete retire`)
      }
      if (B.declaresFermes > nbExclus) {
        ko(`${bien.name} / ${f.nom} : ${B.declaresFermes} annonces pour ${nbExclus} declares :`
          + ' on retire plus que ce que l hote a declare')
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
        console.log(`  → temoin : ${ecartsDeLaFenetre} bien(s) dont le DENOMINATEUR se retrecit.`)
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
  console.log('AVANT/APRES CONFORME : le numerateur est NET (prouve contre un eclatement sans')
  console.log('exclusions), le denominateur retire exactement ce que le compteur annonce, et')
  console.log('jamais plus que ce que l hote a declare.')
}

main().catch(e => { console.error('Erreur :', e.message); process.exit(1) })
