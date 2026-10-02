// tests/protocole-bus.test.js
// Le protocole unifie entre les apps et le coeur (spec-evaluation-voyageur §2 bis).
//
// LE DEFAUT QU'IL EMPECHE : une app qui importe un fichier du coeur, appelle
// son endpoint, ou affiche un bouton qui echouera. Le bus est le SEUL point
// d'entree : action inconnue, droit absent, module manquant -> « indisponible »,
// jamais une erreur visible, et l'app masque son bouton.
//
// Le bus se teste sans navigateur : ses dependances (droits, import, fenetre)
// s'injectent. Le bus par defaut branche les vraies, dans le navigateur.
const test = require('node:test')
const assert = require('node:assert')

let creerBus
test.before(async () => { ({ creerBus } = await import('../shared/hs-bus.js')) })

// Un manifeste de test : deux actions ouvertes, une « a venir », une par jeton.
const MANIFESTE = {
  domaine: 'demo', version: 1,
  actions: {
    'demo.fenetre':  { type: 'fenetre', droit: { domaine: 'avis', niveau: 'write' }, module: '/core/demo/fenetre.js' },
    'demo.lecture':  { type: 'requete', droit: { domaine: 'avis', niveau: 'read' },  module: '/core/demo/lecture.js' },
    'demo.plus_tard': { type: 'fenetre', droit: { domaine: 'avis', niveau: 'write' }, module: '/core/demo/x.js', etat: 'a_venir' },
    'demo.jeton':    { type: 'fenetre', identite: 'jeton', module: '/core/demo/jeton.js' },
  },
  evenements: { 'demo.fait': { detail: ['booking_uid'] } },
}
const MODULES = {
  '/core/demo/manifest.js': { default: MANIFESTE },
  '/core/demo/fenetre.js':  { ouvrir: async (ctx) => { ctx.conteneur.innerHTML = 'ouvert:' + JSON.stringify(ctx.params); return 'rendu' } },
  '/core/demo/lecture.js':  { demander: async (params) => ({ statut: 'publiee', pour: params.booking_uid }) },
  '/core/demo/jeton.js':    { ouvrir: async (ctx) => ctx.identite },
}
function bus ({ lire = true, ecrire = true, modules = MODULES } = {}) {
  const ouvertures = []
  const b = creerBus({
    manifestes: { demo: '/core/demo/manifest.js' },
    droits: { peutLire: () => lire, peutEcrire: () => ecrire },
    importer: async (chemin) => { if (!modules[chemin]) throw new Error('404 ' + chemin); return modules[chemin] },
    fenetre: { ouvrir: async (module, ctx) => { ouvertures.push(ctx.action); const conteneur = { innerHTML: '' }; return module.ouvrir({ ...ctx, conteneur, fermer () {} }) } },
    cible: new EventTarget(),
  })
  return { b, ouvertures }
}

test('action inconnue : « indisponible », jamais une erreur', async () => {
  const { b } = bus()
  assert.strictEqual(await b.disponible('demo.inexistante'), false)
  assert.strictEqual(await b.disponible('inconnu.action'), false)
  assert.deepStrictEqual(await b.ouvrir('demo.inexistante', {}), { ok: false, raison: 'indisponible' })
  assert.deepStrictEqual(await b.demander('inconnu.action', {}), { ok: false, raison: 'indisponible' })
})

test('droit absent : « indisponible », l’app masque son bouton', async () => {
  const { b, ouvertures } = bus({ ecrire: false })
  assert.strictEqual(await b.disponible('demo.fenetre'), false)
  assert.deepStrictEqual(await b.ouvrir('demo.fenetre', { booking_uid: 'x' }), { ok: false, raison: 'indisponible' })
  assert.deepStrictEqual(ouvertures, [], 'rien n’est ouvert sans droit')
  // lecture seule suffit a `demo.lecture`
  assert.strictEqual(await b.disponible('demo.lecture'), true)
})

test('action « a venir » : indisponible meme avec le droit', async () => {
  const { b } = bus()
  assert.strictEqual(await b.disponible('demo.plus_tard'), false)
})

