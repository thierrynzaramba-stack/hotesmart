// tests/verificateur-lecture-seule.test.js
//
// L'ENVELOPPE DE LECTURE SEULE DES SCRIPTS DE VERIFICATION.
//
// ⚠ POURQUOI CE FICHIER EXISTE. `scripts/verifier-isolation-ecran.js` tourne
// avec la CLE DE SERVICE contre la PRODUCTION, et son en-tete annonce « toute
// ecriture LEVE ». Cette promesse etait fausse deux fois de suite :
//   · premiere version : quatre noms de methodes refuses (`insert`, `upsert`,
//     `update`, `delete`) sur `from` SEULEMENT, et le client « nu » du script
//     ne passait meme pas par l'enveloppe ;
//   · deuxieme version : un proxy sur le client, mais qui rendait les
//     proprietes NON fonctions telles quelles — donc `auth.admin`, `rest` et
//     `storage` restaient a nu — et une liste noire de quatre noms, qui ne
//     pouvait pas nommer `upload`, `createUser`, `invoke` ni `rpc`.
// Mesure de la review contre supabase-js : dix chemins d'ecriture atteignaient
// l'implementation reelle, dont `auth.admin.deleteUser()`, qui a leve DEPUIS
// L'INTERIEUR du SDK.
//
// ⚠ ET C'EST POURQUOI LA PROMESSE EST MAINTENANT UNE LISTE BLANCHE. Une liste
// noire doit tout prevoir, y compris ce qu'un SDK ajoutera demain ; une liste
// blanche n'a qu'a autoriser le vocabulaire de lecture qu'on utilise. Ce test
// eprouve les DIX chemins mesures, plus la lecture qui doit continuer de
// passer — sans ce dernier, une enveloppe qui refuse tout serait « verte ».

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// On extrait la fonction de sa source, sans charger le script (qui lit
// `.env.local` et ouvre un client Supabase).
function chargerEnveloppe () {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts/verifier-isolation-ecran.js'), 'utf8')
  const deb = src.indexOf('const LECTURES_AUTORISEES')
  const fin = src.indexOf('const absSdk')
  assert.ok(deb > 0 && fin > deb, 'la liste blanche a disparu du verificateur')
  const mod = { exports: {} }
  new Function('module', src.slice(deb, fin) + '\n;module.exports = { lectureSeule }')(mod)
  return mod.exports.lectureSeule
}

// Un faux client dont CHAQUE chemin d'ecriture se signale s'il est atteint.
function fauxClient (atteints) {
  const crie = (nom) => () => { atteints.push(nom); return Promise.resolve({}) }
  return {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ id: 1 }], error: null }) }),
                   delete: crie('from().delete'), insert: crie('from().insert'),
                   update: crie('from().update'), upsert: crie('from().upsert') }),
    rpc: crie('rpc'),
    schema: () => ({ rpc: crie('schema().rpc') }),
    rest: { rpc: crie('rest.rpc') },
    storage: { from: () => ({ upload: crie('storage.upload'), remove: crie('storage.remove') }),
               createBucket: crie('storage.createBucket') },
    auth: { admin: { createUser: crie('auth.admin.createUser'),
                     deleteUser: crie('auth.admin.deleteUser') } },
    functions: { invoke: crie('functions.invoke') },
    channel: () => ({ send: crie('channel().send') })
  }
}

test("LE TEST QUI COMPTE : AUCUN des dix chemins d'ecriture mesures n'atteint le SDK", () => {
  const lectureSeule = chargerEnveloppe()
  const atteints = []
  const c = lectureSeule(fauxClient(atteints))
  const chemins = [
    ['from().delete()', () => c.from('x').delete()],
    ['from().insert()', () => c.from('x').insert({})],
    ['from().update()', () => c.from('x').update({})],
    ['from().upsert()', () => c.from('x').upsert({})],
    ['rpc()', () => c.rpc('f')],
    ["schema('public').rpc()", () => c.schema('public').rpc('rekey_property')],
    ['rest.rpc()', () => c.rest.rpc('f')],
    ['storage.from().upload()', () => c.storage.from('b').upload('f')],
    ['storage.from().remove()', () => c.storage.from('b').remove(['f'])],
    ['storage.createBucket()', () => c.storage.createBucket('b')],
    ['auth.admin.createUser()', () => c.auth.admin.createUser({})],
    ['auth.admin.deleteUser()', () => c.auth.admin.deleteUser('u')],
    ['functions.invoke()', () => c.functions.invoke('f')],
    ['channel().send()', () => c.channel('c').send({})]
  ]
  const passes = []
  for (const [nom, f] of chemins) {
    try { const r = f(); if (r && typeof r.then === 'function') r.catch(() => {}); passes.push(nom) }
    catch { /* refus attendu */ }
  }
  assert.deepEqual(passes, [],
    'ces chemins ne LEVENT pas : ' + passes.join(', '))
  assert.deepEqual(atteints, [],
    'ces chemins ont ATTEINT le SDK, avec la cle de service contre la production : '
    + atteints.join(', '))
})

test('LE TEST QUI COMPTE : une LECTURE passe encore, sinon la preuve serait vide', async () => {
  // Sans cette moitie, une enveloppe qui refuse TOUT serait « verte » — et le
  // verificateur d'isolation ne lirait plus rien, donc ne prouverait plus rien.
  const lectureSeule = chargerEnveloppe()
  const c = lectureSeule(fauxClient([]))
  const { data, error } = await c.from('properties').select('id').eq('user_id', 'u')
  assert.strictEqual(error, null)
  assert.deepEqual(data, [{ id: 1 }])
})

test("le verificateur d'isolation n'ouvre AUCUN client hors de l'enveloppe", () => {
  // ⚠ LE DEFAUT D'ORIGINE : le client « nu » du script etait construit depuis
  // la reference `vrai` sauvegardee AVANT le remplacement du SDK, donc il
  // echappait entierement a l'enveloppe — avec insert/update/delete vivants.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts/verifier-isolation-ecran.js'), 'utf8')
  // On lit LIGNE PAR LIGNE : toute fabrication de client doit porter
  // `lectureSeule(` sur la meme ligne. Compter les occurrences de part et
  // d'autre se trompait (`createClient:` de la fabrique comptait deux fois) —
  // et un test qui se trompe sur son propre compte ne garde rien.
  const nues = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /createClient\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    .filter(([, l]) => !/lectureSeule\s*\(/.test(l))
  assert.deepEqual(nues.map(([n, l]) => `${n}: ${l.trim()}`), [],
    'un client Supabase est fabrique SANS enveloppe de lecture seule')
  assert.ok(src.includes('lectureSeule(vrai.createClient('),
    'le client de lecture du script ne passe plus par l enveloppe')
})
