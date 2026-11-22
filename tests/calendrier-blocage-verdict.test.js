// tests/calendrier-blocage-verdict.test.js
// UN BLOCAGE N'EST « FAIT » QUE SI LE CANAL L'A ACCEPTE.
//
// `fermer`, `modifier_fermeture` et `rouvrir_fermeture` (api/calendar.js)
// rendent `push_failed` (le canal a refuse), `local_only` (rien d'envoye : pas
// de plan tarifaire) et `warnings`. Les trois gestes de blocage de la page les
// ignoraient : « Blocage cree », « Enregistre », « Blocage supprime »
// s'affichaient quoi qu'il arrive, meme quand le canal avait refuse
// (docs/specs/spec-toast-bloquer.md ; ce que le lot NE couvre PAS y est dit).
//
// ⚠ CES TESTS EXECUTENT LE MODULE DE LA PAGE (tests/outils/banc-calendrier.js) :
// le geste est rejoue dans un vrai DOM, la requete traverse `fetch`, et le
// verdict est lu dans les toasts, la ou l'hote le lit.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const B = require('./outils/banc-calendrier.js')

const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const CREE = FR['cal.block_created']
const SUPPRIME = FR['cal.block_deleted']
const ENREGISTRE = FR['cal.saved']
const NON_PUBLIE = FR['cal.block_push_failed']
const ICI_SEULEMENT = FR['cal.local_only']

const BIEN = {
  id: 'B1', name: 'La bulle', provider: 'channex', capacity: 2, currency: 'EUR',
  pilote_tarifaire: 'yieldflow', provider_property_id: 'P1', base_price: null,
  included_guests: 2, extra_guest_fee: 0
}

const OK = { saved: 2, pushed: true, local_only: false, push_failed: false, warnings: [] }

// Un banc dont la reponse au geste de blocage est imposee. Les dates sont
// CALCULEES a partir de l'horloge (le formulaire refuse un debut passe) et prises
// dans une fenetre de trois mois, jamais par leur rang dans le mois.
function banc (reponse) {
  const b = B.monter({ large: true, appel: async (chemin, corps) => {
    if (corps && /fermer|fermeture/.test(String(corps.action))) return reponse
    return {}
  } })
  const jours = B.peupler(b, { biens: [BIEN], jours: 3 })
  const avenir = jours.filter(iso => iso > b.cal.AUJOURDHUI)
  return { b, nuits: avenir.slice(3, 5) }
}

const attendre = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) }

async function bloquer (b, nuits) {
  b.cal.ouvrirFormulaire('bloquer', nuits, 'B1')
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  corps.querySelector('[data-aj="raison"]').value = 'Travaux'
  corps.querySelector('[data-aj-save]').click()
  await attendre()
}

function ficheBlocage (b, nuits) {
  b.cal.etat.fermetures = { B1: [{ id: 'F1', date_debut: nuits[0], date_fin: nuits[1], raison: 'Travaux' }] }
  b.cal.ouvrirFicheBlocage('B1', 'F1')
  return b.doc.querySelector('[data-bind="feuille-corps"]')
}

const envoi = (b, action) => b.envois.find(e => e.corps && e.corps.action === action)

// ─── Bloquer ────────────────────────────────────────────────────────────────

test('Bloquer : la plateforme refuse -> « NON PUBLIE », jamais « Blocage cree »', async () => {
  const { b, nuits } = banc({ ...OK, pushed: false, push_failed: true })
  await bloquer(b, nuits)
  assert.ok(envoi(b, 'fermer'), 'le geste est bien parti au serveur')
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(NON_PUBLIE), 'l echec est dit : ' + JSON.stringify(toasts))
  assert.ok(!toasts.includes(CREE), 'le succes n est PAS annonce : ' + JSON.stringify(toasts))
  const erreur = [...b.doc.querySelectorAll('.cal-toast')].find(e => e.textContent.includes(NON_PUBLIE))
  assert.ok(erreur.classList.contains('cal-toast--erreur'), 'et il est affiche comme une erreur')
  b.fermer()
})

test('Bloquer : logement sans plan tarifaire -> « enregistre ici seulement », pas « Blocage cree »', async () => {
  const { b, nuits } = banc({ ...OK, pushed: false, local_only: true })
  await bloquer(b, nuits)
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(ICI_SEULEMENT), JSON.stringify(toasts))
  assert.ok(!toasts.includes(CREE), JSON.stringify(toasts))
  b.fermer()
})

// L'avertissement que le writer pose en mode « je garde mes prix » (le mode
// PAR DEFAUT d'un logement : lib/calendrier-writer.js). Il dit que les
// reouvertures ne partent pas — faux pour un blocage, dont le stop_sell part
// dans tous les modes. Constat 1 de la review : il ne doit pas s'afficher.
const AVERTISSEMENT_KEEP = 'Enregistré dans HôteSmart — ce logement est en « je garde mes prix » : '
  + 'vos tarifs et vos réouvertures ne sont PAS envoyés aux plateformes. '
  + 'Passez-le en « HôteSmart gère mes prix » pour qu\'ils partent.'

