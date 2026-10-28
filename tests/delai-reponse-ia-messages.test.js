// tests/delai-reponse-ia-messages.test.js
// Les gestes de l'hote sur un brouillon differe (api/messages.js), chantier
// « delai de reponse IA », lot 2. Spec §4.2, §4.4 et decisions 6-7.
//
// ⚠ CE FICHIER EXISTE PARCE QUE tests/messages-v5.test.js GREPE LE SOURCE DE
// L'ENDPOINT, ET QUE C'EST LA QUATRIEME FOIS QU'UN DE CES GREPS ROUGIT SUR UN
// CODE PLUS CORRECT QUE CELUI QU'IL PROTEGEAIT. Un motif comme
// `.update({ status: statut })` suivi de `.eq('status', 'pending_validation')`
// garde une FORMULATION : le jour ou l'UPDATE desarme aussi l'echeance, ou
// conditionne sur le statut LU plutot que sur une constante, le test casse
// alors que la course est toujours fermee. Et il resterait vert si la condition
// disparaissait en gardant la forme.
//
// Ici, l'endpoint est APPELE. Ce qui est verifie est ce que la base recoit.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const COMPTE = 'compte-1'
const BIEN_UUID = '58001ed1-e194-498a-94b4-606eece8f33d'
const REF = '0544fd9a'

function tacheType (p = {}) {
  return {
    id: 'tache-1', user_id: COMPTE, property_id: REF, book_id: 'BK1',
    guest_name: 'Alice', guest_message: 'Le wifi ?',
    task_type: 'info_known', suggested_reply: 'Le code est au mur.',
    status: 'pending_validation', send_after: '2026-11-11T12:00:00.000Z',
    suspendu_le: null, modifie_le: null, ...p
  }
}

