// tests/prestataires-canaux-dom.test.js
// LES DEUX CANAUX DE NOTIFICATION, DANS LE VRAI DOM DE LA FICHE.
//
// ⚠ CE QUE CE LOT SÉPARE. Jusqu'au 15 septembre 2026, le canal se DÉDUISAIT de
// la coordonnée : renseigner un numéro, c'était accepter de le faire sonner, et
// le seul moyen de ne pas envoyer de SMS était d'EFFACER le numéro — donc de
// perdre le moyen de l'appeler. L'intention et la coordonnée sont maintenant
// deux choses, et l'envoi exige les DEUX.
//
// ⚠ POURQUOI UN TEST DE DOM, ET PAS UN TEST DE FONCTION. Tout le réglage vit
// dans l'interaction : une case qui suit ce qu'on tape, puis qui cesse de le
// suivre dès qu'on y touche, et un avertissement qui n'apparaît que sur la
// promesse non tenue. Rien de cela ne se lit dans un corps de requête.
//
// ⚠ ON EXÉCUTE LE VRAI SCRIPT DE LA PAGE, pas une copie.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'prestataires.html')

const BIENS = [{ id: 'prop-1', uuid: 'u-1', name: 'La bulle' }]
const PROFIL = 'p-regina'
const LIGNE = { id: 'pt-1', label: 'Régina', visibility_days: 30,
                ratio_periode: '30j', property_ids: ['prop-1'] }

