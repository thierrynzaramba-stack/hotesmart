// tests/canaux-ecran.test.js
// CE QUE L'ECRAN MONTRE DES CANAUX, ET CE QU'IL NE MONTRE PAS.
//
// ⚠ LE DEFAUT QU'ON FERME. `hydrateChannelBadges` interrogeait le partenaire
// en direct et faisait `container.remove()` des que l'appel echouait : les
// pastilles disparaissaient SANS UN MOT, et l'hote lisait « aucun canal » la
// ou il en a deux. Trois etats se confondaient en un seul — « pas pu lire »,
// « aucun canal », « canaux connus ». Ils se distinguent maintenant, et ce
// test les tient.

// `lib/canaux-du-bien.js` passe par lib/channels, qui construit un client au
// chargement : on lui donne de quoi se construire, jamais de quoi atteindre
// une base reelle.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// Le module est un module ES qui importe le client d'API : on en extrait les
// fonctions PURES, sans toucher au reste.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'properties.js'), 'utf8')
const sansImports = source
  .replace(/^\s*import\s+[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  .replace(/^\s*export\s+/gm, '')
const bac = new Function(`
  const logger = { error () {}, info () {} }
  const api = {}
  ${sansImports}
  return { canauxDuBien, fraicheurCanaux, renderChannelBadges, escapeHtml,
           hydrateChannelBadges, MOT_ECHEC, releveEnEchec, dateEnClair }
`)()
const { canauxDuBien, fraicheurCanaux, renderChannelBadges,
        hydrateChannelBadges, MOT_ECHEC, escapeHtml, releveEnEchec } = bac
// Le mot est ECHAPPE a l'affichage (il porte une apostrophe) : on le compare
// sous la forme ou il arrive vraiment dans la page.
const MOT_AFFICHE = escapeHtml(MOT_ECHEC)

// Un conteneur minimal : ce que `hydrateChannelBadges` touche reellement.
function conteneur () {
  return { innerHTML: '', retire: false, remove () { this.retire = true } }
}

// ⚠ LES REPERES DE DUREE SE CONSTRUISENT EN HEURE LOCALE, ET C'EST LE SUJET.
// Un hote lit ses dates dans SON fuseau : « hier » est un jour calendaire
// LOCAL. Des reperes ecrits en UTC rendaient ces tests dependants du fuseau de
// la machine sans que personne le sache — mesure du 19 octobre 2026 : verts en
// UTC, a Paris et a Los Angeles, DEUX ROUGES a Auckland (UTC+13), ou
// `19T09:00Z` et `19T12:00Z` ne sont pas le meme jour local.
const L = (an, mois, jour, h, min = 0) => new Date(an, mois - 1, jour, h, min)

// ─── Les trois etats, qui ne doivent jamais se confondre ────────────────────

test('LE TEST QUI COMPTE : « pas pu lire » n est pas « aucun canal »', () => {
  assert.equal(canauxDuBien({}), null, 'canaux absent devrait rendre null')
  assert.equal(canauxDuBien({ canaux: null }), null)
  assert.deepEqual(canauxDuBien({ canaux: [] }), [],
    'un bien sans canal est une REPONSE, pas une absence de reponse')
})

test('un canal actif ET mappe pour ce bien est montre comme relie', () => {
  const r = canauxDuBien({ canaux: [{ ota: 'airbnb', titre: 'X', actif: true, mappe: true }] })
  assert.equal(r[0].label, 'Airbnb')
  assert.equal(r[0].active, true)
})

test('LE TEST QUI COMPTE : un canal actif NON mappe pour ce bien n est pas relie', () => {
  // Defaut du 11 septembre 2026 : un canal Airbnb porte plusieurs logements et
  // devient actif des qu'UN seul y est mappe. Un bien neuf portait une
  // pastille verte sans aucun mapping.
  const r = canauxDuBien({ canaux: [{ ota: 'airbnb', actif: true, mappe: false }] })
  assert.equal(r[0].active, false)
})

test('une incertitude ne verdit jamais une pastille', () => {
  const r = canauxDuBien({ canaux: [{ ota: 'airbnb', actif: true, mappe: null }] })
  assert.equal(r[0].active, false, 'mappe=null (on n a pas pu conclure) a verdi')
})

test('le libelle vient de NOUS, pas de l orthographe du partenaire', () => {
  assert.equal(canauxDuBien({ canaux: [{ ota: 'airbnb' }] })[0].label, 'Airbnb')
  assert.equal(canauxDuBien({ canaux: [{ ota: 'booking' }] })[0].label, 'Booking.com')
  // Un canal inconnu garde son titre plutot que de disparaitre.
  assert.equal(canauxDuBien({ canaux: [{ ota: 'zzz', titre: 'Mon site' }] })[0].label, 'Mon site')
})

// ─── La fraicheur : l'ecran dit de quand date ce qu'il montre ───────────────

test('« verifie il y a … » suit l age du releve', () => {
  const t = L(2026, 10, 19, 12).getTime()
  assert.equal(fraicheurCanaux(L(2026, 10, 19, 11, 58).toISOString(), t).texte,
    'vérifié il y a 2 min')
  assert.equal(fraicheurCanaux(L(2026, 10, 19, 9).toISOString(), t).texte,
    'vérifié il y a 3 h')
  assert.equal(fraicheurCanaux(null, t), null)
})

test('LE TEST QUI COMPTE : au-dela de 24 h, l ecran le DIT', () => {
  // ⚠ LE ROUGE ET LE BOUTON RESTENT SUR LES 24 H ECOULEES, pas sur le
  // calendrier : c'est une mesure de fraicheur, pas une facon de parler. Le
  // TEXTE, lui, suit le calendrier (voir le test de l'echelle ci-dessous).
  const t = L(2026, 10, 19, 12).getTime()
  const f = fraicheurCanaux(L(2026, 10, 17, 11).toISOString(), t)
  assert.equal(f.vieux, true, 'un releve de plus de 24 h passe pour frais')
  assert.equal(f.texte, 'vérifié le 17 octobre')
  // Et juste en deca, il ne crie pas.
  assert.equal(fraicheurCanaux(L(2026, 10, 18, 13).toISOString(), t).vieux, false)
})

test('LE TEST QUI COMPTE : l echelle des durees — minutes, heures, hier, la date', () => {
  // ⚠ L'ECHELLE EST CELLE DE THIERRY (recette du 19 octobre 2026). La premiere
  // version comptait en jours au-dela de 24 h — « non verifie depuis 2 jours »,
  // qu'on relit mal des qu'il depasse deux, et qui ne dit pas QUAND.
  //
  // ⚠ LES REPERES SONT EN HEURE LOCALE, ET C'EST LE SUJET. Un hote lit ses
  // dates dans SON fuseau : « hier » est un jour calendaire local. Une
  // premiere version de ce test ecrivait ses reperes en UTC et rougissait sur
  // une machine en CEST — `18T23:00Z` y est le MEME jour local que
  // `19T12:00Z`. Construire les dates en local rend le test juste partout.
  const t = L(2026, 10, 19, 12).getTime()          // lundi, midi, heure locale
  const dit = (d) => fraicheurCanaux(d.toISOString(), t).texte

  assert.equal(dit(L(2026, 10, 19, 11, 59)), 'vérifié il y a 1 min')
  assert.equal(dit(L(2026, 10, 19, 11, 58)), 'vérifié il y a 2 min')
  assert.equal(dit(L(2026, 10, 19, 11, 1)), 'vérifié il y a 59 min')
  // La bascule : a 60 minutes pile on passe aux heures, et JAMAIS « 60 min ».
  assert.equal(dit(L(2026, 10, 19, 11, 0)), 'vérifié il y a 1 h')
  assert.equal(dit(L(2026, 10, 19, 9, 0)), 'vérifié il y a 3 h')
  assert.equal(dit(L(2026, 10, 19, 0, 30)), 'vérifié il y a 11 h')
  // ⚠ ET LES HEURES NE DEBORDENT PAS SUR LA VEILLE : le jour calendaire prend
  // le relais, meme a 13 heures d'ecart seulement.
  assert.equal(dit(L(2026, 10, 18, 23, 0)), 'vérifié hier')
  assert.equal(dit(L(2026, 10, 18, 1, 0)), 'vérifié hier')
  assert.equal(dit(L(2026, 10, 17, 23, 59)), 'vérifié le 17 octobre')
  assert.equal(dit(L(2026, 9, 3, 10, 0)), 'vérifié le 3 septembre')
  // ⚠ ET LE ROUGE NE SUIT PAS LE TEXTE. « hier » a 13 h d'ecart n'est pas
  // vieux ; « hier » a 27 h l'est.
  assert.equal(fraicheurCanaux(L(2026, 10, 18, 23, 0).toISOString(), t).vieux, false)
  assert.equal(fraicheurCanaux(L(2026, 10, 18, 9, 0).toISOString(), t).vieux, true)
})

test('LE TEST QUI COMPTE : la date est en toutes lettres, l annee seulement si elle differe', () => {
  // ⚠ RETOUCHE DE THIERRY : « le 17/10 » ne se lit pas pareil selon le pays, et
  // la V5 n'ecrit aucune date a la main — tout passe par `Intl`.
  const t = L(2026, 10, 19, 12).getTime()
  const dit = (d, langue) => fraicheurCanaux(d.toISOString(), t, langue).texte
  // Dans l'annee en cours : pas d'annee.
  assert.equal(dit(L(2026, 10, 17, 11), 'fr'), 'vérifié le 17 octobre')
  assert.equal(dit(L(2026, 1, 2, 11), 'fr'), 'vérifié le 2 janvier')
  // Une autre annee : elle s'affiche.
  assert.equal(dit(L(2025, 9, 3, 10), 'fr'), 'vérifié le 3 septembre 2025')
  assert.equal(dit(L(2024, 12, 31, 10), 'fr'), 'vérifié le 31 décembre 2024')
  // ⚠ ET LA LANGUE EST SUIVIE : c'est tout l'interet de passer par `Intl`.
  assert.equal(dit(L(2026, 10, 17, 11), 'en'), 'vérifié le October 17')
  assert.equal(dit(L(2026, 10, 17, 11), 'es'), 'vérifié le 17 de octubre')
  // Aucun format numerique ne doit subsister.
  for (const langue of ['fr', 'en', 'es']) {
    assert.ok(!/\d{2}\/\d{2}/.test(dit(L(2026, 10, 17, 11), langue)),
      `format numerique en ${langue}`)
  }
})

test('la date reste lisible si `Intl` refuse la langue', () => {
  // Un repli numerique vaut mieux qu'une date disparue.
  const t = L(2026, 10, 19, 12).getTime()
  const f = fraicheurCanaux(L(2026, 10, 17, 11).toISOString(), t, 'ceci-n-est-pas-une-langue')
  assert.ok(f && /vérifié le /.test(f.texte), 'la date a disparu : ' + (f && f.texte))
})

test('aucune duree ne s affiche « il y a 60 min » ni « il y a 0 h »', () => {
  // Les deux formes que l'arrondi de la premiere version pouvait produire.
  const t = Date.parse('2026-10-19T12:00:00Z')
  for (let min = 1; min <= 24 * 60; min++) {
    const f = fraicheurCanaux(new Date(t - min * 60000).toISOString(), t)
    assert.ok(f && f.texte, `pas de texte a ${min} min`)
    assert.ok(!/il y a 60 min/.test(f.texte), `« 60 min » a ${min} min`)
    assert.ok(!/il y a 0 /.test(f.texte), `« 0 » a ${min} min : ${f.texte}`)
  }
})

test('une date impossible ne fabrique pas une fraicheur', () => {
  const t = Date.parse('2026-10-19T12:00:00Z')
  assert.equal(fraicheurCanaux('pas-une-date', t), null)
  assert.equal(fraicheurCanaux('2026-10-20T12:00:00Z', t), null, 'un releve dans le futur')
})

test('le rendu echappe ce qui vient du partenaire', () => {
  const html = renderChannelBadges([{ label: '<img onerror=alert(1)>', active: true }])
  assert.ok(!html.includes('<img'), 'le titre du partenaire est injecte tel quel')
  assert.ok(html.includes('&lt;img'))
})

// ─── Ne dis pas « ce bien » quand tu parles du compte ───────────────────────

test('LE TEST QUI COMPTE : la fraicheur affichee est celle DU BIEN', () => {
  const { fraicheurDuBien } = require('../lib/canaux-du-bien')
  const vieux = '2026-10-17T08:00:00Z'
  const frais = '2026-10-19T11:55:00Z'
  const horloge = '2026-10-19T11:59:00Z'
  // Deux canaux, l'un reconfirme a l'instant, l'autre pas depuis deux jours :
  // c'est le plus ancien qui donne le ton, sinon l'ecran annonce une fraicheur
  // qu'il n'a pas.
  assert.equal(fraicheurDuBien([{ vu_le: frais }, { vu_le: vieux }], horloge), vieux)
  // ⚠ UN BIEN SANS AUCUN CANAL NE DIT RIEN (recette de Thierry, 19 octobre
  // 2026). La premiere version retombait sur l'horloge du COMPTE : l'ecran
  // affichait « verifie il y a 60 min » sous un bien qui n'a aucune pastille —
  // une date qui parle de rien.
  assert.equal(fraicheurDuBien([], horloge), null,
    'un bien sans canal affiche la date du compte')
  assert.equal(fraicheurDuBien(undefined, horloge), null)
  assert.equal(fraicheurDuBien([], null), null)
  // Mais des canaux SANS date : l'horloge est alors la seule date qui existe,
  // et elle parle bien de CES canaux-la.
  assert.equal(fraicheurDuBien([{ vu_le: null }], horloge), horloge)
  // ⚠ L'HORLOGE DU COMPTE NE DOIT PAS ECRASER LA DATE DU BIEN, meme si elle
  // est plus recente : c'est exactement le defaut qu'on ferme.
  assert.equal(fraicheurDuBien([{ vu_le: vieux }], horloge), vieux)
})

// ─── UN ECHEC SE DIT, UNE SEULE FOIS (demande de Thierry, 19 octobre 2026) ──
//
// ⚠ LE DEFAUT MESURE EN RECETTE. Un releve a echoue et l'ecran n'a rien dit :
// la date vieillissait en silence, le bouton se contentait de « Reessayer »
// sans motif, et `shared/logger.js` n'ecrit dans la console que sur localhost.
// Une heure de diagnostic pour une panne qui aurait du se lire d'un coup d'oeil.
//
// ⚠ ET UNE SEULE FOIS. Le releve est au grain du COMPTE : un seul appel couvre
// tous les biens. Le message vit donc en haut de la page, pas sous chaque carte.

test('LE TEST QUI COMPTE : un echec de compte se lit sur UN bien, donc sur le compte', () => {
  assert.equal(releveEnEchec([{ canaux_echec: false }, { canaux_echec: true }]), true)
  assert.equal(releveEnEchec([{ canaux_echec: false }, {}]), false)
  assert.equal(releveEnEchec([]), false, 'un compte sans bien ne declare pas de panne')
  assert.equal(releveEnEchec(null), false)
})

test('LE TEST QUI COMPTE : les cartes ne portent AUCUN message d echec', () => {
  // ⚠ CONTRE-EPREUVE DU DEPLACEMENT. Une premiere version mettait le mot sous
  // chaque bien : dix cartes disaient dix fois la meme panne. Si ce test
  // rougit, le message est redescendu dans les cartes.
  const c = conteneur()
  hydrateChannelBadges({
    canaux: [{ ota: 'airbnb', titre: 'T', actif: true, mappe: true }],
    canaux_vu_le: new Date(Date.now() - 2 * 3600000).toISOString(),
    canaux_echec: true
  }, c)
  assert.ok(!c.innerHTML.includes(MOT_AFFICHE), 'le message est revenu sous la carte')
  // Et ce que la carte doit montrer, elle le montre toujours.
  assert.ok(/badge-channel/.test(c.innerHTML), 'les pastilles ont disparu sur un echec')
  // ⚠ CE TEST LIT L'HORLOGE REELLE : il ne doit donc PAS affirmer une forme qui
  // depend de l'heure. « il y a 2 h » devient « hier » entre minuit et 2 h du
  // matin — mesure du 19 octobre 2026 : vert en UTC, a Paris, a Auckland et a
  // Los Angeles, ROUGE a Asia/Kolkata. L'echelle des durees a ses propres
  // tests, avec des reperes injectes ; ici on verifie seulement que la date
  // EST LA. Regle du depot : dates relatives si le test lit l'horloge.
  assert.ok(/badge-fraicheur/.test(c.innerHTML) && /vérifié/.test(c.innerHTML),
    'la date de derniere confirmation a disparu : l hote ne sait plus de quand date ce qu il voit')
  assert.equal(c.retire, false, 'le conteneur a ete supprime sur un echec')
})

test('LE TEST QUI COMPTE : le mot d echec ne nomme jamais le partenaire', () => {
  assert.ok(!/channex/i.test(MOT_ECHEC), 'le nom du partenaire est dans le message de l hote')
  assert.ok(!/beds24/i.test(MOT_ECHEC))
  assert.ok(MOT_ECHEC.length <= 45, 'le message n est plus court : ' + MOT_ECHEC.length + ' car.')
})
