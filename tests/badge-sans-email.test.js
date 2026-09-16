// tests/badge-sans-email.test.js
// Etape 5 du chantier « canal e-mail pour les reservations directes ».
//
// LE BADGE « pas d'e-mail — messages non envoyés ».
//
// Pourquoi il existe : une reservation directe sans adresse ne recoit RIEN — ni
// confirmation, ni consignes d'arrivee, ni code d'acces. Le cron n'ecrit alors
// aucune ligne de journal et n'alerte pas : c'est un ETAT, pas une panne, et une
// alarme qui sonnerait toutes les heures sans qu'aucun geste ne la fasse taire
// est une alarme qu'on apprend a ignorer. Reste a le MONTRER la ou l'hote
// regarde la reservation — sinon il decouvre le silence le jour de l'arrivee,
// devant un voyageur sans son code.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '..', 'pages/biens-calendrier.html'), 'utf8')
const api  = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')

test('LE TEST QUI COMPTE : le serveur envoie un BOOLEEN, jamais l\'adresse', () => {
  // La fiche a besoin de savoir si les messages peuvent partir — c'est tout.
  // Faire transiter l'adresse de chaque voyageur de la fenetre pour afficher un
  // badge exposerait bien plus que le besoin, dans une reponse qui couvre des
  // mois et tous les biens du compte.
  assert.ok(/aEmail: !!s\.guestEmail/.test(api), 'un booleen derive du cœur')
  const bloc = api.split('bookings[id].push({')[1].split('})')[0]
  assert.ok(!/guestEmail:/.test(bloc), 'l\'adresse elle-meme ne part pas au client')
  assert.ok(!/guest_email/.test(bloc))
})

test('le front transporte le booleen tel quel', () => {
  assert.ok(/aEmail: b\.aEmail === true/.test(html),
    'strictement booleen : `undefined` ne doit pas passer pour « adresse presente »')
})

test('LE TEST QUI COMPTE : le badge ne s\'affiche QUE sans messagerie OTA', () => {
  // Une resa Airbnb n'a pas d'adresse non plus — la plateforme ne la communique
  // jamais — et ses messages passent tres bien par la messagerie de l'OTA. Le
  // badge y serait faux, et un badge faux apprend a ignorer les vrais.
  const fn = html.split('function badgeSansEmail(resa){')[1].split('\n    }')[0]
  assert.ok(/if\(!sansMessagerieOta\(resa\) \|\| resa\.aEmail\) return ''/.test(fn),
    'sortie sur toute resa OTA, et sur toute directe qui a une adresse')
})

test('LE TEST QUI COMPTE : la saisie directe Beds24 porte le badge, elle aussi', () => {
  // Premiere version : le badge ne regardait que `offline` (Channex CRS). Une
  // saisie directe Beds24 arrive avec `source: 'direct'`, n'a pas davantage de
  // fil (`canal-voyageur` la classe `sans_canal`), ne recoit rien — et la fiche
  // affichait « Canal : Direct » sans le moindre avertissement.
  const fn = html.split('function sansMessagerieOta(resa){')[1].split('\n    }')[0]
  assert.ok(/resa\.offline/.test(fn), 'le cas Channex CRS')
  assert.ok(/=== 'direct'/.test(fn), 'et la saisie directe Beds24')
  assert.ok(/src === ''/.test(fn), 'et une source vide, qui ne dit rien non plus')

  // La regle doit rester d'accord avec `lib/canal-voyageur.js`, qui decide
  // vraiment : si l'une change sans l'autre, la fiche ment.
  const canal = fs.readFileSync(path.join(__dirname, '..', 'lib/canal-voyageur.js'), 'utf8')
  const directes = canal.split('SOURCES_DIRECTES_BEDS24 = [')[1].split(']')[0]
  assert.ok(/'direct'/.test(directes) && /''/.test(directes),
    'le front reprend la meme liste que la decision de canal')
})

test('le badge dit la consequence, pas seulement le constat', () => {
  const fn = html.split('function badgeSansEmail(resa){')[1].split('\n    }')[0]
  assert.ok(/messages non envoyés/.test(fn), 'le constat')
  assert.ok(/confirmation/.test(fn) && /code d\\'accès/.test(fn),
    'ce qui ne partira pas, nommement')
  assert.ok(/Transmettez-les vous-même/.test(fn), 'et ce que l\'hote peut faire')
})

test('le badge est pose dans la fiche, pas seulement defini', () => {
  // Une fonction jamais appelee est un badge qui n'existe pas.
  assert.ok(/\+ badgeSansEmail\(resa\)/.test(html))
  const iDefinition = html.indexOf('function badgeSansEmail')
  const iAppel = html.indexOf('+ badgeSansEmail(resa)')
  assert.ok(iAppel > 0 && iDefinition > 0, 'les deux existent')
})

test('la saisie manuelle collecte deja l\'adresse, et la dit facultative', () => {
  // Rien a ajouter : le formulaire la porte depuis la phase 2 de la resa
  // manuelle. C'est le badge qui manquait, pas la collecte.
  assert.ok(/id="ajout-email"/.test(html))
  assert.ok(/placeholder="facultatif"/.test(html), 'optionnelle, comme decide')
  assert.ok(/mail: document\.getElementById\('ajout-email'\)/.test(html),
    'et elle part bien au provider')
})
