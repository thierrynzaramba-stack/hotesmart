// tests/photo-bien.test.js — photo de couverture d'un bien (lot photos,
// 10 octobre 2026). Regles pures (lib/photo-bien.js) et regles verifiables de
// l'endpoint et des ecrans.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')

const { BUCKET, TAILLE_MAX, estJpeg, cheminDansBucket, nomAleatoire } = require('../lib/photo-bien')

// ─── Module pur ──────────────────────────────────────────────────────────────
test('estJpeg : le CONTENU tranche, jamais le nom', () => {
  assert.ok(estJpeg(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00])))
  assert.ok(!estJpeg(Buffer.from([0x89, 0x50, 0x4E, 0x47])), 'un PNG renomme .jpg est refuse')
  assert.ok(!estJpeg(Buffer.from([])))
  assert.ok(!estJpeg('pas un buffer'))
})

test('cheminDansBucket : seul NOTRE bucket, un seul segment, pas de traversee', () => {
  const su = 'https://exemple.supabase.co'
  const url = `${su}/storage/v1/object/public/${BUCKET}/0f3a2b1c-aaaa-bbbb-cccc-000000000000.jpg`
  assert.equal(cheminDansBucket(url, su), '0f3a2b1c-aaaa-bbbb-cccc-000000000000.jpg')
  assert.equal(cheminDansBucket('https://ailleurs.fr/photo.jpg', su), null, 'une URL etrangere n’est pas touchee')
  assert.equal(cheminDansBucket(`${su}/storage/v1/object/public/autre-bucket/x.jpg`, su), null)
  assert.equal(cheminDansBucket(`${su}/storage/v1/object/public/${BUCKET}/../x.jpg`, su), null)
  assert.equal(cheminDansBucket(`${su}/storage/v1/object/public/${BUCKET}/a/b.jpg`, su), null)
  assert.equal(cheminDansBucket(null, su), null)
})

test('nomAleatoire : l’identifiant fourni + .jpg, jamais l’id du bien', () => {
  assert.equal(nomAleatoire('abc-123'), 'abc-123.jpg')
  const api = sansCommentaires(lire('api/property-photo.js'))
  assert.ok(api.includes('crypto.randomUUID()'), 'le nom vient d’un tirage, pas du bien')
  assert.ok(!/nomAleatoire\((garde\.)?bien/.test(api), 'jamais nomme d’apres le bien')
})

test('TAILLE_MAX : 2 Mo, la meme borne que le bucket', () => {
  assert.equal(TAILLE_MAX, 2 * 1024 * 1024)
})

// ─── L’endpoint ──────────────────────────────────────────────────────────────
test('property-photo : garde reglages en ECRITURE sur le bien designe', () => {
  const api = sansCommentaires(lire('api/property-photo.js'))
  assert.ok(/domaine:\s*'reglages'/.test(api))
  assert.ok(/niveau:\s*'write'/.test(api))
  assert.ok(/bienRequis:\s*true/.test(api), 'la ressource designe le compte')
})

test('property-photo : le remplacement est une ecriture CONDITIONNELLE (course perdue = 409, fichier retire)', () => {
  const api = sansCommentaires(lire('api/property-photo.js'))
  assert.ok(/\.is\('photo_url', null\)/.test(api) && /\.eq\('photo_url', bien\.photo_url\)/.test(api),
    'la mise a jour exige la photo_url lue au depart')
  assert.ok(/status\(409\)/.test(api), 'le perdant est invite a rejouer')
})

test('le bucket est VERSIONNE : outillage de creation, et verificateur qui echoue sans lui', () => {
  const outil = lire('scripts/creer-bucket-photos.js')
  assert.ok(outil.includes("createBucket('property-photos'") && outil.includes('public: true'))
  assert.ok(outil.includes('updateBucket'), 'un bucket cree a la main prive est remis en conformite')
  const verif = lire('scripts/verifier-migration-photo-url.js')
  assert.ok(verif.includes('process.exit(2)') && verif.includes('ABSENT'), 'bucket absent = ECHEC, pas une remarque')
})

test('property-photo : l’ancien fichier n’est efface qu’APRES le succes', () => {
  const api = sansCommentaires(lire('api/property-photo.js'))
  const iMaj = api.indexOf('update({ photo_url')
  const iDel = api.indexOf('cheminDansBucket(bien.photo_url')
  assert.ok(iMaj > 0 && iDel > iMaj, 'l’effacement vient apres l’ecriture de photo_url')
  assert.ok(api.includes('upsert: false'), 'jamais d’ecrasement d’un fichier existant')
})

// ─── Les ecrans ──────────────────────────────────────────────────────────────
test('biens : la zone photo suit la charte V5 et le droit d’ecriture', () => {
  const html = lire('pages/biens.html')
  assert.ok(html.includes('/shared/theme.css'), 'les jetons V5 sont charges')
  assert.ok(html.includes("peutEcrire('reglages')"), 'le declencheur est retire sans le droit')
  assert.ok(html.includes("ic('i-photo')") && html.includes('icons.svg#${id}'), 'icone du sprite, pas dessinee')
  const bloc = html.slice(html.indexOf('Photo de couverture (lot photos'), html.indexOf('.photo-bien__etat'))
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(bloc), 'aucun hexa dans les styles de la zone photo')
  for (const k of ['photo.add', 'photo.replace', 'photo.sending', 'photo.too_big', 'photo.failed']) {
    assert.ok(html.includes(`'${k}'`), `cle ${k} utilisee`)
  }
  assert.ok(/fetch\('\/api\/property-photo'[\s\S]{0,300}enteteCompte\(\)/.test(html), 'X-Compte pose')
})

test('biens : un envoi rate restaure l’etat d’avant et montre son motif', () => {
  const html = sansCommentaires(lire('pages/biens.html'))
  assert.ok(html.includes('const htmlAvant = zone.innerHTML'), 'l’etat de depart est garde')
  assert.ok(/catch \(err\)[\s\S]{0,400}zone\.innerHTML = htmlAvant/.test(html), 'l’apercu ne survit pas a un echec')
  assert.ok(/zone\.innerHTML = htmlAvant[\s\S]{0,200}poserEtat\(/.test(html), 'le motif se pose APRES la restauration, jamais sur un noeud detache')
  assert.ok(html.includes('!session || !session.access_token'), 'session expiree = message propre, pas un TypeError')
  // theme.css se charge AVANT style.css : --border et --amber restent ceux de la page.
  const iTheme = html.indexOf('/shared/theme.css'), iStyle = html.indexOf('/public/style.css')
  assert.ok(iTheme > 0 && iTheme < iStyle, 'theme.css avant style.css (sinon la page entiere est re-peinte)')
})

test('les cles photo.* existent dans les trois langues', () => {
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of ['photo.add', 'photo.replace', 'photo.sending', 'photo.bad_type', 'photo.too_big', 'photo.failed']) {
      assert.ok(k in d, `${l} : ${k} manquante`)
    }
  }
})

