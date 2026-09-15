// tests/prestataires-nom-dom.test.js
// LE NOM DE FAMILLE EST OBLIGATOIRE — et la règle n'est PAS rétroactive.
//
// ⚠ POURQUOI CETTE RÈGLE, ET CE N'EST PAS DE L'ÉTAT CIVIL. Un prénom seul ne
// DÉSIGNE personne dès qu'il y a deux Marie : ni dans la liste des
// prestataires, ni dans le planning, ni dans les avis, ni dans le SMS qui
// arrive chez elle. Ce dépôt a déjà payé la fusion d'une identité dupliquée,
// faute de savoir si deux lignes parlaient de la même personne.
//
// ⚠ ET LA MOITIÉ LA PLUS FACILE À CASSER : les fiches d'avant n'ont pas de nom,
// et rien de ce qui tourne ne doit s'arrêter parce qu'elles n'en ont pas. Une
// obligation qui bloque l'existant n'est pas une obligation, c'est une panne.
//
// ⚠ L'écran avait UN seul champ, envoyé en `first_name` à la création et PAS
// ENVOYÉ DU TOUT à la modification. Le libellé du lien et le prénom du profil
// divergeaient donc, et rien ici ne permettait de réparer un nom.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'prestataires.html')

const BIENS = [{ id: 'prop-1', uuid: 'u-1', name: 'La bulle' }]
const PROFIL = 'p-regina'
const LIGNE = { id: 'pt-1', label: 'Régina Martin', visibility_days: 30,
                ratio_periode: '30j', property_ids: ['prop-1'] }

function monter ({ profil = {}, sansProfil = false } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script module de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*await exigerCompteProprePage\(.*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
    .replace(/^\s*init\(\)\s*$/gm, '')

  const envois = []
  const ecrits = []
  const p = Object.assign({
    id: PROFIL, prenom: 'Régina', nom: 'Martin', actif: true, a_lien: true,
    public_token_id: LIGNE.id, telephone: null, email: null,
    permissions: { self_availability: 'write' }
  }, profil)

  src += `
    globalThis.__t = {
      envois, ecrits,
      seed () { properties = ${JSON.stringify(BIENS)}; liaisons = []
                prestataires = ${JSON.stringify([LIGNE])}
                currentSession = { access_token: 'jwt', user: { id: 'compte-1' } }
                prestatairesProfils = ${sansProfil ? '[]' : `[${JSON.stringify(p)}]`}
                rapprochementSur = true },
      renderPropCheckboxes, renderPrestataires, editPrestataire,
      resetForm, saveEdit, createPrestataire
    }
  `

  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/prestataires',
                                runScripts: 'outside-only' })
  const w = dom.window
  const alertes = []
  w.alert = t => alertes.push(String(t))
  w.confirm = () => true
  w.fetch = async (url, opts) => {
    envois.push({ url: String(url), corps: JSON.parse((opts && opts.body) || '{}') })
    return { ok: true, status: 200,
             json: async () => ({ ok: true, sans_referent: [],
                                  profil: { id: 'p-neuf' }, lien: 'https://x/public?token=zz' }) }
  }
  w.envois = envois
  w.ecrits = ecrits
  w.supabase = {
    from (table) {
      const q = { champs: null }
      const chain = {
        update (c) { q.champs = c; return chain },
        select () { return chain }, delete () { return chain },
        insert () { return Promise.resolve({ data: [], error: null }) },
        order () { return Promise.resolve({ data: [], error: null }) },
        eq () { if (q.champs) { ecrits.push({ table, champs: q.champs }); q.champs = null }
                return Object.assign(Promise.resolve({ data: [], error: null }), chain) }
      }
      return chain
    }
  }
  vm.runInContext(src, dom.getInternalVMContext())
  return { w, t: w.__t, envois, ecrits, alertes }
}

const el = (w, id) => w.document.getElementById(id)
const membres = envois => envois.filter(e => e.url.includes('/api/membres'))

// ─── La création ──────────────────────────────────────────────────────────

