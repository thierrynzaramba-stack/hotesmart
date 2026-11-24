// tests/charges-sans-entite-page.test.js — « Sans entité juridique » dans la
// page `/charges` (compte de charges, lot 5 bis ; spec §14.25.5).
//
// ⚠ LE VRAI MODULE DE LA PAGE, DANS UN VRAI DOM (tests/outils/banc-charges.js) :
// ce qui part au serveur se lit dans le journal, pas dans le code.

const test = require('node:test')
const assert = require('node:assert/strict')
const { monter, reponseEcran, facture, ENT, BIEN } = require('./outils/banc-charges')

const SANS_BIEN = 'ffffffff-0000-4000-8000-00000000000f'
const AUTRE_SANS = 'ffffffff-0000-4000-8000-0000000000ff'
const texte = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
// Un compte avec une entité, un logement rattaché (BIEN) et deux logements SANS entité.
const biens = [
  { id: BIEN, nom: 'Studio', entite_id: ENT },
  { id: SANS_BIEN, nom: 'La bulle', entite_id: null },
  { id: AUTRE_SANS, nom: 'Le 23', entite_id: null }
]
const vueSans = (extra = {}) => Object.assign(reponseEcran({ biens, ...extra }), {
  entite: 'sans',
  option_sans_entite: true,
  totaux: { total: { ttc: 5000, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-24T10:00:00Z', entite: 'sans', periode: '2026', proposees: ['2026'], debut: '2026-01-01', fin: '2026-12-31', debut_exercice: '01-01', standard: true },
  credits: { liste: [], echeances: [], aujourdhui: null }
})

test('LE TEST QUI COMPTE : « Sans entité juridique » s\'offre en dernier dans le choix d\'entité, et le choisir relit l\'écran avec `entite=sans`', async () => {
  const urls = []
  const b = await monter({ ecran: (u) => { urls.push(u); return u.includes('entite=sans') ? vueSans() : Object.assign(reponseEcran({ biens }), { option_sans_entite: true }) } })
  try {
    const sel = b.$('[data-choix="entite"]')
    const options = [...sel.options].map(o => [o.value, o.textContent])
    assert.deepEqual(options, [[ENT, 'Moi'], ['sans', 'Sans entité juridique']])
    await b.choisir(sel, 'sans')
    assert.match(urls[urls.length - 1], /[?&]entite=sans(&|$)/)
    assert.equal(b.$('[data-choix="entite"]').value, 'sans')
  } finally { b.fermer() }
  // Sans total sans entité : pas d'option.
  const rien = await monter({ ecran: () => reponseEcran({ biens }) })
  try {
    assert.deepEqual([...rien.$('[data-choix="entite"]').options].map(o => o.value), [ENT])
  } finally { rien.fermer() }
})

test('LE TEST QUI COMPTE : la vue « Sans entité » porte le RAPPEL en tête, son titre, et pas la mention « Réglage standard »', async () => {
  const b = await monter({ ecran: () => vueSans() })
  try {
    const tot = b.$('[data-bind="totaux"]')
    const rappel = tot.querySelector('[data-bind="rappel-sans-entite"]')
    assert.ok(rappel, 'le rappel est là')
    assert.equal(tot.firstElementChild.nextElementSibling, rappel, 'EN TÊTE des totaux (après le titre caché)')
    assert.match(texte(rappel), /logements rattachés à aucune entité juridique/)
    assert.match(texte(rappel), /y passeront d'elles-mêmes/)
    assert.equal(rappel.querySelector('a').getAttribute('href'), '/logements')
    assert.doesNotMatch(texte(tot), /Réglage standard/)
    assert.equal(texte(b.$('[data-bind="liste"] .chg-h2')), 'Factures sans entité juridique')
  } finally { b.fermer() }
  // Une entité garde sa mention, et n'a pas le rappel.
  const e = await monter({ ecran: () => reponseEcran({ biens }) })
  try {
    assert.equal(e.$('[data-bind="rappel-sans-entite"]'), null)
    assert.match(texte(e.$('[data-bind="totaux"]')), /Réglage standard/)
  } finally { e.fermer() }
})

test('LE TEST QUI COMPTE : la fiche d\'une facture d\'un logement sans entité propose « Sans entité » d\'office, ses logements SANS entité, le rappel — et envoie une entité VIDE avec le logement', async () => {
  const c = facture(1, { statut: 'a_verifier', origine: 'email', entite_juridique_id: null, bien_id: SANS_BIEN })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], biens }), geste: () => ({ ok: true, charge: { ...c, statut: 'validee' } }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    const ent = f.querySelector('[data-champ="entite_juridique_id"]')
    assert.equal(ent.value, 'sans', '« Sans entité » proposé d\'office, pas la seule entité active')
    assert.deepEqual([...ent.options].map(o => o.value), ['', ENT, 'sans'])
    const bien = f.querySelector('[data-champ="bien_id"]')
    assert.deepEqual([...bien.options].map(o => o.value), ['', SANS_BIEN, AUTRE_SANS], 'les logements SANS entité, et eux seuls')
    assert.equal(bien.value, SANS_BIEN)
    assert.equal(f.querySelector('[data-bind="rappel-entite"]').hidden, false)
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    const [g] = b.gestes()
    assert.equal(g.action, 'valider')
    assert.equal(g.champs.entite_juridique_id, '', 'VIDE : le serveur ne connaît pas « sans » dans une fiche')
    assert.equal(g.champs.bien_id, SANS_BIEN)
  } finally { b.fermer() }
})

