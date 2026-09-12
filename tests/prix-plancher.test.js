// tests/prix-plancher.test.js
// LE DEFAUT QU'ILS FERMENT : une nuit vendue a 0 €.
// Signale par Thierry le 12 septembre 2026, sur ses biens reels.
//
// ⚠ `rate: 0` EST LE PIRE CAS PARCE QU'IL NE FAIT RIEN DE VISIBLE.
// Channex ne rejette pas 0 : il l'ignore et garde le prix de la GRILLE. La
// nuit se vend donc au tarif par defaut du rate plan — un prix que l'hote n'a
// jamais choisi — sans qu'aucune erreur ne se declenche.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  PLANCHER_GLOBAL_CENTIMES, plancherDuBien, tarifAcceptable, messageRefus
} = require('../lib/yield/prix-plancher')

test('le plancher est PAR BIEN, avec repli sur le plancher global', () => {
  assert.equal(plancherDuBien({ prix_minimum: 5000 }), 5000, 'le reglage du bien prime')
  assert.equal(plancherDuBien({ prix_minimum: null }), PLANCHER_GLOBAL_CENTIMES)
  assert.equal(plancherDuBien({}), PLANCHER_GLOBAL_CENTIMES, 'colonne absente')
  assert.equal(plancherDuBien(null), PLANCHER_GLOBAL_CENTIMES)
  assert.equal(plancherDuBien({ prix_minimum: 0 }), PLANCHER_GLOBAL_CENTIMES, '0 n est pas un plancher')
  assert.equal(plancherDuBien({ prix_minimum: 'abc' }), PLANCHER_GLOBAL_CENTIMES)
})

test('LE TEST QUI COMPTE : zero a sa propre raison', () => {
  // Parce que c'est le cas que le canal ignore en silence : il se voit le
  // moins et coute le plus.
  const bien = { prix_minimum: 3000 }
  assert.deepEqual(tarifAcceptable(0, bien), { ok: false, raison: 'zero', plancher: 3000 })
  assert.deepEqual(tarifAcceptable(-100, bien), { ok: false, raison: 'negatif', plancher: 3000 })
  assert.deepEqual(tarifAcceptable(2999, bien), { ok: false, raison: 'sous_plancher', plancher: 3000 })
  assert.deepEqual(tarifAcceptable(3000, bien), { ok: true, raison: null, plancher: 3000 },
    'le plancher lui-meme est ACCEPTE : c est un minimum, pas une exclusion')
  assert.deepEqual(tarifAcceptable(12000, bien), { ok: true, raison: null, plancher: 3000 })
  assert.equal(tarifAcceptable(NaN, bien).raison, 'non_numerique')
  assert.equal(tarifAcceptable(undefined, bien).raison, 'non_numerique')
})

test('un bien sans plancher propre refuse quand meme l absurde', () => {
  assert.equal(tarifAcceptable(0, {}).ok, false)
  assert.equal(tarifAcceptable(500, {}).ok, false, '5 € : personne ne vend a ce prix par choix')
  assert.equal(tarifAcceptable(2500, {}).ok, true, '25 € : bas mais legitime, on ne l empeche pas')
})

test('LE TEST QUI COMPTE : le message dit la VERITE selon le contexte', () => {
  // ⚠ CAS REEL DU 12 SEPTEMBRE 2026. Thierry saisit 100 € sur un bien dont le
  // plancher est 130 €. La garde fonctionne, rien n'est ecrit — mais le
  // message annonçait « ces dates sont fermees », ce qui est FAUX au
  // calendrier : on refuse la saisie sans rien fermer ni ecrire. Il a compris
  // l'inverse de ce qui s'etait passe.
  const saisie = messageRefus('sous_plancher', 10000, 13000, 1, 'saisie')
  assert.ok(/NON enregistre/i.test(saisie), 'dit que RIEN n a ete enregistre')
  assert.ok(/tarif precedent reste en place/i.test(saisie), 'et ce qui reste en vigueur')
  assert.ok(!/ferm/i.test(saisie), 'ne parle PAS de fermeture : rien n est ferme')
  assert.ok(saisie.includes('130,00') && saisie.includes('100,00'), 'plancher ET tarif refuse')
  assert.ok(/baissez le plancher/i.test(saisie), 'et comment s en sortir')

  // Au full sync, en revanche, la date EST fermee : le message doit le dire.
  const poussee = messageRefus('sous_plancher', 500, 3000, 4, 'poussee')
  assert.ok(/FERMEES/.test(poussee))
  assert.ok(poussee.includes('4 nuits'))

  // Accords : « 1 nuit est », « 4 nuits sont ».
  assert.ok(/1 nuit est concernee/.test(saisie))
  assert.ok(/4 nuits sont FERMEES/.test(poussee))

  const z = messageRefus('zero', 0, 3000, 3, 'saisie')
  assert.ok(/tarif par defaut/i.test(z), 'explique POURQUOI 0 est dangereux')
  assert.ok(/3 nuits sont concernees/.test(z))
})