test('créer sans nom de famille est refusé, et RIEN ne part', async () => {
  // ⚠ L'ÉCRAN REFUSE AVANT L'ALLER-RETOUR. Le serveur refuse déjà ; laisser
  // partir la requête ferait remplir dix cases de droits pour se voir opposer
  // un 400 sur la première. Et surtout : `createPrestataire` écrit ensuite les
  // liaisons et le libellé du lien — un refus tardif laisserait une création à
  // moitié faite.
  const { w, t, envois, alertes } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  el(w, 'presta-prenom').value = 'Marie'
  const cb = el(w, `prop-${BIENS[0].id}`)
  if (cb) cb.checked = true
  await t.createPrestataire()

  assert.strictEqual(envois.length, 0, 'aucune requête ne part')
  assert.ok(alertes.some(a => /nom de famille/i.test(a)), alertes.join(' | '))
})

test('créer sans prénom est refusé aussi — les deux champs, pas un seul', async () => {
  const { w, t, envois } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  el(w, 'presta-nom').value = 'Dupont'
  await t.createPrestataire()
  assert.strictEqual(envois.length, 0)
})

test('le prénom et le nom partent SÉPARÉMENT, et le libellé en découle', async () => {
  // ⚠ LE DÉFAUT QUE DEUX CHAMPS FERMENT. Un champ unique partait en
  // `first_name` : rouvrir la fiche rechargeait « Régina Martin » dans ce même
  // champ, et l'enregistrer écrivait « Régina Martin » dans le PRÉNOM en
  // laissant `last_name` à « Martin » — d'où « Régina Martin Martin » dans le
  // planning, dans /settings et dans le « Bonjour … » du SMS.
  const { w, t, envois, ecrits } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  el(w, 'presta-prenom').value = 'Marie'
  el(w, 'presta-nom').value = 'Dupont'
  const cb = el(w, `prop-${BIENS[0].id}`)
  if (cb) cb.checked = true
  await t.createPrestataire()

  const creation = membres(envois).find(e => e.corps.action === 'create')
  assert.ok(creation, 'la création part')
  assert.strictEqual(creation.corps.first_name, 'Marie')
  assert.strictEqual(creation.corps.last_name, 'Dupont')
  const tok = ecrits.find(e => e.table === 'public_tokens')
  assert.ok(tok, 'le libellé du lien est écrit')
  assert.strictEqual(tok.champs.label, 'Marie Dupont',
    'le libellé est COMPOSÉ, il n\'est pas une troisième saisie')
})

// ─── La modification ──────────────────────────────────────────────────────

test('le nom part MAINTENANT vers le profil à la modification', async () => {
  // Il ne partait pas du tout : cet écran n'avait aucun moyen de réparer un
  // nom, il fallait passer par la page Équipe.
  const { w, t, envois } = monter()
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  el(w, 'presta-nom').value = 'Martin-Dupont'
  await t.saveEdit(LIGNE.id)

  const maj = membres(envois).find(e => e.corps.action === 'update')
  assert.ok(maj, 'la modification part')
  assert.strictEqual(maj.corps.first_name, 'Régina')
  assert.strictEqual(maj.corps.last_name, 'Martin-Dupont')
})

test('la fiche se pré-remplit depuis le PROFIL, pas depuis le libellé du lien', async () => {
  const { w, t } = monter()
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'presta-prenom').value, 'Régina',
    'le libellé « Régina Martin » ne doit pas atterrir dans le prénom')
  assert.strictEqual(el(w, 'presta-nom').value, 'Martin')
})