// ⚠ LE DOUBLE APPLIQUE LES CONDITIONS D'UPDATE, comme la base : un
// `.eq('status', X)` sur une ligne qui n'est pas dans l'etat X ne touche rien et
// rend zero ligne. Un double permissif ici validerait un claim qui ne ferme
// rien — et c'est precisement ce que ce fichier doit prouver.
function banc ({ taches = [tacheType()], session = COMPTE } = {}) {
  const etat = { taches: taches.map(t => ({ ...t })), inserts: [] }
  const client = {
    auth: { getUser: async () => (session
      ? { data: { user: { id: session, email: 'h@x.fr' } }, error: null }
      : { data: null, error: { message: 'invalide' } }) },
    from (table) {
      const f = { eq: {} }
      let maj = null
      const q = {
        select () { return q },
        eq (c, v) { f.eq[c] = v; return q },
        limit () { return q }, order () { return q }, is () { return q }, not () { return q },
        update (patch) { maj = patch; return q },
        insert (row) { etat.inserts.push({ table, row }); return Promise.resolve({ error: null }) },
        maybeSingle: async () => ({ data: lignes()[0] || null, error: null }),
        single: async () => ({ data: lignes()[0] || null, error: null }),
        then (res, rej) {
          const l = lignes()
          if (maj) for (const x of l) Object.assign(x, maj)
          return Promise.resolve({ data: l.map(x => ({ ...x })), error: null }).then(res, rej)
        }
      }
      function lignes () {
        if (table === 'agent_tasks') {
          return etat.taches.filter(t => Object.entries(f.eq)
            .every(([c, v]) => String(t[c]) === String(v)))
        }
        if (table === 'profiles' || table === 'profile_permissions') return []
        return []
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../api/messages']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}

async function appeler (corps, options = {}) {
  const etat = banc(options)
  const handler = require('../api/messages')
  const res = reponse()
  await handler({ method: 'POST', headers: { authorization: 'Bearer jeton' }, body: corps }, res)
  return { res, etat }
}

const laTache = (etat) => etat.taches[0]

// ════════════════════════════════════════════════════════════════════════════
// LE CLAIM AVANT L'ENVOI — le correctif du constat central de l'etape 0
// ════════════════════════════════════════════════════════════════════════════

test('reserver : la tache passe a « sending » et le texte est rendu a l ecran', async () => {
  const { res, etat } = await appeler({ action: 'reserver', task_id: 'tache-1' })
  assert.equal(res.code, 200)
  assert.equal(res.body.texte, 'Le code est au mur.')
  assert.equal(laTache(etat).status, 'sending')
})

test('⚠ reserver DEUX FOIS : le second recoit 409, il n enverra rien', async () => {
  // C'est la course cron/clic du test (b) du brief, vue du cote de l'ecran.
  // Avant ce lot, l'ecran envoyait PUIS clamait : les deux envoyaient.
  const etat = banc()
  const handler = require('../api/messages')
  const r1 = reponse(); const r2 = reponse()
  const req = () => ({ method: 'POST', headers: { authorization: 'Bearer j' },
    body: { action: 'reserver', task_id: 'tache-1' } })
  await handler(req(), r1)
  await handler(req(), r2)
  assert.equal(r1.code, 200)
  assert.equal(r2.code, 409)
  assert.equal(r2.body.error, 'deja_prise')
  assert.equal(etat.taches[0].status, 'sending')
})

test('⚠ reserver une tache DEJA PRISE par le cron : 409', async () => {
  const { res } = await appeler({ action: 'reserver', task_id: 'tache-1' },
    { taches: [tacheType({ status: 'sending' })] })
  assert.equal(res.code, 409)
})

test('reserver une tache deja envoyee : 409, et le statut est dit', async () => {
  const { res } = await appeler({ action: 'reserver', task_id: 'tache-1' },
    { taches: [tacheType({ status: 'done' })] })
  assert.equal(res.code, 409)
  assert.equal(res.body.statut, 'done')
})

test('⚠ relacher rend la tache DESARMEE, pas armee (constat 14 de la revue)', async () => {
  // L ecran ne relache qu apres un ECHEC de posterMessage : c est le cas
  // « on ne sait pas si l envoi est parti ». `reprendreOrphelines` refuse
  // deliberement de renvoyer dans ce doute ; laisser `send_after` dans le passe
  // faisait l inverse — le cron renvoyait le meme brouillon au cycle suivant.
  const { res, etat } = await appeler({ action: 'relacher', task_id: 'tache-1' },
    { taches: [tacheType({ status: 'sending' })] })
  assert.equal(res.code, 200)
  assert.equal(laTache(etat).status, 'pending_validation')
  assert.equal(laTache(etat).send_after, null, 'desarmee : l hote tranche, le cron ne renvoie pas')
  assert.match(laTache(etat).summary, /impossible de savoir si le message est parti/)
})

test('⚠ « Ne pas envoyer » REFUSE une tache claimee par le cron (constat 4)', async () => {
  // Le cron claime et commence l appel provider ; l hote clique « Ne pas
  // envoyer ». Avant, la tache passait a `ignored` et le cron finissait
  // d envoyer : le voyageur recevait le message, l hote lisait « rejetee ».
  const { res, etat } = await appeler(
    { action: 'proposition', task_id: 'tache-1', statut: 'ignored' },
    { taches: [tacheType({ status: 'sending' })] })
  assert.equal(res.code, 409)
  assert.equal(laTache(etat).status, 'sending', 'la tache reste au cron, qui finit son envoi')
})

test('et un ENVOI, lui, clot bien une tache claimee (c est son propre claim)', async () => {
  const { res, etat } = await appeler(
    { action: 'proposition', task_id: 'tache-1', statut: 'done', texte: 'Envoye.' },
    { taches: [tacheType({ status: 'sending' })] })
  assert.equal(res.code, 200)
  assert.equal(laTache(etat).status, 'done')
})

// ════════════════════════════════════════════════════════════════════════════
// LA CLOTURE — et ce que le grep de messages-v5 ne pouvait pas voir
// ════════════════════════════════════════════════════════════════════════════

test('⚠ la cloture DESARME l echeance, sinon le cron relirait la tache comme due', async () => {
  const { res, etat } = await appeler(
    { action: 'proposition', task_id: 'tache-1', statut: 'done', texte: 'Envoye.' })
  assert.equal(res.code, 200)
  assert.equal(laTache(etat).status, 'done')
  assert.equal(laTache(etat).send_after, null, 'send_after NUL : la passe ne la verra plus')
})

test('la cloture accepte une tache RESERVEE (le nouvel ordre des gestes)', async () => {
  // L'ecran reserve, envoie, puis clot : refuser `sending` ici bloquerait la
  // cloture de son propre envoi.
  const { res, etat } = await appeler(
    { action: 'proposition', task_id: 'tache-1', statut: 'done', texte: 'Envoye.' },
    { taches: [tacheType({ status: 'sending' })] })
  assert.equal(res.code, 200)
  assert.equal(laTache(etat).status, 'done')
})

test('« Ne pas envoyer » clot sans texte et desarme aussi', async () => {
  const { res, etat } = await appeler({ action: 'proposition', task_id: 'tache-1', statut: 'ignored' })
  assert.equal(res.code, 200)
  assert.equal(laTache(etat).status, 'ignored')
  assert.equal(laTache(etat).send_after, null)
})

test('⚠ la course entre deux clotures : la seconde recoit 409', async () => {
  const etat = banc()
  const handler = require('../api/messages')
  const r1 = reponse(); const r2 = reponse()
  const req = () => ({ method: 'POST', headers: { authorization: 'Bearer j' },
    body: { action: 'proposition', task_id: 'tache-1', statut: 'done', texte: 'x' } })
  await handler(req(), r1)
  await handler(req(), r2)
  assert.equal(r1.code, 200)
  assert.equal(r2.code, 409)
})

test('une tache close NE PEUT PLUS etre reouverte par une cloture', async () => {
  const { res } = await appeler(
    { action: 'proposition', task_id: 'tache-1', statut: 'done', texte: 'x' },
    { taches: [tacheType({ status: 'ignored' })] })
  assert.equal(res.code, 409)
})

// ════════════════════════════════════════════════════════════════════════════
// LE BROUILLON DE L'HOTE — decisions 6 et 7
// ════════════════════════════════════════════════════════════════════════════

test('⚠ ouvrir le brouillon SUSPEND le compte a rebours, sans le marquer modifie', async () => {
  // Decision 7 : un brouillon jamais touche part la nuit comme en journee. Si
  // l ouverture posait `modifie_le`, l hote qui ouvre, lit et ferme
  // declencherait l alerte de reprise et la sourdine pour rien.
  const { res, etat } = await appeler({ action: 'brouillon', task_id: 'tache-1', ouverture: true })
  assert.equal(res.code, 200)
  assert.ok(laTache(etat).suspendu_le, 'suspendu_le pose')
  assert.equal(laTache(etat).modifie_le, null, 'modifie_le NON pose : rien n a ete ecrit')
  assert.equal(laTache(etat).suggested_reply, 'Le code est au mur.', 'le texte n a pas bouge')
  assert.equal(res.body.modifie, false)
})

test('⚠ enregistrer un brouillon ECRIT LE TEXTE DE L HOTE, et c est lui qui partira', async () => {
  // Decision 6 : sans cette action, la reprise envoyait le texte de l IA — la
  // version que l hote avait justement commence a corriger.
  const { res, etat } = await appeler(
    { action: 'brouillon', task_id: 'tache-1', texte: 'Le code est sur la porte, pas au mur.' })
  assert.equal(res.code, 200)
  const t = laTache(etat)
  assert.equal(t.suggested_reply, 'Le code est sur la porte, pas au mur.')
  assert.ok(t.suspendu_le, 'suspendu aussi')
  assert.ok(t.modifie_le, 'modifie_le pose : la reprise devra ALERTER')
  assert.equal(res.body.modifie, true)
})

test('un brouillon sans texte et sans ouverture : 400', async () => {
  const { res, etat } = await appeler({ action: 'brouillon', task_id: 'tache-1' })
  assert.equal(res.code, 400)
  assert.equal(laTache(etat).modifie_le, null)
})

test('un brouillon trop long : 400', async () => {
  const { res } = await appeler({ action: 'brouillon', task_id: 'tache-1', texte: 'x'.repeat(10001) })
  assert.equal(res.code, 400)
})

test('⚠ une tache DEJA PARTIE ne s edite plus', async () => {
  // Sans cette garde, l hote ecraserait le texte d une reponse deja delivree,
  // et le journal `conversations` dirait autre chose que ce que le voyageur a lu.
  for (const statut of ['done', 'ignored', 'sending']) {
    const { res, etat } = await appeler(
      { action: 'brouillon', task_id: 'tache-1', texte: 'trop tard' },
      { taches: [tacheType({ status: statut })] })
    assert.equal(res.code, 409, `statut ${statut}`)
    assert.equal(laTache(etat).suggested_reply, 'Le code est au mur.', `statut ${statut} : texte intact`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Les gardes communes aux trois actions neuves
// ════════════════════════════════════════════════════════════════════════════

for (const action of ['reserver', 'relacher', 'brouillon']) {
  test(`${action} : sans session -> 401, aucune ecriture`, async () => {
    const { res, etat } = await appeler(
      { action, task_id: 'tache-1', texte: 'x' }, { session: null })
    assert.equal(res.code, 401)
    assert.equal(laTache(etat).status, 'pending_validation')
    assert.equal(laTache(etat).modifie_le, null)
  })

  test(`${action} : tache introuvable -> 404`, async () => {
    const { res } = await appeler({ action, task_id: 'inconnue', texte: 'x' })
    assert.equal(res.code, 404)
  })

  test(`${action} : task_id absent -> 400`, async () => {
    const { res } = await appeler({ action, texte: 'x' })
    assert.equal(res.code, 400)
  })
}

test('les trois actions sont routees', async () => {
  for (const action of ['reserver', 'relacher', 'brouillon']) {
    const { res } = await appeler({ action, task_id: 'tache-1', texte: 'x', ouverture: true })
    assert.notEqual(res.code, 405, `${action} est branchee`)
    assert.notEqual(res.code, null, `${action} rend une reponse`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Les constats de la SECONDE revue, cote endpoint
// ════════════════════════════════════════════════════════════════════════════

test('⚠ CONSTAT 5 : relacher efface AUSSI la suspension', async () => {
  const { res, etat } = await appeler({ action: 'relacher', task_id: 'tache-1' },
    { taches: [tacheType({ status: 'sending', suspendu_le: '2026-11-11T11:30:00.000Z' })] })
  assert.equal(res.code, 200)
  assert.equal(laTache(etat).send_after, null)
  assert.equal(laTache(etat).suspendu_le, null,
    'sinon la bulle dit « vous modifiez » pour toujours, sans issue')
})

test('⚠ CONSTAT 4 : la reprise redonne le temps QUI RESTAIT, fige a la suspension', async () => {
  // Suspendue a 11:30 alors que l echeance etait 12:00 : il restait 30 minutes.
  // Peu importe depuis combien de temps elle est ouverte, la reprise redonne 30.
  const { res, etat } = await appeler({ action: 'reprendre', task_id: 'tache-1' },
    { taches: [tacheType({
      send_after: '2026-11-11T12:00:00.000Z',
      suspendu_le: '2026-11-11T11:30:00.000Z'
    })] })
  assert.equal(res.code, 200)
  assert.ok(res.body.send_after, 'le serveur REND la nouvelle echeance (constat 6)')
  const dans = (Date.parse(res.body.send_after) - Date.now()) / 60000
  assert.ok(Math.abs(dans - 30) < 1, `30 minutes attendues, ${dans.toFixed(1)} rendues`)
  assert.equal(laTache(etat).suspendu_le, null)
})

test('le plancher de 5 minutes s applique aussi a la reprise manuelle', async () => {
  const { res } = await appeler({ action: 'reprendre', task_id: 'tache-1' },
    { taches: [tacheType({
      send_after: '2026-11-11T11:30:30.000Z',
      suspendu_le: '2026-11-11T11:30:00.000Z'
    })] })
  const dans = (Date.parse(res.body.send_after) - Date.now()) / 60000
  assert.ok(Math.abs(dans - 5) < 1, `plancher a 5 minutes, ${dans.toFixed(1)} rendues`)
})

test('reprendre une tache NON suspendue : 409, rien a reprendre', async () => {
  const { res } = await appeler({ action: 'reprendre', task_id: 'tache-1' })
  assert.equal(res.code, 409)
  assert.equal(res.body.error, 'rien_a_reprendre')
})

test('⚠ CONSTAT 4 : l ecran et le serveur calculent la MEME duree de reprise', () => {
  // Le libelle « Envoyer dans X » promettait `send_after - maintenant`, qui
  // decroit pendant la suspension ; le serveur recalcule
  // `max(5 min, send_after - suspendu_le)`, fige. Le bouton promettait donc
  // autre chose que ce que le clic faisait.
  const fs = require('node:fs'); const path = require('node:path')
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages/messages.html'), 'utf8')
  const api = fs.readFileSync(path.join(__dirname, '..', 'api/messages.js'), 'utf8')
  assert.ok(/Math\.max\(REPRISE_MIN_MS_ECRAN, quand - suspendu\)/.test(page),
    'l ecran calcule depuis la SUSPENSION, pas depuis maintenant')
  assert.ok(/Math\.max\(REPRISE_MIN_MS, echeance - suspension\)/.test(api),
    'et le serveur la meme chose')
  // ⚠ LA MEME VALEUR DES DEUX COTES : c'est la dette de duplication notee au
  // KB. Ce test la rend au moins VISIBLE — le jour ou l une bouge, il rougit.
  const vEcran = (page.match(/REPRISE_MIN_MS_ECRAN = (\d+) \* 60 \* 1000/) || [])[1]
  const vApi = (api.match(/REPRISE_MIN_MS = (\d+) \* 60 \* 1000/) || [])[1]
  assert.equal(vEcran, vApi, `plancher ecran ${vEcran} min, plancher serveur ${vApi} min`)
})

test('⚠ CONSTAT 1 : le panneau lit le formulaire AVANT tout re-rendu', () => {
  // `renderTiroir()` fait `corps.innerHTML = voletIA(ref)` sur le MEME
  // conteneur : lire apres, c est relire la BASE. Un hote qui tapait un
  // destinataire d alerte puis cliquait « Enregistrer » envoyait les ANCIENNES
  // valeurs, et lisait « enregistré ».
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'pages/messages.html'), 'utf8')
  // ⚠ SANS LES COMMENTAIRES, et c'est MON test qui me l'a appris : la premiere
  // version cherchait `renderTiroir()` dans le bloc BRUT, et trouvait celui que
  // le commentaire CITE pour expliquer le defaut (« J'appelais `renderTiroir()`
  // d'abord ») — place avant la lecture. Le test rougissait donc sur un code
  // juste, a cause de son propre texte explicatif.
  // Le depot a deja cette lecon ecrite, dans tests/i18n-version.test.js : « un
  // test structurel ne doit pas pouvoir etre satisfait — ni contrarie — par une
  // explication ».
  const sansCommentaires = page
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  const bloc = sansCommentaires.slice(sansCommentaires.indexOf('async function enregistrerPanneau'))
    .slice(0, 900)
  const posLecture = bloc.indexOf('lireLePanneau(corps, ref)')
  const posRender = bloc.indexOf('renderTiroir()')
  assert.ok(posLecture > 0, 'le panneau est lu par lireLePanneau')
  assert.ok(posRender > 0, 'et re-rendu ensuite')
  assert.ok(posLecture < posRender,
    'la LECTURE doit preceder le re-rendu, sinon la saisie non enregistree est perdue')
})

// ─── LES SIX CORRECTIONS DE LA RECETTE DU 28 OCTOBRE 2026 ────────────────────
// Thierry a recette le lot 2 sur staging : « tout fonctionne », et six defauts
// d'AFFICHAGE. Aucun n'etait couvert par un test — ils sont tous dans le rendu,
// la ou les tests de ce chantier regardaient l'endpoint. Ces six-la rougissent
// contre le code d'avant (contre-epreuve faite par `git archive`).
const fsR = require('node:fs')
const pathR = require('node:path')
const lireR = (f) => fsR.readFileSync(pathR.join(__dirname, '..', f), 'utf8')
// ⚠ SANS LES COMMENTAIRES : un test structurel ne doit pouvoir etre ni
// satisfait ni contrarie par une explication (lecon de tests/i18n-version).
const sansCommR = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

test('⚠ RECETTE 1 : « Je valide chaque reponse » est une PILULE, bleue quand inactive', () => {
  const page = lireR('pages/messages.html')
  const css = lireR('shared/ui.css')
  // On ne regarde QUE voletIA : le bouton « Enregistrer » du meme volet est,
  // lui, legitimement un `btn--primary`.
  const bloc = sansCommR(page.slice(page.indexOf('function voletIA'),
    page.indexOf('function voletAlertes')))
  const i = bloc.indexOf('data-delai-manuel')
  assert.ok(i > 0, 'le geste de validation manuelle existe toujours')
  const avant = bloc.slice(Math.max(0, i - 300), i)
  assert.ok(/msg-pilules/.test(avant),
    'il vit dans une rangee de pilules, donc il herite de leur regle')
  assert.ok(/class="tab"/.test(avant), 'et il porte la classe des pilules')
  assert.ok(!/btn--(primary|secondary)/.test(avant),
    'plus de variante de bouton : btn--secondary garde le texte en --ink, '
    + 'donc il avait l air arme meme inactif (constat de recette)')
  // La regle qui donne le sens : bleu = cliquable, bord --ink = etat courant.
  assert.ok(/\.msg-pilules \.tab \{[^}]*color: var\(--info\)/.test(css),
    'une pilule inactive est BLEUE')
  assert.ok(/\.msg-pilules \.tab\[aria-pressed="true"\] \{[^}]*border-color: var\(--ink\)/.test(css),
    'et seule la pilule ACTIVE porte le bord --ink')
})

test('⚠ RECETTE 2 : plus aucun « Auto » dans les textes de l ecran', () => {
  const MORTES = ['messages.auto_scope', 'messages.mode_auto',
    'messages.mode_test', 'messages.mode_label']
  for (const langue of ['fr', 'en', 'es']) {
    const dict = JSON.parse(lireR(`shared/i18n/${langue}.json`))
    for (const cle of MORTES) {
      assert.ok(!(cle in dict), `${langue} : ${cle} doit disparaitre du dictionnaire, `
        + 'pas seulement de l ecran — une traduction orpheline se fait rebrancher')
    }
    assert.ok(!/\bAuto\b/.test(dict['messages.mode_confirm_auto']),
      `${langue} : la confirmation ne nomme plus un mode qui n existe plus`)
  }
  // ⚠ LA PHRASE N EST PAS FIGEE ICI, ET C EST UN CONSTAT DE LA REVIEW. Ma
  // premiere version greppait trois fragments du texte francais : Thierry
  // reformule une confirmation quand il veut, et la suite serait passee au
  // rouge pour une virgule, sans qu aucun defaut n existe. Ce qui doit tenir,
  // c est la PROPRIETE : la confirmation existe encore, elle ne nomme plus un
  // mode disparu, et elle AVERTIT que des reponses partiront sans relecture.
  const fr = JSON.parse(lireR('shared/i18n/fr.json'))['messages.mode_confirm_auto']
  assert.ok(typeof fr === 'string' && fr.trim().length > 20,
    'quitter la validation manuelle reste un geste CONFIRME : sans texte, '
    + 'window.confirm afficherait une boite vide')
  assert.match(fr, /validation/i,
    'elle dit ce qu on perd — la relecture avant envoi au voyageur')
  // Et l ecran ne l affiche plus.
  assert.ok(!/messages\.auto_scope/.test(sansCommR(lireR('pages/messages.html'))),
    'la phrase de portee « En Auto, l IA n envoie seule… » est retiree du volet')
})

test('⚠ RECETTE 3 : sur ordinateur les pilules passent a la ligne, les filtres non', () => {
  const css = lireR('shared/ui.css')
  const m = css.match(/@media \(min-width: 721px\) \{\s*\.msg-pilules \{([^}]*)\}/)
  assert.ok(m, 'une regle propre aux pilules, au-dela du telephone')
  assert.match(m[1], /flex-wrap: wrap/,
    '« Autre… » etait coupe a droite : une rangee qui defile cache une option')
  assert.match(m[1], /overflow-x: visible/,
    'et le defilement horizontal ne doit plus rien masquer sur ordinateur')
  // La greffe sur `.msg-filtres` s arrete ICI : les filtres de la liste
  // restent sur une seule ligne, c est leur comportement voulu.
  assert.ok(!/\.msg-filtres[^{]*\{[^}]*flex-wrap: wrap/.test(css),
    'les filtres de la liste ne doivent PAS heriter du retour a la ligne')
  // Le telephone garde le defilement, barre masquee (retouche du 15 octobre).
  assert.ok(/\.msg-filtres, \.msg-pilules \{[^}]*overflow-x: auto/.test(css))
  assert.ok(/\.msg-pilules::-webkit-scrollbar \{ display: none; \}/.test(css))
})

test('⚠ RECETTE 4 : la note du tiroir est VISIBLE, pas au fond d un panneau qui defile', () => {
  const css = lireR('shared/ui.css')
  const page = lireR('pages/messages.html')
  const m = css.match(/\.msg-tiroir__note \{([^}]*)\}/)
  assert.ok(m, 'la note existe')
  assert.match(m[1], /position: sticky/,
    'elle etait ecrite mais atterrissait hors de l ecran : l hote lisait un '
    + 'silence la ou le code repondait')
  assert.match(m[1], /bottom: 0/)
  assert.match(m[1], /background: var\(--surface\)/,
    'fond opaque, sinon le panneau defile sous le texte')
  // Et c est bien « Enregistré » qui part, avec son drapeau de reussite.
  // ⚠ LE TEXTE DE LA NOTE SE MESURE DESORMAIS EN CLIQUANT, pas en grepant :
  // `tests/messages-panneau-ia-dom.test.js` enregistre pour de vrai et lit la
  // note dans le DOM, dans ses trois cas (succes, refus de la liberation,
  // echec de la propagation). Ce qui reste ici est la seule chose qu un grep
  // mesure mieux qu un clic : que le drapeau vert soit decide par l ABSENCE
  // d echec, et par rien d autre.
  // L ancre est le verrou de fin d enregistrement, pas « la derniere note du
  // fichier » : `testerCanal` vient apres et en pose une aussi.
  const sans = sansCommR(page)
  const iFin = sans.indexOf('etat.panneauEnCours = false')
  assert.ok(iFin > 0, 'le verrou du panneau se retire a la fin de l enregistrement')
  const iDerniere = sans.indexOf('noteReglage(', iFin)
  assert.ok(iDerniere > iFin, 'et la note suit')
  const appel = sans.slice(iDerniere, iDerniere + 500)
  assert.ok(/messages\.panneau_saved/.test(appel), 'un enregistrement complet dit « Enregistré »')
  assert.ok(/echoues\.length === 0\)/.test(appel), 'et le vert se decide sur l absence d echec')
})

test('⚠ RECETTE 5 : aucun gabarit de bulle ne porte de retour à la ligne', () => {
  const page = lireR('pages/messages.html')
  const css = lireR('shared/ui.css')
  // C est `pre-wrap` qui rend le blanc du gabarit VISIBLE : sans lui, le
  // defaut n existerait pas, et ce test n aurait pas de sens.
  assert.ok(/\.bulle \{[^}]*white-space: pre-wrap/.test(css),
    'le blanc se voit parce que .bulle est en pre-wrap')
  // ⚠ TOUT LE GABARIT, PAS SON PREMIER CARACTERE — constat de la review du
  // 28 octobre 2026. Ma premiere version n inspectait que le caractere suivant
  // l ouverture du <div> : elle etait donc VERTE sur le blanc restant dans la
  // bulle d evaluation (entre l entete et les actions, puis avant la
  // fermeture), c est-a-dire sur la majorite des formes que le defaut peut
  // reprendre. Entre deux enfants en `display: flex`, un retour a la ligne
  // engendre une boite de bloc anonyme qui SE REND.
  const re = /<div class="bulle(?=[ $"])[^>]*">/g
  let m, vus = 0
  while ((m = re.exec(page)) !== null) {
    vus++
    const debut = m.index + m[0].length
    const fin = page.indexOf('</div>', debut)
    assert.ok(fin > debut, `bulle a l offset ${m.index} : fermeture introuvable`)
    const gabarit = page.slice(debut, fin)
    assert.ok(!/\n/.test(gabarit),
      `bulle a l offset ${m.index} : le gabarit porte un retour a la ligne — `
      + 'il SE REND (`pre-wrap`), en bande vide. Le gabarit d une bulle tient '
      + `sur une seule ligne. Extrait : ${JSON.stringify(gabarit.slice(0, 120))}`)
  }
  // ⚠ ET LE PERIMETRE SE COMPTE, il ne se suppose pas : le motif ci-dessus
  // greppe UNE forme (`<div class="bulle`). Une bulle ecrite en apostrophes
  // simples, ou avec une classe calculee, en sortirait sans que `vus` ne
  // bronche. On compare donc a toutes les occurrences de `class="bulle` qui ne
  // sont pas `class="bulle-...`, et on refuse les apostrophes simples.
  const toutes = (page.match(/class="bulle(?![-\w])/g) || []).length
  assert.equal(vus, toutes,
    `${vus} gabarit(s) inspecte(s) pour ${toutes} occurrence(s) de class="bulle : `
    + 'une bulle echappe au motif')
  assert.ok(!/class='bulle/.test(page),
    'les bulles s ecrivent en guillemets doubles, pour que ce test les voie')
  assert.ok(vus >= 4, `${vus} gabarit(s) de bulle inspecte(s), au moins 4 attendus`)
})

test('⚠ RECETTE 6 : a instant EGAL, l ordre du fil ne depend pas de l arrivee', () => {
  const page = lireR('pages/messages.html')
  const sans = sansCommR(page)
  const m = sans.match(/const rangAInstantEgal = \(e\) => [^\n]+/)
  assert.ok(m, 'un departage deterministe existe')
  // On l EXECUTE : une forme greppee ne dit pas si l ordre est le bon.
  const rang = new Function(`${m[0]}; return rangAInstantEgal`)()
  const message = { type: 'message' }
  const prop1 = { type: 'proposition', x: { id: '111' } }
  const prop2 = { type: 'proposition', x: { id: '222' } }
  assert.ok(rang(message) < rang(prop1),
    'le message passe avant la proposition qui lui REPOND')
  assert.ok(rang(prop1) < rang(prop2), 'et deux propositions se rangent par id')
  assert.equal(rang(prop1), rang({ type: 'proposition', x: { id: '111' } }),
    'le rang ne depend que de la donnee, jamais de l ordre de lecture')
  assert.ok(/rangAInstantEgal\(a\)\.localeCompare\(rangAInstantEgal\(b\)\)/.test(sans),
    'et le tri du fil s en sert')
  // La base aussi : deux taches nees du meme `insert` portent le meme
  // `created_at` a la microseconde, et PostgREST ne garantit alors aucun ordre.
  assert.ok(/\.order\('created_at', \{ ascending: false \}\)\.order\('id', \{ ascending: true \}\)/
    .test(sans), 'la lecture des taches a un second ordre sur `id`')
})

// ─── LA RECETTE DU 28 OCTOBRE 2026, SECONDE PASSE ────────────────────────────
// Controles A et B conformes ; un defaut, et une decision produit.

test('⚠ RECETTE 7 : sur un bien en PAUSE, le bandeau ne promet aucun envoi', () => {
  const page = lireR('pages/messages.html')
  const sans = sansCommR(page)

  // On EXECUTE le juge des quatre etats : une forme greppee ne dit pas lequel
  // gagne quand deux conditions sont vraies en meme temps.
  const mJuge = sans.match(/function etatEcheance \(x, pauses, fiables\) \{[\s\S]*?\n\}/)
  assert.ok(mJuge, 'un seul juge decide les etats du bandeau')
  const valide = (iso) => iso != null && Number.isFinite(new Date(iso).getTime())
  const juge = new Function('valide', `${mJuge[0]}; return etatEcheance`)(valide)
  // La carte est FIABLE dans la plupart des cas ci-dessous : son defaut a son
  // propre jeu d assertions, plus bas.
  const etatEcheance = (x, pauses) => juge(x, pauses, true)

  const DUE = new Date(Date.now() - 4 * 60000).toISOString()
  const AVENIR = new Date(Date.now() + 50 * 60000).toISOString()
  const EN_PAUSE = { STG3: true }

  // Le defaut releve par Thierry : echue, bien en pause, « Part d'un instant a
  // l'autre » — alors que `brouillons-dus.js` refuse la tache des l'entree.
  assert.equal(etatEcheance({ send_after: DUE, property_id: 'STG3' }, EN_PAUSE), 'pause',
    'une echeance DEPASSEE sur un bien en pause ne dit pas qu elle part')
  // « Meme chose avant l'echeance : pas de compte a rebours sur un bien en pause. »
  assert.equal(etatEcheance({ send_after: AVENIR, property_id: 'STG3' }, EN_PAUSE), 'pause',
    'et pas de compte a rebours avant l echeance non plus')
  // La pause passe avant la suspension : c'est la seule des deux phrases qui
  // explique pourquoi le compte a rebours ne reprendra pas.
  assert.equal(etatEcheance({ send_after: AVENIR, property_id: 'STG3', suspendu_le: DUE }, EN_PAUSE),
    'pause', 'la pause passe avant « vous modifiez »')
  // Et rien n'a bouge pour les biens qui ne sont PAS en pause.
  assert.equal(etatEcheance({ send_after: AVENIR, property_id: 'AUTRE' }, EN_PAUSE), 'compte')
  assert.equal(etatEcheance({ send_after: AVENIR, property_id: 'AUTRE', suspendu_le: DUE }, EN_PAUSE),
    'suspendu')
  assert.equal(etatEcheance({ send_after: null, property_id: 'STG3' }, EN_PAUSE), 'aucun',
    'sans echeance (validation manuelle) il n y a rien a dire, pause ou pas')
  // Un bien absent de la carte, et une carte absente : jamais une exception.
  assert.equal(etatEcheance({ send_after: AVENIR, property_id: 'STG3' }, {}), 'compte')
  assert.equal(etatEcheance({ send_after: AVENIR }, undefined), 'compte')

  // L'etat « pause » est GRIS et porte la phrase de Thierry : l'ambre dit
  // « c'est en cours », et rien n'est en cours.
  const mBandeau = sans.match(/function bandeauEcheance \(x\) \{[\s\S]*?\n\}/)
  assert.ok(mBandeau, 'bandeauEcheance existe')
  // La branche SEULE : du test de l etat jusqu a celui de l etat suivant. Un
  // grep sur toute la fonction serait vert par la branche « suspendu », qui
  // porte deja le gris.
  const iP = mBandeau[0].indexOf("if (e === 'pause')")
  const iS = mBandeau[0].indexOf("if (e === 'suspendu')")
  assert.ok(iP > 0 && iS > iP, 'la pause est testee, et AVANT la suspension')
  const brPause = mBandeau[0].slice(iP, iS)
  assert.ok(/bulle__echeance--suspendu/.test(brPause),
    'la pause reutilise le gris, jamais l ambre')
  assert.ok(!/bulle__echeance">/.test(brPause), 'donc jamais le bandeau ambre nu')
  assert.ok(/messages\.en_pause_pas_seule/.test(brPause),
    'et elle porte sa propre phrase, pas « vous modifiez »')
  assert.ok(!/etiquetteEcheance/.test(brPause),
    'et aucun compte a rebours : c est le defaut de la recette')
  for (const f of ['fr', 'en', 'es']) {
    const dict = JSON.parse(lireR(`shared/i18n/${f}.json`))
    const phrase = dict['messages.en_pause_pas_seule']
    assert.ok(typeof phrase === 'string' && phrase.trim().length > 5,
      `${f} traduit la phrase de la pause`)
    assert.ok(!/\{/.test(phrase), `${f} : la phrase ne prend aucun parametre`)
  }

  // ⚠ « Envoyer dans X » EST un compte a rebours : il ARME une echeance que le
  // serveur refusera, donc il disparait aussi.
  // ⚠ ET ON L EXECUTE, parce que la premiere version de ce test greppait la
  // forme : la revue l a mis en defaut en sortant l expression dans une variable
  // MORTE — le bouton revenait sur un bien en pause, et rien ne rougissait.
  const mReste = sans.match(/const REPRISE_MIN_MS_ECRAN = [^\n]+\n/)
  const mCalc = sans.match(/function resteALaReprise \(x\) \{[\s\S]*?\n\}/)
  const mPeut = sans.match(/function peutReprendre \(x, pauses, fiables\) \{[\s\S]*?\n\}/)
  assert.ok(mReste && mCalc && mPeut, 'la condition du bouton de reprise est une fonction PURE')
  const peutReprendre = new Function('valide',
    `${mReste[0]}${mJuge[0]}\n${mCalc[0]}\n${mPeut[0]}; return peutReprendre`)(valide)

  const suspenduIlYa = (min) => new Date(Date.now() - min * 60000).toISOString()
  assert.equal(peutReprendre(
    { send_after: AVENIR, property_id: 'AUTRE', suspendu_le: suspenduIlYa(5) }, EN_PAUSE, true),
  true, 'hors pause, une tache suspendue garde son « Envoyer dans X »')
  assert.equal(peutReprendre(
    { send_after: AVENIR, property_id: 'STG3', suspendu_le: suspenduIlYa(5) }, EN_PAUSE, true),
  false, 'sur un bien EN PAUSE, le bouton disparait')
  assert.equal(peutReprendre(
    { send_after: AVENIR, property_id: 'AUTRE', suspendu_le: suspenduIlYa(5) }, EN_PAUSE, false),
  false, 'et carte non fiable, il ne promet rien non plus')
  assert.equal(peutReprendre({ send_after: AVENIR, property_id: 'AUTRE' }, EN_PAUSE, true),
    false, 'sans suspension, il n y a rien a reprendre')
  assert.equal(peutReprendre({ send_after: null, property_id: 'AUTRE', suspendu_le: suspenduIlYa(5) },
    EN_PAUSE, true), false, 'et sans echeance non plus')
  // Le pied s en sert, et plus rien d autre ne decide a sa place.
  const mPied = sans.match(/function piedEcheance \(x\) \{[\s\S]*?\n\}/)
  assert.ok(mPied, 'piedEcheance existe')
  assert.ok(/peutReprendre\(x, etat\.pauses, pausesFiables\(\)\)/.test(mPied[0]),
    'le pied appelle la fonction pure')
  assert.ok(!/suspendu_le &&/.test(mPied[0]),
    'et il ne garde aucune copie de la condition')
  // « Ne pas envoyer » reste TOUJOURS : c est la main que l hote garde.
  assert.ok(/data-rejeter="\$\{id\}"/.test(mPied[0]) && !/rejeter[\s\S]{0,40}\?/.test(mPied[0]),
    'l abandon n est jamais conditionne')

  // ⚠ LES DEUX PLACES SONT COMPTEES, PAS SUPPOSEES — constat 1 de la revue du
  // 28 octobre 2026, mesure par mutation : remettre la cascade dans la BULLE
  // laissait ce test vert, donc le defaut exact releve par Thierry pouvait
  // revenir avec la suite entiere au vert. Le perimetre est donc le meme que
  // celui de RECETTE 5 : toute occurrence de la classe, et chacune verifiee.
  const places = [...sans.matchAll(/class="bulle__echeance/g)]
  assert.ok(places.length >= 1, 'la classe du bandeau existe')
  const mBandeauBrut = page.match(/function bandeauEcheance \(x\) \{[\s\S]*?\n\}/)
  assert.ok(mBandeauBrut, 'bandeauEcheance existe dans le fichier brut')
  for (const m of [...page.matchAll(/class="bulle__echeance/g)]) {
    assert.ok(m.index >= mBandeauBrut.index
      && m.index < mBandeauBrut.index + mBandeauBrut[0].length,
      `la classe du bandeau n est ecrite QUE dans bandeauEcheance (trouvee a ${m.index})`)
  }
  // Et les DEUX appelants l appellent : la bulle de proposition du fil...
  const mBulle = sans.match(/morceaux\.push\(`<div class="bulle bulle--proposition[\s\S]*?\n/)
  assert.ok(mBulle, 'le gabarit de la bulle de proposition existe')
  assert.ok(/bandeauEcheance\(x\)/.test(mBulle[0]),
    'la BULLE appelle bandeauEcheance — c est la place ou Thierry a vu le defaut')
  // ...et le bandeau au-dessus de la saisie.
  const mSaisie = sans.match(/function peindreEcheanceSaisie \(\) \{[\s\S]*?\n\}/)
  assert.ok(mSaisie, 'peindreEcheanceSaisie existe')
  assert.ok(/bandeauEcheance\(x\)/.test(mSaisie[0]),
    'la SAISIE appelle le MEME bandeau que la bulle')

  // ⚠ ET QUAND L ECRAN NE SAIT PAS, IL NE PROMET RIEN (constats 4 et 5). La
  // carte des pauses peut etre illisible, et sur un compte DELEGUE elle ne parle
  // pas des biens affiches : /api/property-automation n honore pas `X-Compte`.
  assert.equal(juge({ send_after: AVENIR, property_id: 'AUTRE' }, EN_PAUSE, false), 'inconnu',
    'carte non fiable : aucun compte a rebours')
  assert.equal(juge({ send_after: AVENIR, property_id: 'AUTRE', suspendu_le: DUE }, EN_PAUSE, false),
    'inconnu', 'et pas davantage « vous modifiez », qui ouvrirait la reprise')
  assert.equal(juge({ send_after: DUE, property_id: 'STG3' }, EN_PAUSE, false), 'pause',
    'une pause CONNUE reste dite, meme si la carte est par ailleurs douteuse')
  assert.equal(juge({ send_after: AVENIR, property_id: 'A' }, { A: false }, undefined), 'inconnu',
    'la fiabilite doit etre VRAIE, pas seulement non fausse')
  const mInconnu = sans.match(/function bandeauEcheance \(x\) \{[\s\S]*?\n\}/)
  assert.ok(/=== 'aucun' \|\| e === 'inconnu'\) return ''/.test(mInconnu[0]),
    'et « inconnu » ne peint rien du tout')
  assert.ok(/const pausesFiables = \(\) => etat\.pausesLues === true && estTitulaire\(\)/.test(sans),
    'la fiabilite = lecture reussie ET compte de l appelant')
  assert.ok(/etat\.pausesLues = true/.test(sans) && /etat\.pausesLues = false/.test(sans),
    'les deux ecritures de la carte posent le drapeau')
})

test('⚠ RECETTE 8 : quitter la validation manuelle ne pose plus « Tout de suite »', () => {
  const page = lireR('pages/messages.html')
  const sans = sansCommR(page)

  const mFn = sans.match(/const DELAI_SORTIE_MANUEL = \d+\s*\nfunction delaiDeSortieManuelle \(d\) \{[\s\S]*?\n\}/)
  assert.ok(mFn, 'le delai de sortie est nomme, pas ecrit en litteral dans le geste')
  const sortie = new Function(`${mFn[0]}; return delaiDeSortieManuelle`)()

  // La decision de Thierry : la confirmation dit « apres le delai choisi », donc
  // la sortie pose un delai, jamais l envoi immediat.
  assert.equal(sortie({ reponse_ia: null, reponse_ia_rappel: null }), 15,
    'sans souvenir, la sortie pose 15 min')
  assert.notEqual(sortie({ reponse_ia: null, reponse_ia_rappel: null }), 0,
    'et surtout pas 0 : « Tout de suite » est un envoi sans relecture')
  // Le souvenir du serveur passe avant le defaut.
  assert.equal(sortie({ reponse_ia: null, reponse_ia_rappel: 30 }), 30,
    'les 30 min reglees avant le passage en manuel sont RESTITUEES')
  assert.equal(sortie({ reponse_ia: null, reponse_ia_rappel: 1440 }), 1440, 'la borne haute passe')
  // Un souvenir hors contrat ne gouverne pas : le blob est un JSONB qu aucune
  // contrainte de base ne borne.
  for (const r of [0, -5, 1441, 12.5, '30', null, undefined, {}]) {
    assert.equal(sortie({ reponse_ia: null, reponse_ia_rappel: r }), 15,
      `un rappel ${JSON.stringify(r)} retombe sur le defaut`)
  }
  assert.equal(sortie(null), 15, 'et sans bloc du tout, pas d exception')

  // ⚠ ET L ENTREE EN VALIDATION MANUELLE CAPTURE LA VALEUR COURANTE — constat 6
  // de la revue. On EXECUTE la bascule : sans capture, l hote qui tape 30 min,
  // passe en manuel puis revient retombe a 15, et sa valeur est perdue sans un
  // mot. C est l asymetrie que api/agent-config.js a deja corrigee de son cote.
  const mBasc = sans.match(/function basculerValidationManuelle \(d\) \{[\s\S]*?\n\}/)
  assert.ok(mBasc, 'la bascule est une fonction, pas deux ternaires dans un ecouteur')
  const basculer = new Function(
    `${mFn[0]}\n${mBasc[0]}; return basculerValidationManuelle`)()
  const d = { reponse_ia: 30 }
  basculer(d)
  assert.equal(d.reponse_ia, null, 'entree en validation manuelle')
  assert.equal(d.reponse_ia_rappel, 30, 'les 30 min tapees sont CAPTUREES dans l etat d edition')
  basculer(d)
  assert.equal(d.reponse_ia, 30, 'et restituees au retour, pas remplacees par le defaut')
  // « Tout de suite » ne se memorise pas : ce n est pas un delai.
  const z = { reponse_ia: 0 }
  basculer(z); basculer(z)
  assert.equal(z.reponse_ia, 15, 'un 0 ne devient pas un souvenir')
  // Et le geste de l ecran passe par la, sans refaire le calcul a cote.
  const mEcouteur = sans.match(/\[data-delai-manuel\]'\)\?\.addEventListener\([\s\S]*?\n  \}\)/)
  assert.ok(mEcouteur, 'l ecouteur existe')
  assert.ok(/basculerValidationManuelle\(d\)/.test(mEcouteur[0]), 'et il appelle la bascule')
  assert.ok(!/\? 0 :/.test(mEcouteur[0]), '« Tout de suite » n est plus la sortie par defaut')

  // Le souvenir est LU par l ecran — sinon /api/agent-config le rangeait pour
  // personne — et JAMAIS reecrit par lui : l endpoint en est le writer unique.
  assert.ok(/reponse_ia_rappel: ok && Number\.isInteger\(d\.reponse_ia_rappel\)/.test(sans),
    'delaisDuBien descend le souvenir')
  // La charge postee, delimitee par ses propres accolades plutot que par
  // l indentation : un reformatage ne doit pas rougir pour une raison qui n est
  // pas la sienne (c est deja arrive quatre fois dans ce fichier).
  // ⚠ ET ELLE S ANCRE SUR LE NOM DE LA CHARGE, PAS SUR LE CORPS DE L APPEL : la
  // charge a ete sortie dans `chargeDelais` pour servir aussi a l apercu, et
  // cette assertion a rougi — une cinquieme fois dans ce fichier — pour une
  // raison qui n etait pas la sienne.
  const iEnvoi = sans.indexOf('const chargeDelais = {')
  assert.ok(iEnvoi > 0, 'la charge des delais existe')
  let prof = 0, fin = iEnvoi
  for (let i = sans.indexOf('{', iEnvoi); i < sans.length; i++) {
    if (sans[i] === '{') prof++
    else if (sans[i] === '}') { prof--; if (prof === 0) { fin = i + 1; break } }
  }
  const envoi = sans.slice(iEnvoi, fin)
  assert.ok(/reponse_ia:/.test(envoi) && /sourdine:/.test(envoi), 'la charge est bien delimitee')
  assert.ok(!/reponse_ia_rappel/.test(envoi),
    'l ecran n ECRIT jamais le souvenir : /api/agent-config en est le writer unique')
  assert.ok(!/\.\.\.d\b/.test(envoi), 'et aucun etalement de l etat d edition ne le ferait passer')
  // Et c est bien CETTE charge qui part, aux deux appels (apercu et vrai POST).
  assert.ok(/delais_ref: ref, apercu: true, delais: chargeDelais/.test(sans),
    'l apercu envoie la MEME charge que l enregistrement')
  assert.ok(/\{ delais_ref: ref, delais: chargeDelais, propager \}/.test(sans),
    'et l enregistrement aussi, avec son drapeau de propagation')
})