test('Bloquer : la plateforme accepte -> « Blocage cree », sans l avertissement du mode « je garde mes prix »', async () => {
  const { b, nuits } = banc({ ...OK, pushed: false, warnings: [AVERTISSEMENT_KEEP] })
  await bloquer(b, nuits)
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(CREE), JSON.stringify(toasts))
  assert.ok(!toasts.includes(AVERTISSEMENT_KEEP), 'l avertissement du writer, faux ici, n est pas montre : ' + JSON.stringify(toasts))
  assert.ok(!toasts.includes(NON_PUBLIE), JSON.stringify(toasts))
  // Ce que la PAGE passe a `api.calendar.fermer` : le bien par son UUID, la
  // premiere et la derniere nuit. (Le corps de la requete, lui, est construit
  // par `shared/api-client.js` ; ce test ne le prouve pas.)
  const c = envoi(b, 'fermer').corps
  assert.equal(c.property_id, 'B1')
  assert.equal(c.debut, nuits[0])
  assert.equal(c.fin, nuits[1])
  b.fermer()
})

// ─── Supprimer un blocage ───────────────────────────────────────────────────

test('Supprimer un blocage : la plateforme refuse -> « NON PUBLIE », jamais « Blocage supprime »', async () => {
  const { b, nuits } = banc({ ...OK, pushed: false, push_failed: true })
  b.window.confirm = () => true
  ficheBlocage(b, nuits).querySelector('[data-b-suppr]').click()
  await attendre()
  assert.ok(envoi(b, 'rouvrir_fermeture'), 'le geste est bien parti au serveur')
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(NON_PUBLIE), JSON.stringify(toasts))
  assert.ok(!toasts.includes(SUPPRIME), JSON.stringify(toasts))
  b.fermer()
})

// Constat 3 de la review : la fermeture est retiree, mais la relecture des
// fermetures echoue et RIEN n'est rouvert (`saved: 0`, api/calendar.js). Dire
// « nuits rouvertes » serait faux ; l'avertissement du serveur dit quoi faire.
test('Supprimer un blocage : rien n a ete rouvert -> jamais « nuits rouvertes », et le motif est montre', async () => {
  const MOTIF = 'Fermeture retirée, mais la période n\'a pas été rouverte (fermetures illisibles : x). Rouvrez-la depuis le calendrier.'
  const { b, nuits } = banc({ saved: 0, pushed: false, local_only: false, push_failed: false, warnings: [MOTIF] })
  b.window.confirm = () => true
  ficheBlocage(b, nuits).querySelector('[data-b-suppr]').click()
  await attendre()
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(FR['cal.block_deleted_none']), JSON.stringify(toasts))
  assert.ok(toasts.includes(MOTIF), JSON.stringify(toasts))
  assert.ok(!toasts.includes(SUPPRIME), 'la promesse « nuits rouvertes » n est pas faite : ' + JSON.stringify(toasts))
  b.fermer()
})

test('Supprimer un blocage : la plateforme accepte -> « Blocage supprime »', async () => {
  const { b, nuits } = banc(OK)
  b.window.confirm = () => true
  ficheBlocage(b, nuits).querySelector('[data-b-suppr]').click()
  await attendre()
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(SUPPRIME), JSON.stringify(toasts))
  assert.ok(!toasts.includes(NON_PUBLIE), JSON.stringify(toasts))
  b.fermer()
})

// ─── Modifier un blocage ────────────────────────────────────────────────────

test('Modifier un blocage : la plateforme refuse -> « NON PUBLIE », jamais « Enregistre »', async () => {
  const { b, nuits } = banc({ ...OK, pushed: false, push_failed: true })
  const corps = ficheBlocage(b, nuits)
  corps.querySelector('[data-b="raison"]').value = 'Travaux de peinture'
  corps.querySelector('[data-b-save]').click()
  await attendre()
  assert.ok(envoi(b, 'modifier_fermeture'), 'le geste est bien parti au serveur')
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(NON_PUBLIE), JSON.stringify(toasts))
  assert.ok(!toasts.includes(ENREGISTRE), JSON.stringify(toasts))
  b.fermer()
})

test('Modifier un blocage : la plateforme accepte -> « Enregistre »', async () => {
  const { b, nuits } = banc(OK)
  const corps = ficheBlocage(b, nuits)
  corps.querySelector('[data-b="raison"]').value = 'Travaux de peinture'
  corps.querySelector('[data-b-save]').click()
  await attendre()
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(ENREGISTRE), JSON.stringify(toasts))
  b.fermer()
})

// Seule la raison change : le serveur n'ecrit aucune nuit (`saved: 0`) et dit
// pourquoi certaines restent fermees. « Enregistre » est juste, et le motif suit.
test('Modifier un blocage : rien a ecrire -> « Enregistre », et le motif du serveur est montre', async () => {
  const MOTIF = '2 nuit(s) restent fermées par une autre fermeture.'
  const { b, nuits } = banc({ saved: 0, pushed: false, local_only: false, push_failed: false, warnings: [MOTIF] })
  const corps = ficheBlocage(b, nuits)
  corps.querySelector('[data-b="raison"]').value = 'Travaux de peinture'
  corps.querySelector('[data-b-save]').click()
  await attendre()
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(ENREGISTRE), JSON.stringify(toasts))
  assert.ok(toasts.includes(MOTIF), JSON.stringify(toasts))
  b.fermer()
})

// Les textes existent dans les trois langues (une cle absente afficherait son nom).
test('les messages d un blocage existent en francais, anglais et espagnol', () => {
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', l + '.json'), 'utf8'))
    for (const k of ['cal.block_push_failed', 'cal.block_deleted_none']) {
      assert.ok(d[k] && d[k].length > 20, l + ' ' + k)
    }
  }
})