test('la liste et la fiche des logements affichent photo_url, le fond neutre sinon', () => {
  // ⚠ CE TEST VISAIT L'ACCUEIL, ET LES CARTES DE LOGEMENT L'ONT QUITTE A
  // L'ETAPE 4 du lot « Aujourd'hui V5 » : le bloc « Vos logements » est
  // remplace par « Revenus nets », et les cartes vivent sur /logements, qui les
  // rend mieux (photo, note, occupation, prochaine arrivee). Inventaire I25.
  //
  // ⚠ ET LA REGLE N'EST PAS PERDUE, VERIFIE AVANT DE DEPLACER CE TEST : la
  // photo est rendue par `shared/logements-liste.js` l 431 (la liste) et
  // `shared/logement-fiche.js` l 313 (la fiche), dans les deux cas avec l'URL
  // ECHAPPEE et un repli quand elle manque. C'est la que le test la garde
  // desormais — deplacer un test sans verifier que sa regle a suivi serait
  // retirer un garde-fou en croyant le ranger.
  // ⚠ SUR LA SOURCE BRUTE, PAS SUR `sansCommentaires`, ET C'EST MESURE : sur
  // `shared/logement-fiche.js`, ce nettoyage avale le bloc qui porte le
  // ternaire (son motif `/\*[\s\S]*?\*\//` traverse le fichier). Le motif
  // cherche n'apparait dans aucun commentaire du depot, donc le nettoyage
  // n'apporte rien ici — et il faisait rougir un fichier conforme.
  for (const f of ['shared/logements-liste.js', 'shared/logement-fiche.js']) {
    const src = lire(f)
    assert.ok(src.includes('photo_url'), `${f} : la colonne n est pas lue`)
    assert.ok(/\.photo_url\s*\n?\s*\?/.test(src), `${f} : photo affichee sans verifier qu elle existe`)
    assert.ok(/img src="\$\{esc\([a-z]+\.photo_url\)\}"/.test(src),
      `${f} : l URL de la photo n est pas echappee`)
  }
  // Le repli visuel : un fond neutre, pas une image cassee.
  assert.ok(lire('shared/logements-liste.js').includes('log-photo'),
    'la liste n a plus de repli visuel pour un bien sans photo')

  // ⚠ ET L'ACCUEIL N'EN PARLE PLUS DU TOUT : si `photo_url` y revenait, ce
  // serait une carte de logement remise, donc le bloc « Vos logements » qui
  // repousse — et le lien vers /logements qui fait doublon.
  assert.ok(!sansCommentaires(lire('pages/aujourdhui.html')).includes('photo_url'),
    'l accueil lit de nouveau photo_url : une carte de logement y est revenue')
})

test('channel-property expose photo_url (la liste des biens de /biens)', () => {
  assert.ok(lire('api/channel-property.js').includes('photo_url'))
})