test('« Sans entité » sans logement : la page le dit, et rien ne part', async () => {
  const c = facture(1, { statut: 'a_verifier', entite_juridique_id: null, bien_id: null })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], biens }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    await b.choisir(f.querySelector('[data-champ="entite_juridique_id"]'), 'sans')
    assert.equal(f.querySelector('[data-champ="bien_id"]').value, '')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    assert.deepEqual(b.gestes(), [])
    assert.match(texte(f.querySelector('[data-bind="fiche-retour"]')), /Choisissez le logement : une facture sans entité juridique est celle d'un logement/)
  } finally { b.fermer() }
})

test('le rappel SUIT le choix : affiché sur « Sans entité », caché sur une entité, et le logement de la facture revient avec « Sans entité »', async () => {
  const c = facture(1, { statut: 'a_verifier', entite_juridique_id: null, bien_id: SANS_BIEN })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], biens }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    const ent = f.querySelector('[data-champ="entite_juridique_id"]')
    const rappel = () => f.querySelector('[data-bind="rappel-entite"]').hidden
    await b.choisir(ent, ENT)
    assert.equal(rappel(), true)
    assert.deepEqual([...f.querySelector('[data-champ="bien_id"]').options].map(o => o.value), ['', BIEN])
    await b.choisir(ent, 'sans')
    assert.equal(rappel(), false)
    assert.equal(f.querySelector('[data-champ="bien_id"]').value, SANS_BIEN)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : un compte SANS entité mais avec un logement sans entité VALIDE désormais (« Valider » présent, « Sans entité » choisi)', async () => {
  const c = facture(1, { statut: 'a_verifier', entite_juridique_id: null, bien_id: SANS_BIEN })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], entites: [], biens: [{ id: SANS_BIEN, nom: 'La bulle', entite_id: null }] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.ok(f.querySelector('[data-geste="valider"]'))
    assert.equal(f.querySelector('[data-champ="entite_juridique_id"]').value, 'sans')
    assert.doesNotMatch(texte(f), /charge générale \(sans logement\) demande une entité/)
  } finally { b.fermer() }
})

test('une facture rattachée à une entité garde sa fiche d\'avant : ni rappel affiché, ni « Sans entité » choisi', async () => {
  const c = facture(1, { statut: 'a_verifier' })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], biens }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.equal(f.querySelector('[data-champ="entite_juridique_id"]').value, ENT)
    assert.equal(f.querySelector('[data-champ="bien_id"]').value, BIEN)
    assert.equal(f.querySelector('[data-bind="rappel-entite"]').hidden, true)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : l\'export « Sans entité » demande `entite=sans` et s\'intitule « Sans entité juridique », sans SIRET', async () => {
  const urls = []
  const ligne = { id: facture(1).id, jour: '2026-11-02', date_facture: '2026-11-02', fournisseur_nom: 'EDF', fournisseur_siret: null, numero_facture: 'F-1', type_document: 'facture', categorie: 'energie', bien_id: SANS_BIEN, periode_debut: null, periode_fin: null, montant_ht_cents: 4000, montant_tva_cents: 1000, montant_ttc_cents: 5000, origine: 'email', justificatif_type: null, cree_le: '2026-11-02T10:00:00Z', fichier: false, compte: true }
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      if (u.includes('export=1')) return { export: { entite: { id: 'sans', nom: null, siret: null, sans: true }, periode: '2026', debut: '2026-01-01', fin: '2026-12-31', standard: true, lignes: [ligne], a_traiter: 0 } }
      return vueSans()
    }
  })
  try {
    await b.cliquer(b.$('[data-geste="exporter"]'))
    for (let i = 0; i < 100; i++) await b.attendre()
    assert.equal(urls[1], '/api/ecran/charges?export=1&entite=sans&periode=2026')
    assert.equal(b.journal.zips.length, 1, 'un ZIP')
    assert.deepEqual(b.journal.clics.map(c => c.download), ['Charges-2026-Sans-entite-juridique.zip'])
  } finally { b.fermer() }
})