function monter ({ profil = {} } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script module de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*await exigerCompteProprePage\(.*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
    .replace(/^\s*init\(\)\s*$/gm, '')

  const envois = []
  // ⚠ LE PROFIL EST CELUI DU SERVEUR, champs compris. C'est `/api/menages
  // ?contacts=1` qui rend `notif_sms` / `notif_email` : un double qui les
  // inventerait ne prouverait rien sur ce que l'écran reçoit vraiment.
  const p = Object.assign({
    id: PROFIL, prenom: 'Régina', nom: 'Martin', actif: true, a_lien: true,
    public_token_id: LIGNE.id, telephone: null, email: null,
    permissions: { self_availability: 'write' }
  }, profil)

  src += `
    globalThis.__t = {
      envois,
      seed () { properties = ${JSON.stringify(BIENS)}; liaisons = []
                prestataires = ${JSON.stringify([LIGNE])}
                currentSession = { access_token: 'jwt', user: { id: 'compte-1' } }
                prestatairesProfils = [${JSON.stringify(p)}]
                rapprochementSur = true },
      renderPropCheckboxes, renderPrestataires, editPrestataire,
      resetForm, saveEdit, createPrestataire, canauxSaisis
    }
  `

  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/prestataires',
                                runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  w.confirm = () => true
  w.fetch = async (url, opts) => {
    envois.push({ url: String(url), corps: JSON.parse((opts && opts.body) || '{}') })
    return { ok: true, status: 200, json: async () => ({ ok: true, sans_referent: [] }) }
  }
  w.envois = envois
  w.supabase = {
    from () {
      const chain = {
        update () { return chain }, select () { return chain }, delete () { return chain },
        insert () { return Promise.resolve({ data: [], error: null }) },
        order () { return Promise.resolve({ data: [], error: null }) },
        eq () { return Object.assign(Promise.resolve({ data: [], error: null }), chain) }
      }
      return chain
    }
  }
  vm.runInContext(src, dom.getInternalVMContext())
  return { w, t: w.__t, envois }
}

const el = (w, id) => w.document.getElementById(id)
const taper = (w, id, v) => {
  const c = el(w, id)
  c.value = v
  c.dispatchEvent(new w.Event('input', { bubbles: true }))
}
const cocher = (w, id, v) => {
  const c = el(w, id)
  c.checked = v
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
}
const avert = w => el(w, 'avert-canaux').textContent
const membres = envois => envois.filter(e => e.url.includes('/api/membres'))

// ─── Le défaut suit ce qu'on tape ─────────────────────────────────────────

test('taper un numéro coche « SMS », l\'effacer le décoche', async () => {
  // Le défaut demandé : « les canaux qui ont une coordonnée ». Appliqué en
  // direct, pas seulement au chargement — sinon l'hôte tape un numéro, la case
  // reste décochée, et il croit avoir renseigné un canal muet.
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()

  assert.strictEqual(el(w, 'presta-notif-sms').checked, false, 'formulaire vierge : rien de coché')
  taper(w, 'presta-phone', '+33600000000')
  assert.strictEqual(el(w, 'presta-notif-sms').checked, true)
  assert.strictEqual(el(w, 'presta-notif-email').checked, false, 'l\'e-mail ne suit pas le numéro')

  taper(w, 'presta-phone', '')
  assert.strictEqual(el(w, 'presta-notif-sms').checked, false)
})

test('une case TOUCHÉE cesse de suivre — et elle seule', async () => {
  // ⚠ UN DÉFAUT QUI S'APPLIQUE APRÈS UN GESTE N'EST PLUS UN DÉFAUT, C'EST UN
  // ÉCRASEMENT. Sans ce figeage, décocher « SMS » puis corriger une faute de
  // frappe dans le numéro recochait la case : le choix de l'hôte était défait
  // par sa propre saisie, sans un mot.
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()

  taper(w, 'presta-phone', '+33600000000')
  cocher(w, 'presta-notif-sms', false)          // le geste de l'hôte
  taper(w, 'presta-phone', '+33600000001')      // il corrige le numéro
  assert.strictEqual(el(w, 'presta-notif-sms').checked, false, 'le choix tient')

  // Et l'autre case, elle, suit toujours : on n'y a pas touché.
  taper(w, 'presta-email', 'regina@x.fr')
  assert.strictEqual(el(w, 'presta-notif-email').checked, true)
})

// ─── Le signalement ───────────────────────────────────────────────────────

test('coché SANS coordonnée : l\'écran le dit', async () => {
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  cocher(w, 'presta-notif-sms', true)
  assert.match(avert(w), /aucun numéro/)
  assert.match(avert(w), /rien ne partira/)
})

test('AUCUN canal ouvert : l\'écran dit que l\'urgence sera muette', async () => {
  // ⚠ LE CAS QUI COÛTE. L'assignation directe est le geste d'urgence : à deux
  // heures du départ, quand quelqu'un se décommande. Muette, elle laisse
  // l'hôte croire qu'il a confié son logement.
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  taper(w, 'presta-phone', '+33600000000')
  cocher(w, 'presta-notif-sms', false)
  assert.match(avert(w), /Aucun canal actif/)
  assert.match(avert(w), /muette/)
})

test('une coordonnée gardée SANS sa case ne se fait pas reprocher', async () => {
  // ⚠ C'EST LE BUT DU LOT, PAS UN DÉFAUT. Garder un numéro pour l'APPELER sans
  // lui envoyer de SMS est exactement ce que ces cases rendent possible : le
  // signaler en ferait un reproche, et pousserait à effacer le numéro — le
  // geste que ce lot existe pour éviter.
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  taper(w, 'presta-phone', '+33600000000')
  taper(w, 'presta-email', 'regina@x.fr')
  cocher(w, 'presta-notif-sms', false)          // e-mail reste coché : un canal vit
  assert.strictEqual(avert(w), '', 'aucun avertissement')
})

// ─── Ce qui part au serveur ───────────────────────────────────────────────

test('la CRÉATION envoie les canaux TRANCHÉS, dans les deux sens', async () => {
  // Omis, le serveur retombe sur son défaut `true` : une case décochée à
  // l'écran ne serait pas tenue, et l'hôte croirait avoir coupé un canal
  // resté ouvert. Les deux cases sont donc touchées ici — c'est ce qui en fait
  // des décisions, et non le défaut de l'écran (voir le test suivant).
  const { w, t, envois } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  el(w, 'presta-prenom').value = 'Nouvelle'
  el(w, 'presta-nom').value = 'Dupont'
  taper(w, 'presta-phone', '+33600000000')
  taper(w, 'presta-email', 'n@x.fr')
  cocher(w, 'presta-notif-sms', true)
  cocher(w, 'presta-notif-email', false)
  const cb = el(w, `prop-${BIENS[0].id}`)
  if (cb) cb.checked = true
  await t.createPrestataire()

  const creation = membres(envois).find(e => e.corps.action === 'create')
  assert.ok(creation, 'la création part')
  assert.strictEqual(creation.corps.notify_sms, true)
  assert.strictEqual(creation.corps.notify_email, false)
})

test('la création n\'envoie PAS un canal que personne n\'a tranché', async () => {
  // ⚠ LE DÉFAUT TROUVÉ EN REVIEW, ET IL CONTREDISAIT L'INVARIANT DE LA MIGRATION.
  // L'écran envoyait toujours l'état des deux cases — y compris celui qu'il
  // avait lui-même déduit de la coordonnée. Créée avec son seul numéro, une
  // prestataire partait donc avec `notify_email: false` GRAVÉ : le jour où
  // l'hôte ajoutait son adresse — geste qui suffisait avant ce lot — plus rien
  // ne partait, et rien ne le disait. C'est le cas le plus fréquent : presque
  // personne n'a les deux coordonnées au moment de la création.
  //
  // Un champ absent laisse le serveur à son défaut `true`, c'est-à-dire
  // « quand tu auras la coordonnée, sers-t'en ».
  const { w, t, envois } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  el(w, 'presta-prenom').value = 'Nouvelle'
  el(w, 'presta-nom').value = 'Dupont'
  taper(w, 'presta-phone', '+33600000000')      // aucune case touchée
  const cb = el(w, `prop-${BIENS[0].id}`)
  if (cb) cb.checked = true
  await t.createPrestataire()

  const creation = membres(envois).find(e => e.corps.action === 'create')
  assert.ok(creation, 'la création part')
  assert.ok(!('notify_sms' in creation.corps),
    '`notify_sms` non tranché ne doit pas être envoyé')
  assert.ok(!('notify_email' in creation.corps),
    '`notify_email` non tranché ne doit pas être envoyé — sinon l\'adresse ' +
    'ajoutée plus tard reste muette')
})

test('un canal tranché part, l\'autre non — les deux cas dans la même création', async () => {
  const { w, t, envois } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  el(w, 'presta-prenom').value = 'Nouvelle'
  el(w, 'presta-nom').value = 'Dupont'
  taper(w, 'presta-phone', '+33600000000')
  cocher(w, 'presta-notif-sms', false)          // tranché : elle ne veut pas de SMS
  const cb = el(w, `prop-${BIENS[0].id}`)
  if (cb) cb.checked = true
  await t.createPrestataire()

  const creation = membres(envois).find(e => e.corps.action === 'create')
  assert.strictEqual(creation.corps.notify_sms, false, 'la décision part')
  assert.ok(!('notify_email' in creation.corps), 'le défaut, lui, reste au serveur')
})

test('un formulaire VIERGE n\'avertit de rien', async () => {
  // ⚠ UN AVERTISSEMENT PERMANENT N'EN EST PAS UN. À l'ouverture du formulaire de
  // création, « aucun canal actif » est vrai et sans objet : l'hôte le verrait à
  // CHAQUE création et apprendrait à ne plus le lire — au moment même où il
  // compte le plus.
  const { w, t } = monter()
  t.seed(); t.renderPropCheckboxes(); t.resetForm()
  assert.strictEqual(avert(w), '')
})

test('la MODIFICATION envoie les deux canaux', async () => {
  const { w, t, envois } = monter({ profil: {
    telephone: '+33600000000', email: 'r@x.fr', notif_sms: true, notif_email: true } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  cocher(w, 'presta-notif-sms', false)
  await t.saveEdit(LIGNE.id)

  const maj = membres(envois).find(e => e.corps.action === 'update')
  assert.ok(maj, 'la modification part')
  assert.strictEqual(maj.corps.notify_sms, false)
  assert.strictEqual(maj.corps.notify_email, true)
})

// ─── Ce que l'écran lit du serveur ────────────────────────────────────────

test('l\'état vient du SERVEUR, et il ne se recalcule pas depuis les coordonnées', async () => {
  // ⚠ LE DÉFAUT QUE CE TEST FERME. Une fiche existante porte déjà un choix.
  // Laisser les cases se recalculer depuis les coordonnées RALLUMERAIT au
  // premier affichage un canal que l'hôte avait coupé — et le premier
  // enregistrement le graverait. Le numéro est là, la case doit rester
  // décochée.
  const { w, t } = monter({ profil: {
    telephone: '+33600000000', email: 'r@x.fr', notif_sms: false, notif_email: true } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)

  assert.strictEqual(el(w, 'presta-notif-sms').checked, false, 'le choix du serveur tient')
  assert.strictEqual(el(w, 'presta-notif-email').checked, true)

  // Et il tient aussi à la frappe suivante : une fiche ouverte est figée.
  taper(w, 'presta-phone', '+33611111111')
  assert.strictEqual(el(w, 'presta-notif-sms').checked, false)
})

test('un champ ABSENT de la réponse vaut OUI, jamais non', async () => {
  // ⚠ `!== false`, PAS `=== true`. Une réponse d'avant ce lot, ou un
  // `contacts=1` oublié, n'apporte pas le champ. Le lire « non » décocherait
  // une case que personne n'a touchée — et le premier enregistrement GRAVERAIT
  // ce `false`. C'est le défaut déjà payé sur `self_availability`.
  const { w, t } = monter({ profil: { telephone: '+33600000000', email: 'r@x.fr' } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'presta-notif-sms').checked, true)
  assert.strictEqual(el(w, 'presta-notif-email').checked, true)
})

test('un lien SANS profil coupe les cases, comme les coordonnées à côté d\'elles', async () => {
  // Rien n'a de writer pour `profiles` : une case qui n'enregistre rien ne doit
  // pas être cliquable. Même règle que le numéro et l'e-mail.
  const { w, t } = monter({ profil: { public_token_id: 'autre-chose' } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  assert.strictEqual(el(w, 'presta-notif-sms').disabled, true)
  assert.strictEqual(el(w, 'presta-notif-email').disabled, true)
  assert.strictEqual(el(w, 'presta-phone').disabled, true, 'la garde existante n\'a pas bougé')
  // ⚠ ET L'AVERTISSEMENT SE TAIT. Il se rallumait juste après la coupure :
  // l'aide disait « ni téléphone ni email ne peuvent y être enregistrés » et,
  // juste dessous, l'écran conseillait de saisir un numéro — un conseil
  // d'action sur un écran où rien ne s'enregistre. Le test ne regardait que
  // `disabled`, c'est ce qui l'avait laissé passer.
  assert.strictEqual(avert(w), '',
    'aucun conseil de saisie là où aucune saisie n\'est enregistrée')
})

test('rouvrir le formulaire vierge remet les cases à zéro', async () => {
  // ⚠ Sans cette remise à zéro, le figeage de la fiche précédente survivait :
  // la création suivante ne suivait plus ce qu'on tape.
  const { w, t } = monter({ profil: {
    telephone: '+33600000000', email: 'r@x.fr', notif_sms: false, notif_email: false } })
  t.seed(); t.renderPrestataires(); t.renderPropCheckboxes()
  t.editPrestataire(LIGNE.id)
  t.resetForm()

  assert.strictEqual(el(w, 'presta-notif-sms').checked, false)
  taper(w, 'presta-phone', '+33600000000')
  assert.strictEqual(el(w, 'presta-notif-sms').checked, true,
    'le défaut suit de nouveau la saisie')
})