test('LE TEST QUI COMPTE : le message lisible va dans `error`, pas dans `message`', () => {
  // ⚠ `shared/api-client.js` construit son exception avec `data.error` — PAS
  // avec `data.message`. Mettre le code technique dans `error` affichait
  // « prix_sous_plancher » a l'hote, et l'explication restait dans un champ
  // que personne ne lit. C'est ce qui a fait croire a Thierry que sa saisie
  // avait abouti.
  const cal = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
  const bloc = cal.slice(cal.indexOf('prix_sous_plancher') - 800, cal.indexOf('prix_sous_plancher') + 400)
  assert.ok(/error: messageRefus\(/.test(bloc),
    'le message LISIBLE est dans `error`, le champ que le front affiche')
  assert.ok(/code: 'prix_sous_plancher'/.test(bloc),
    'et le code technique dans `code`, pour le code appelant')

  // Le client lit bien `data.error` : si cela change, ce test doit le voir.
  const client = fs.readFileSync(path.join(__dirname, '..', 'shared/api-client.js'), 'utf8')
  assert.ok(/new Error\(data\.error \|\|/.test(client),
    'api-client construit son erreur depuis data.error')
})

test('LE TEST QUI COMPTE : les deux chemins de poussee appliquent la garde', () => {
  // Un garde-fou branche sur un seul chemin ne protege rien : le full sync
  // 500 jours et le calendrier poussent tous deux des tarifs.
  const fullsync = fs.readFileSync(path.join(__dirname, '..', 'lib/channel-fullsync.js'), 'utf8')
  assert.ok(/tarifAcceptable\(/.test(fullsync), 'le full sync verifie le plancher')
  assert.ok(/sousPlancher/.test(fullsync))
  assert.ok(/reportIncident\('prix_sous_plancher'/.test(fullsync), 'et alerte l hote')

  const cal = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
  assert.ok(/tarifAcceptable\(cents, bien\)/.test(cal), 'le calendrier aussi')
  // ⚠ LE CALENDRIER REFUSE, IL NE FERME PAS — et c'est tout le correctif.
  // Fermer la date dans la charge ARI ne protegeait RIEN : l'upsert de
  // `calendar_inventory` a lieu AVANT, la memoire d'intention restait a
  // `false`, et `reaffirmerStopSell` rouvrait la date dans la meme requete.
  // La nuit se vendait au prix de la grille pendant que l'ecran affichait
  // « fermee ».
  // Le code technique a migre de `error` vers `code` : c'est `error` qui porte
  // desormais le message lisible, seul champ que le front affiche.
  assert.ok(/code: 'prix_sous_plancher'/.test(cal), 'il rend 400 avec son code')
  assert.ok(/res\.status\(400\)/.test(cal))
  assert.ok(!/refusesPlancher/.test(cal), 'plus de fermeture dans la charge ARI')
})

test('on FERME la date, on ne corrige jamais le prix', () => {
  // Remonter un prix au plancher inventerait un tarif que l hote n a pas
  // decide, et le vendrait en son nom.
  // ⚠ ASSERTION PRECISE : la premiere version cherchait `= plancher`, qui
  // attrapait `const plancher = plancherDuBien(bien)` — une affectation de
  // variable, pas une correction de tarif. Un test qui echoue sur du code
  // correct apprend a etre ignore.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/yield/prix-plancher.js'), 'utf8')
  assert.ok(!/(rate|rateCents|prix\w*)\s*=\s*plancher|Math\.max\(\s*(rate|prix)/i.test(src),
    'aucune remontee du tarif au plancher')
  // Le module ne rend qu'un VERDICT : il n'a aucun moyen de modifier un prix.
  assert.ok(/return \{ ok: (true|false)/.test(src), 'il rend un verdict, pas un tarif')
  const fullsync = fs.readFileSync(path.join(__dirname, '..', 'lib/channel-fullsync.js'), 'utf8')
  assert.ok(/if \(prixEur === null \|\| refusPlancher\) \{/.test(fullsync),
    'le full sync traite le refus comme une absence de prix')
})

test('la colonne est selectionnee partout ou le plancher est lu', () => {
  // ⚠ LE PIEGE DE LA COLONNE OUBLIEE, paye quatre fois dans ce depot :
  // `prix_minimum` non selectionne vaut `undefined`, donc « pas de plancher
  // propre », donc TOUS les biens retombent sur le plancher global sans que
  // rien ne le signale — et le reglage de l hote est ignore en silence.
  // ⚠ LA LISTE EST DERIVEE, PAS RECOPIEE : tout fichier qui appelle
  // `runFullSync` ou `pousserAri` lit un plancher. La premiere version en
  // listait trois et donnait un faux vert — `api/migration.js`, qui pousse
  // l'ARI 500 jours de la bascule, n'en faisait pas partie.
  const racine = path.join(__dirname, '..')
  const appelants = []
  for (const dossier of ['lib', 'api']) {
    for (const f of fs.readdirSync(path.join(racine, dossier))) {
      if (!f.endsWith('.js')) continue
      const rel = `${dossier}/${f}`
      const src = fs.readFileSync(path.join(racine, rel), 'utf8')
      // Ceux qui LISENT un bien en base pour le pousser ensuite.
      // `from('properties')` seul ne suffit pas : un module qui n'y fait qu'un
      // UPDATE (lib/migration-mode-prix.js) ne lit aucun plancher — c'est son
      // appelant qui le selectionne. On cible ceux qui LISENT un bien.
      const litUnBien = /from\('properties'\)[\s\S]{0,200}\.select\(/.test(src) ||
        /\.select\(COLS\)/.test(src)
      if (/runFullSync\(|pousserAri\(/.test(src) && litUnBien) appelants.push(rel)
    }
  }
  assert.ok(appelants.length >= 3, `au moins 3 appelants attendus, trouve ${appelants.length}`)
  const oublis = appelants.filter(f =>
    !/prix_minimum/.test(fs.readFileSync(path.join(racine, f), 'utf8')))
  assert.deepEqual(oublis, [],
    `ces fichiers poussent l ARI sans selectionner prix_minimum : ${oublis.join(', ')}`)
})

test('l endpoint accepte le reglage, et le valide', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/channel-property.js'), 'utf8')
  assert.ok(/prix_minimum !== undefined/.test(src))
  assert.ok(/prix_minimum invalide/.test(src), 'une valeur absurde est refusee en 400')
  assert.ok(/updates\.prix_minimum = null/.test(src), 'null est une valeur legitime : pas de plancher propre')
  // Ce n'est pas un tarif : aucune poussee provider ne doit en decouler.
  const bloc = src.slice(src.indexOf('prix_minimum !== undefined'), src.indexOf('prix_minimum !== undefined') + 700)
  assert.ok(!/channelCall/.test(bloc), 'le plancher ne touche ni la grille ni l ARI')
})

test('un plancher au-dessus du prix de base est REFUSE', () => {
  // Rien n empechait un plancher a 120 € sur un bien a 80 € : le PATCH rendait
  // 200, puis le full sync fermait les 500 jours. L hote decouvrait son
  // logement invendable sans lien avec sa saisie.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/channel-property.js'), 'utf8')
  assert.ok(/plancher_au_dessus_du_prix_de_base/.test(src))
  assert.ok(/cents > Math\.round\(baseActuelle \* 100\)/.test(src),
    'comparaison en centimes des deux cotes')
  assert.ok(/base_price !== undefined \? Number\(base_price\) : Number\(prop\.base_price\)/.test(src),
    'compare au prix de base ENVOYE dans la meme requete, sinon a celui en base')
})

test('les dates sous plancher ne sont pas comptees comme tarifees', () => {
  // Un bien dont le prix de base passe sous le plancher affichait
  // « 500 dates tarifees » alors que zero tarif part — dans l apercu que
  // l operateur de bascule lit AVANT de pousser pour de vrai.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/channel-fullsync.js'), 'utf8')
  const occurrences = src.match(/dates_tarifees: 500 - fermeesSansPrix\.length - sousPlancher\.length/g)
  assert.equal(occurrences?.length, 2, 'apercu ET poussee reelle comptent pareil')
  assert.ok(!/dates_tarifees: 500 - fermeesSansPrix\.length,/.test(src),
    'plus aucun compte qui ignore le plancher')
})

test('l alerte dit que le tarif RESTE dans le calendrier', () => {
  // Le refus n ecrit rien dans `calendar_inventory` : la valeur fautive y
  // reste, et l alerte reviendra a chaque synchronisation tant que l hote ne
  // l a pas corrigee. Le lui cacher ferait passer une alerte recurrente pour
  // un bug.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/channel-fullsync.js'), 'utf8')
  assert.ok(/LE TARIF RESTE DANS LE CALENDRIER/.test(src))
  assert.ok(/cette alerte reviendra/.test(src))
})

test('LE TEST QUI COMPTE : « pas de prix » ne s affiche jamais « 0 »', () => {
  // ⚠ SIGNALE PAR THIERRY LE 12 SEPTEMBRE 2026 : « j'ai des nuits a 0 sur
  // Ofuro ». Verification en base : AUCUNE nuit a zero. 966 nuits sans tarif
  // (`rate = NULL`), toutes fermees (`stop_sell`, `avail = 0`), donc
  // invendables — et zero nuit ouverte sans prix.
  //
  // Le calendrier mobile faisait `Number(currentBien.base_price) || 0` : sur un
  // bien sans prix de base, `null` devenait 0 et l'ecran affichait « 0 € ».
  // Zero est un PRIX — et le pire, puisque le canal ne l'applique pas et vend
  // au tarif de la grille. L'absence de prix est un ETAT : la nuit est fermee.
  // Les confondre a fait craindre a l'hote de brader son logement.
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'pages/calendrier-mobile.html'), 'utf8')
  assert.ok(!/Number\(currentBien\.base_price\)\|\|0|Number\(currentBien\.base_price\) \|\| 0/.test(mobile),
    'plus de `|| 0` qui fabrique un prix a zero')
  assert.ok(/return \(b>0\)\?b:null/.test(mobile), 'sans prix de base, on rend null')
  assert.ok(/function afficherTarif\(v,sym\)\{ return v==null \? '—'/.test(mobile),
    'et l affichage montre « — »')
  // Les calculs, eux, ont besoin d un nombre : ils passent par rateCalcul.
  assert.ok(/function rateCalcul\(iso\)/.test(mobile))
  assert.ok(!/computeFinal\(rateFor\(/.test(mobile),
    'aucun calcul ne part de rateFor, qui peut valoir null')

  const grille = fs.readFileSync(path.join(__dirname, '..', 'pages/biens-calendrier.html'), 'utf8')
  assert.ok(/s\.rate == null \? '—'/.test(grille), 'meme regle dans la grille')

  const core = fs.readFileSync(path.join(__dirname, '..', 'shared/calendar-core.js'), 'utf8')
  assert.ok(/sansPrix: rate == null/.test(core),
    'l etat porte explicitement « sans prix », pour que les vues n aient pas a deviner')
})

test('LE TEST QUI COMPTE : tarifer une nuit fermee la ROUVRE chez le canal', () => {
  // ⚠ DEFAUT MESURE LE 12 SEPTEMBRE 2026, SIGNALE PAR THIERRY.
  // Il tarife le 5 au 8 octobre a 199 € sur des nuits fermees. Le coeur
  // enregistre `stop_sell = false` — l'intention est « ouvert » — et le tarif
  // part bien. Mais `availability` n'etait poussee QUE pour les dates portant
  // un `seg.avail` explicite : ces quatre-la n'en avaient pas, donc rien ne
  // partait et elles restaient a `availability: 0` chez Channex.
  // Mesure : les 4 dates a 0, leurs voisines (4 et 9 octobre) a 1.
  // Des nuits TARIFEES et INVENDABLES, et un hote convaincu de les avoir
  // ouvertes — la symetrie de l'incident du 11 septembre, par l'autre bout.
  const cal = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
  assert.ok(/OUVRIR, C'EST AUSSI REPOUSSER LA DISPONIBILITE/.test(cal))
  assert.ok(/for \(const ds of Object\.keys\(restByDate\)\)/.test(cal),
    'toute date TOUCHEE est consideree, pas seulement celles portant un avail')
  assert.ok(/if \(availByDate\[ds\] != null\) continue/.test(cal),
    'un choix explicite de l hote n est jamais ecrase')
  assert.ok(/if \(!etat \|\| etat\.stop_sell === true\) continue/.test(cal),
    'une nuit FERMEE n est jamais rouverte')
  assert.ok(/if \(etat\.avail === 0\) continue/.test(cal),
    'ni une fermeture explicite deja en base')

  // ⚠ L'ORDRE COMPTE : le complement doit precede le calcul de `datesAvail`,
  // sinon les dates ajoutees ne partent pas — c'est l'erreur que j'ai faite en
  // ecrivant ce correctif.
  const posComplement = cal.indexOf("OUVRIR, C'EST AUSSI REPOUSSER")
  const posDates = cal.indexOf('const datesAvail = Object.keys(availByDate).sort()')
  assert.ok(posComplement > 0 && posComplement < posDates,
    'le complement doit s appliquer AVANT que datesAvail ne soit fige')

  // Et le plafonnement par le stock reste en aval : c'est lui qui protege de
  // la surreservation, il ne doit pas etre contourne.
  const posPlafond = cal.indexOf('const stock = Math.max(0, unites -')
  assert.ok(posPlafond > posComplement,
    'le plafonnement par nuits vendues passe APRES le complement')
})
