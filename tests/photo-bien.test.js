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

test('property-photo : l’ancien fichier n’est efface qu’APRES le succes', () => {
  const api = sansCommentaires(lire('api/property-photo.js'))
  const iMaj = api.indexOf("update({ photo_url")
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

test('les cles photo.* existent dans les trois langues', () => {
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of ['photo.add', 'photo.replace', 'photo.sending', 'photo.bad_type', 'photo.too_big', 'photo.failed']) {
      assert.ok(k in d, `${l} : ${k} manquante`)
    }
  }
})

test('l’accueil affiche photo_url quand elle existe, le fond neutre sinon', () => {
  const html = sansCommentaires(lire('pages/aujourdhui.html'))
  assert.ok(html.includes('photo_url'), 'la colonne est lue')
  assert.ok(/b\.photo_url\s*\?/.test(html), 'photo seulement si presente')
  assert.ok(html.includes('property__photo--none'), 'le fond neutre reste le repli')
  assert.ok(/img src="\$\{esc\(b\.photo_url\)\}"/.test(html), 'URL echappee')
})

test('channel-property expose photo_url (la liste des biens de /biens)', () => {
  assert.ok(lire('api/channel-property.js').includes('photo_url'))
})
