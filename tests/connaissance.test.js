// tests/connaissance.test.js — les règles de la base de connaissance V5 (lot 3).
//
// ⚠ CES TESTS APPELLENT LES FONCTIONS. Les règles d'écran (« à revoir après
// 90 jours », « À remplir en rouge », « jamais d'accolades sous les yeux de
// l'hôte ») vivent dans un module précisément pour être mesurées ici : écrites
// dans le balisage, elles seraient invisibles d'un test et recopiées au premier
// second écran — et la V5 en a deux, l'ordinateur et le téléphone.

const test = require('node:test')
const assert = require('node:assert')
const { JOURS_A_REVOIR, aRevoir, joursDepuis, enEtiquettes, carte, faits } = require('../lib/connaissance')

// ⚠ L'INSTANT EST INJECTÉ : ces fonctions lisent l'horloge. Des dates figées
// sans temps injecté rendraient ces tests faux dans trois mois.
const MAINTENANT = new Date('2026-11-04T12:00:00Z')
const ilY = (jours) => new Date(MAINTENANT.getTime() - jours * 86400000).toISOString()

test('LE TEST QUI COMPTE : « jamais vérifiée » n’est PAS « à revoir »', () => {
  // ⚠ SI ON LES CONFOND, l'écran est entièrement ambre le jour du déploiement —
  // aucune entrée existante n'a de date — et l'ambre ne vaut que s'il est rare :
  // la charte V5 n'en autorise qu'un par écran.
  assert.equal(aRevoir(null, MAINTENANT), false)
  assert.equal(aRevoir(undefined, MAINTENANT), false)
  assert.equal(aRevoir('pas une date', MAINTENANT), false)
  assert.equal(joursDepuis(null, MAINTENANT), null, 'et on ne lui invente pas un âge')
})

test('LE TEST QUI COMPTE : le seuil est à 90 jours, et il MORD au bon endroit', () => {
  assert.equal(aRevoir(ilY(JOURS_A_REVOIR - 1), MAINTENANT), false, '89 jours : non')
  assert.equal(aRevoir(ilY(JOURS_A_REVOIR), MAINTENANT), false, '90 jours pile : non')
  assert.equal(aRevoir(ilY(JOURS_A_REVOIR + 1), MAINTENANT), true, '91 jours : oui')
  // ⚠ LE CAS MESURÉ QUI A FONDÉ LE SEUIL : le prix du champagne annoncé par
  // l'IA avait 106 jours. Le badge doit mordre, et 16 jours plus tôt.
  assert.equal(aRevoir(ilY(106), MAINTENANT), true)
  assert.equal(joursDepuis(ilY(106), MAINTENANT), 106)
})

test('LE TEST QUI COMPTE : l’écran ne montre JAMAIS d’accolades', () => {
  // Direction validée du 3 novembre 2026 : les balises apparaissent en
  // étiquettes lisibles, jamais en `{…}`.
  const { rendu, balises } = enEtiquettes(
    'Bonjour {prenom}, le wifi est {wifi_nom} / {wifi_mdp}.', { wifi_nom: 'RESEAU' })
  assert.ok(!/\{prenom\}|\{wifi_nom\}|\{wifi_mdp\}/.test(rendu), 'aucune accolade connue ne survit')
  assert.match(rendu, /Prénom/)
  assert.match(rendu, /Nom wifi/)
  assert.match(rendu, /Mot de passe wifi/)
  // ⚠ ET UNE BALISE VIDE SE SIGNALE : c'est elle qui s'affichera en ROUGE, et
  // qui bloquera l'envoi au lot 4.
  const mdp = balises.find(b => b.cle === 'wifi_mdp')
  assert.equal(mdp.vide, true, 'le mot de passe n’a pas de valeur : vide')
  assert.equal(balises.find(b => b.cle === 'wifi_nom').vide, false)
})

test('une balise INCONNUE reste telle quelle, et se signale comme inconnue', () => {
  // On ne lui invente pas d'étiquette : l'hôte doit voir ce qu'il a écrit pour
  // pouvoir le corriger. C'est la leçon de « une variable inconnue se corrige
  // dans le MODÈLE ».
  const { rendu, balises } = enEtiquettes('Bonjour {code_promo}', {})
  assert.match(rendu, /\{code_promo\}/)
  assert.equal(balises[0].connue, false)
})

test('LE TEST QUI COMPTE : « Hors IA » ne s’allume que sur un FAUX explicite', () => {
  // ⚠ LA COLONNE PEUT ÊTRE ABSENTE tant que la migration n'est pas passée :
  // l'absence vaut le comportement d'aujourd'hui (l'IA lit tout), jamais
  // l'inverse — sinon le déploiement couperait l'agent sur toute la base.
  assert.equal(carte({ id: 1, key: 'x', value: 'y' }, { maintenant: MAINTENANT }).horsIa, false)
  assert.equal(carte({ lisible_par_ia: true }, { maintenant: MAINTENANT }).horsIa, false)
  assert.equal(carte({ lisible_par_ia: null }, { maintenant: MAINTENANT }).horsIa, false)
  assert.equal(carte({ lisible_par_ia: undefined }, { maintenant: MAINTENANT }).horsIa, false)
  assert.equal(carte({ lisible_par_ia: false }, { maintenant: MAINTENANT }).horsIa, true)
})