test('enregistrer une fiche SANS nom réclame le nom, et n\'écrit rien', async () => {
  // C'est la forme que prend « obligatoire à la modification » : la fiche
  // continue de fonctionner, mais on ne l'enregistre pas sans réparer le nom.
  const { w, t, envois, ecrits, alertes } = monter({ profil: { nom: null } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  await t.saveEdit(LIGNE.id)

  // ⚠ On compte les ECRITURES, pas les requêtes : ouvrir la fiche déclenche une
  // LECTURE de ses disponibilités, parfaitement légitime.
  assert.strictEqual(membres(envois).length, 0, 'rien ne part vers /api/membres')
  assert.strictEqual(ecrits.length, 0, 'et le libellé du lien n\'est pas écrit non plus')
  assert.ok(alertes.some(a => /nom de famille/i.test(a)), alertes.join(' | '))
})

// ─── La population existante : le nom complet est dans le PRÉNOM ──────────
//
// ⚠ LA FIXTURE RÉELLE, PAS LA FIXTURE CONFORTABLE (REVIEW.md règle 8).
// L'ancien écran n'avait qu'un champ et l'envoyait tel quel en `first_name` :
// toute fiche créée depuis lui vaut `{ first_name: 'Régina Martin',
// last_name: null }`. Écrire les tests avec `{ prenom: 'Régina', nom: null }`
// aurait été la version confortable du cas dangereux — et le seul cas qui
// n'existe PAS en production.

const LEGACY = { prenom: 'Régina Martin', nom: null }

test('une fiche d\'avant : le nom en un bloc est COUPÉ à l\'écran, et la coupe est dite', async () => {
  const { w, t } = monter({ profil: LEGACY })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'presta-prenom').value, 'Régina')
  assert.strictEqual(el(w, 'presta-nom').value, 'Martin')
  assert.match(el(w, 'aide-nom').textContent, /un seul bloc/)
  assert.match(el(w, 'aide-nom').textContent, /vérifiez la coupe/)
})

test('réparer une fiche d\'avant ne produit PAS « Régina Martin Martin »', async () => {
  // ⚠ LE DÉFAUT EXACT QUE CE LOT ANNONCE FERMER, atteint par la porte qu'il
  // ouvre. Sans la coupe, l'hôte voyait « Régina Martin » en prénom, tapait
  // « Martin » en nom, et le libellé composé partait à rallonge — dans la liste
  // ET dans l'en-tête de la PWA de la prestataire elle-même.
  const { w, t, envois, ecrits } = monter({ profil: LEGACY })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  await t.saveEdit(LIGNE.id)

  const maj = membres(envois).find(e => e.corps.action === 'update')
  assert.ok(maj, 'la modification part')
  assert.strictEqual(maj.corps.first_name, 'Régina', 'le prénom est nettoyé')
  assert.strictEqual(maj.corps.last_name, 'Martin')
  const tok = ecrits.find(e => e.table === 'public_tokens')
  assert.strictEqual(tok.champs.label, 'Régina Martin', 'pas de nom à rallonge')
})

test('et si la coupe est défaite, l\'écran REFUSE le libellé à rallonge', async () => {
  // Le filet : l'hôte peut toujours recoller le nom dans le prénom à la main.
  const { w, t, envois, alertes } = monter({ profil: LEGACY })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  el(w, 'presta-prenom').value = 'Régina Martin'      // la coupe défaite
  await t.saveEdit(LIGNE.id)

  assert.strictEqual(membres(envois).length, 0, 'rien ne part')
  assert.ok(alertes.some(a => /contient déjà/.test(a)), alertes.join(' | '))
})

test('un prénom COMPOSÉ se coupe aussi — mais l\'hôte peut le recoller', async () => {
  // ⚠ ON PROPOSE LA COUPE, ON NE L'IMPOSE PAS. « Marie-Claire Dupont » se coupe
  // bien, « Jean Pierre Martin » non, et la machine n'a aucun moyen de le
  // savoir. C'est pour ça que la coupe se fait À L'ÉCRAN et jamais en base.
  const { w, t, envois } = monter({ profil: { prenom: 'Jean Pierre Martin', nom: null } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'presta-prenom').value, 'Jean Pierre')
  assert.strictEqual(el(w, 'presta-nom').value, 'Martin')

  el(w, 'presta-prenom').value = 'Jean Pierre Martin'
  el(w, 'presta-nom').value = 'Dupont'               // le vrai nom de famille
  await t.saveEdit(LIGNE.id)
  const maj = membres(envois).find(e => e.corps.action === 'update')
  assert.strictEqual(maj.corps.first_name, 'Jean Pierre Martin')
  assert.strictEqual(maj.corps.last_name, 'Dupont')
})

