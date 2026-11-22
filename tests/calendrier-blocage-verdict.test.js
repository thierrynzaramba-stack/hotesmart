// tests/calendrier-blocage-verdict.test.js
// UN BLOCAGE N'EST « FAIT » QUE SI LA PLATEFORME L'A ACCEPTE.
//
// `fermer`, `modifier_fermeture` et `rouvrir_fermeture` (api/calendar.js)
// rendent `push_failed` (le canal a refuse), `local_only` (rien d'envoye : pas
// de plan tarifaire) et `warnings`. Les trois gestes de blocage de la page les
// ignoraient : « Blocage cree », « Enregistre », « Blocage supprime »
// s'affichaient quoi qu'il arrive. L'hote croyait sa nuit fermee chez Airbnb et
// Booking alors qu'elle y restait vendable — ou rouverte alors qu'elle y restait
// fermee (spec-fermetures-canaux.md §1, « aucune alerte »).
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

test('Bloquer : la plateforme accepte -> « Blocage cree », et l avertissement du serveur est montre', async () => {
  const { b, nuits } = banc({ ...OK, warnings: ['Deux nuits etaient deja fermees.'] })
  await bloquer(b, nuits)
  const toasts = b.lireToasts()
  assert.ok(toasts.includes(CREE), JSON.stringify(toasts))
  assert.ok(toasts.includes('Deux nuits etaient deja fermees.'), JSON.stringify(toasts))
  assert.ok(!toasts.includes(NON_PUBLIE), JSON.stringify(toasts))
  // Le contrat de l'appel n'a pas bouge : le bien par son UUID, la derniere nuit.
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

// Le texte existe dans les trois langues (une cle absente afficherait son nom).
test('le message « NON PUBLIE » d un blocage existe en francais, anglais et espagnol', () => {
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', l + '.json'), 'utf8'))
    assert.ok(d['cal.block_push_failed'] && d['cal.block_push_failed'].length > 20, l)
  }
})