test('ouvrir : le module du coeur est charge a la demande et rendu dans la fenetre standard', async () => {
  const { b, ouvertures } = bus()
  const r = await b.ouvrir('demo.fenetre', { booking_uid: 'b1' })
  assert.deepStrictEqual(r, { ok: true, resultat: 'rendu' })
  assert.deepStrictEqual(ouvertures, ['demo.fenetre'])
})

test('demander : la reponse du coeur revient a l’app, sans qu’elle sache d’ou', async () => {
  const { b } = bus()
  assert.deepStrictEqual(await b.demander('demo.lecture', { booking_uid: 'b1' }), { ok: true, data: { statut: 'publiee', pour: 'b1' } })
})

test('module manquant cote coeur : « indisponible », pas d’exception qui remonte a l’app', async () => {
  const { b } = bus({ modules: { '/core/demo/manifest.js': { default: MANIFESTE } } })
  assert.deepStrictEqual(await b.ouvrir('demo.fenetre', {}), { ok: false, raison: 'indisponible' })
})

test('identite par jeton (PWA prestataire) : pas de droit de session exige, le jeton est transmis au coeur', async () => {
  const { b } = bus({ lire: false, ecrire: false })
  assert.strictEqual(await b.disponible('demo.jeton'), false, 'sans jeton, rien')
  assert.strictEqual(await b.disponible('demo.jeton', { identite: { jeton: 'abc' } }), true)
  const r = await b.ouvrir('demo.jeton', {}, { identite: { jeton: 'abc' } })
  assert.deepStrictEqual(r, { ok: true, resultat: { jeton: 'abc' } })
})

test('evenements : emettre / ecouter, et se desabonner', async () => {
  const { b } = bus()
  const recus = []
  const stop = b.ecouter('demo.fait', (detail) => recus.push(detail))
  b.emettre('demo.fait', { booking_uid: 'b1' })
  stop()
  b.emettre('demo.fait', { booking_uid: 'b2' })
  assert.deepStrictEqual(recus, [{ booking_uid: 'b1' }])
})

test('un nom d’evenement sans domaine est refuse, a l’emission comme a l’ecoute', () => {
  const { b } = bus()
  assert.throws(() => b.emettre('fait', {}), /domaine/)
  assert.throws(() => b.ecouter('fait', () => {}), /domaine/)
})

test('parametre declare manquant : reponse nommee, pas d’exception, rien d’ouvert', async () => {
  const manifeste = { ...MANIFESTE, actions: { ...MANIFESTE.actions, 'demo.fenetre': { ...MANIFESTE.actions['demo.fenetre'], params: ['booking_uid'] } } }
  const { b, ouvertures } = bus({ modules: { ...MODULES, '/core/demo/manifest.js': { default: manifeste } } })
  assert.deepStrictEqual(await b.ouvrir('demo.fenetre', { bookingUid: 'x' }), { ok: false, raison: 'parametre_manquant', detail: ['booking_uid'] })
  assert.deepStrictEqual(ouvertures, [])
  assert.deepStrictEqual(await b.ouvrir('demo.fenetre', { booking_uid: 'x' }), { ok: true, resultat: 'rendu' })
})

test('un manifeste injoignable n’est pas mis en cache : le domaine revient a l’appel suivant', async () => {
  let panne = true
  const b = creerBus({
    manifestes: { demo: '/core/demo/manifest.js' },
    droits: { peutLire: () => true, peutEcrire: () => true },
    importer: async (chemin) => { if (chemin.endsWith('manifest.js') && panne) throw new Error('reseau'); return MODULES[chemin] },
    fenetre: { ouvrir: async (m, ctx) => m.ouvrir({ ...ctx, conteneur: { innerHTML: '' }, fermer () {} }) },
    cible: new EventTarget(),
  })
  assert.strictEqual(await b.disponible('demo.lecture'), false, 'pendant la panne : indisponible')
  panne = false
  assert.strictEqual(await b.disponible('demo.lecture'), true, 'la panne passee, le domaine repond sans recharger la page')
})