test('un prénom d\'un seul mot n\'est pas coupé — il n\'y a rien à couper', async () => {
  const { w, t } = monter({ profil: { prenom: 'Régina', nom: null } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'presta-prenom').value, 'Régina')
  assert.strictEqual(el(w, 'presta-nom').value, '')
  assert.match(el(w, 'aide-nom').textContent, /Nom manquant/)
})

// ─── Ce que la règle ne fait PAS ──────────────────────────────────────────

test('la fiche « nom manquant » est MARQUÉE, dans la fiche et dans la liste', async () => {
  const { w, t } = monter({ profil: { nom: null } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  // Dans la liste : repérable sans ouvrir les dix fiches l'une après l'autre.
  assert.match(w.document.getElementById('presta-list').textContent, /Nom manquant/)
  // Dans la fiche : l'hôte doit savoir POURQUOI l'enregistrement va lui
  // réclamer un nom.
  t.editPrestataire(LIGNE.id)
  assert.match(el(w, 'aide-nom').textContent, /Nom manquant/)
  assert.match(el(w, 'aide-nom').textContent, /continue de fonctionner/)
})

test('une fiche COMPLÈTE n\'est pas marquée', async () => {
  const { w, t } = monter()
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  assert.ok(!/Nom manquant/.test(w.document.getElementById('presta-list').textContent))
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'aide-nom').textContent, '')
})

test('le formulaire de CRÉATION n\'affiche aucune aide de nom', async () => {
  // ⚠ `resetForm` passe `null` comme profil, tout comme un lien sans personne :
  // déduire le cas de `profil === null` faisait afficher « ce lien n'est
  // rattaché à aucune personne » sur un formulaire vierge.
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  assert.strictEqual(el(w, 'aide-nom').textContent, '')
})

test('un lien SANS profil DIT où va le nom qu\'on y tape', async () => {
  // Le téléphone et l'e-mail sont coupés dans ce cas ; le champ nom, lui, reste
  // ouvert et enregistre quelque chose — mais dans le LIBELLÉ du lien, jamais
  // dans `profiles`. Le taire laisserait croire qu'on nomme une personne.
  const { w, t } = monter({ sansProfil: true })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.match(el(w, 'aide-nom').textContent, /étiquette au lien/)
})

test('un lien SANS profil n\'est pas marqué — ignorer n\'est pas constater', async () => {
  // ⚠ Sans profil rattaché, l'absence de nom n'est pas un constat : c'est une
  // ignorance. L'afficher comme un défaut enverrait réparer ce qui va bien, et
  // le vrai problème de ces liens est dit ailleurs (« recréez le prestataire »).
  const { w, t } = monter({ sansProfil: true })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  assert.ok(!/Nom manquant/.test(w.document.getElementById('presta-list').textContent))
})

test('un lien SANS profil reste enregistrable — pas de blocage rétroactif', async () => {
  // ⚠ LA GARDE LA PLUS IMPORTANTE DE CE LOT. Rien n'écrit `profiles` pour ces
  // liens : seul le LIBELLÉ part. Exiger un nom de famille les rendrait
  // DÉFINITIVEMENT non enregistrables — une obligation qui fige l'existant
  // n'est pas une obligation, c'est une panne.
  const { w, t, ecrits, alertes } = monter({ sansProfil: true })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  const cb = el(w, `prop-${BIENS[0].id}`)
  if (cb) cb.checked = true
  await t.saveEdit(LIGNE.id)

  assert.ok(!alertes.some(a => /nom de famille/i.test(a)),
    'aucune réclamation de nom : ' + alertes.join(' | '))
  const tok = ecrits.find(e => e.table === 'public_tokens')
  assert.ok(tok, 'le libellé du lien s\'enregistre toujours')
  // ⚠ ET IL VAUT TOUJOURS CE QU'IL VALAIT. Le prénom est pré-rempli avec le
  // libellé : une retouche de `libelleSaisi()` ou du pré-remplissage le
  // tronquerait en silence pour TOUS les liens sans profil, test vert.
  assert.strictEqual(tok.champs.label, 'Régina Martin')
})
