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

const html = fs.readFileSync(path.join(__dirname, '..', 'pages/calendrier.html'), 'utf8')
const api  = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
// Depuis le chantier calendrier mobile (30 septembre 2026), la transformation
// des reservations, la regle « sans messagerie OTA » et le texte du badge vivent
// dans le module commun aux deux ecrans.
const module_ = fs.readFileSync(path.join(__dirname, '..', 'shared/calendrier-resa.js'), 'utf8')

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
  assert.ok(/aEmail: b\.aEmail === true/.test(module_),
    'strictement booleen : `undefined` ne doit pas passer pour « adresse presente »')
})

test('LE TEST QUI COMPTE : le badge ne s\'affiche QUE sans messagerie OTA', () => {
  // Une resa Airbnb n'a pas d'adresse non plus — la plateforme ne la communique
  // jamais — et ses messages passent tres bien par la messagerie de l'OTA. Le
  // badge y serait faux, et un badge faux apprend a ignorer les vrais.
  // V5 : la page ne porte plus sa propre fonction — elle consomme la regle
  // du module (badgeSansEmailVisible), testee ci-dessus sur ses cas.
  assert.ok(/badgeSansEmailVisible\(r\) \?/.test(html),
    'le badge est conditionne par LA regle du module, pas une copie')
})

test('LE TEST QUI COMPTE : la saisie directe Beds24 porte le badge, elle aussi', () => {
  // Premiere version : le badge ne regardait que `offline` (Channex CRS). Une
  // saisie directe Beds24 arrive avec `source: 'direct'`, n'a pas davantage de
  // fil (`canal-voyageur` la classe `sans_canal`), ne recoit rien — et la fiche
  // affichait « Canal : Direct » sans le moindre avertissement.
  const fn = module_.split('export function sansMessagerieOta (resa) {')[1].split('\n}')[0]
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
  const fr = fs.readFileSync(path.join(__dirname, '..', 'shared/i18n/fr.json'), 'utf8')
  assert.ok(/messages non envoyés/.test(fr), 'le constat (cle cal.no_email)')
  assert.ok(/TEXTE_SANS_EMAIL/.test(html), 'la suite vient du module commun')
  const texte = module_.split('export const TEXTE_SANS_EMAIL = ')[1].split('\n')[0]
  assert.ok(/confirmation/.test(texte) && /code d\\'accès/.test(texte),
    'ce qui ne partira pas, nommement')
  assert.ok(/Transmettez-les vous-même/.test(texte), 'et ce que l\'hote peut faire')
})

test('le badge est pose dans la fiche, pas seulement defini', () => {
  // Une fonction jamais appelee est un badge qui n'existe pas.
  assert.ok(html.includes('badgeSansEmailVisible(r) ?'), 'appel dans la fiche')
  assert.ok(html.includes('cal.no_email'), 'et son texte')
})

test('la saisie manuelle collecte deja l\'adresse, et la dit facultative', () => {
  // Rien a ajouter : le formulaire V5 la porte. C'est le badge qui
  // manquait, pas la collecte.
  assert.ok(/data-aj="email"/.test(html))
  const fr = fs.readFileSync(path.join(__dirname, '..', 'shared/i18n/fr.json'), 'utf8')
  assert.ok(/"cal\.guest_email": "E-mail \(facultatif\)"/.test(fr), 'optionnelle, comme decide')
  assert.ok(/mail: corps\.querySelector\('\[data-aj="email"\]'\)\.value\.trim\(\) \|\| null/.test(html),
    'et elle part bien au provider')
})