test('LE TEST QUI COMPTE : une valeur vide se dit « à remplir », jamais un blanc', () => {
  const lignes = [
    { type: 'fixed', key: 'telephone_hote', value: '0600000000' },
    { type: 'fixed', key: 'wifi_nom', value: '   ' },
    { type: 'faq', key: 'Parking', value: 'gratuit' }
  ]
  const f = faits(lignes, { maintenant: MAINTENANT })
  const tel = f.find(x => x.cle === 'telephone_hote')
  const wifi = f.find(x => x.cle === 'wifi_nom')
  assert.equal(tel.aRemplir, false)
  assert.equal(wifi.aRemplir, true, 'une valeur d’espaces est vide')
  assert.equal(f.find(x => x.cle === 'adresse').aRemplir, true, 'une clé absente est à remplir')
  // Les six faits de la maquette sont là, dans l'ordre, même absents de la base.
  assert.deepEqual(f.slice(0, 6).map(x => x.cle),
    ['telephone_hote', 'adresse', 'checkin', 'checkout', 'wifi_nom', 'wifi_mdp'])
  // Et une réponse rédigée n'est pas un fait.
  assert.ok(!f.some(x => x.cle === 'Parking'))
})

test('une clé sans balise se signale : aucun message ne peut l’insérer', () => {
  // Elle n'existe que pour l'IA, qui lit la base entière. C'est licite, mais ça
  // se sait — sinon l'hôte croit pouvoir s'en servir dans un modèle.
  const f = faits([{ type: 'fixed', key: 'equip_nombre_lits', value: 'deux lits' }],
    { maintenant: MAINTENANT })
  const x = f.find(y => y.cle === 'equip_nombre_lits')
  assert.equal(x.sansBalise, true)
  assert.equal(x.balise, null)
  assert.equal(f.find(y => y.cle === 'telephone_hote').sansBalise, false)
})

test('la carte porte les trois états, et l’âge est un nombre de jours', () => {
  const c = carte({ id: 7, key: 'Parking', value: 'Bonjour {prenom}', verifie_le: ilY(100) },
    { maintenant: MAINTENANT })
  assert.equal(c.sujet, 'Parking')
  assert.match(c.texte, /Prénom/)
  assert.equal(c.jours, 100)
  assert.equal(c.aRevoir, true)
  const neuve = carte({ id: 8, key: 'Wifi', value: 'x', verifie_le: ilY(2) }, { maintenant: MAINTENANT })
  assert.equal(neuve.aRevoir, false)
  assert.equal(neuve.jours, 2)
})

test('LE TEST QUI COMPTE : les segments disent à l’écran où poser chaque étiquette, et rien d’autre', () => {
  // ⚠ C'EST L'ÉCRAN QUI LES PEINT, ET IL NE RE-DÉCOUPE RIEN : sans eux, chaque
  // écran referait l'analyse du texte de son côté — une seconde copie de la
  // règle, dans le navigateur.
  const { segments } = enEtiquettes('Bonjour {prenom}, code {code_promo} wifi {wifi_mdp}.', { wifi_mdp: '' })
  assert.deepEqual(segments, [
    { texte: 'Bonjour ' },
    { cle: 'prenom', libelle: 'Prénom', vide: false },
    // Une balise INCONNUE reste du texte, accolades comprises, collée à ses voisins.
    { texte: ', code {code_promo} wifi ' },
    { cle: 'wifi_mdp', libelle: 'Mot de passe wifi', vide: true },
    { texte: '.' }
  ])
  // Recoller les segments rend le texte d'origine : rien n'est perdu.
  const recolle = segments.map(s => (s.cle ? `{${s.cle}}` : s.texte)).join('')
  assert.equal(recolle, 'Bonjour {prenom}, code {code_promo} wifi {wifi_mdp}.')
  assert.deepEqual(enEtiquettes('', {}).segments, [])
  assert.deepEqual(enEtiquettes(null, {}).segments, [])
})

test('la carte porte le texte BRUT pour l’éditeur, et les segments pour l’affichage', () => {
  const c = carte({ id: 3, key: 'Arrivée', value: 'Dès {checkin}' }, { connaissance: { checkin: '17:00' } })
  assert.equal(c.brut, 'Dès {checkin}')
  assert.deepEqual(c.segments, [{ texte: 'Dès ' }, { cle: 'checkin', libelle: "Heure d'arrivée", vide: false }])
})

test('LE TEST QUI COMPTE : un horaire sans valeur n’est PAS un trou — il a un défaut', () => {
  // ⚠ CONSTAT MESURÉ DE REVIEW : `{checkin}` vide sortait `vide: true` alors que
  // le remplaceur rend « 18:00 » sans rien mettre dans `manquants`. L'écran
  // annonçait un manque que le voyageur ne verra jamais — et le lot 4 aurait
  // bloqué l'envoi dessus. La règle suit le remplaceur : on le vérifie EN
  // L'APPELANT, pour chaque balise de la base.
  const { remplacerBalises, DE_LA_BASE } = require('../lib/balises')
  for (const cle of DE_LA_BASE) {
    const r = remplacerBalises(`x {${cle}} y`, { reservation: {}, connaissance: {} })
    const { segments } = enEtiquettes(`x {${cle}} y`, {})
    assert.equal(segments[1].vide, r.manquants.includes(cle), `${cle} : l’écran et le remplaceur disent la même chose`)
  }
  const f = faits([], { maintenant: MAINTENANT })
  const checkin = f.find(x => x.cle === 'checkin')
  assert.equal(checkin.aRemplir, false)
  assert.equal(checkin.defaut, '18:00')
  assert.equal(f.find(x => x.cle === 'wifi_mdp').aRemplir, true, 'sans défaut, une absence reste à remplir')
})
