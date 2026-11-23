// tests/charges-email-page.test.js — lot 5 (§14.24) dans la VRAIE page
// (tests/outils/banc-charges.js) : « Envoyer par e-mail », la fenêtre des
// adresses, « Copier », « Changer », la ligne « sans facture lisible » et le
// rappel « entité juridique manquante ».

const test = require('node:test')
const assert = require('node:assert/strict')
const { monter, reponseEcran, facture, ENT, BIEN, id } = require('./outils/banc-charges')

const texte = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const SANS_ENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const BIENS = [{ id: BIEN, nom: 'Studio', entite_id: ENT }, { id: SANS_ENT, nom: 'Ofuro Futari', entite_id: null }]
const ADRESSES = {
  ok: true,
  entites: [{ id: ENT, nom: 'Moi', adresse: 'moi.p7x2m9qa@reply.hotesmart.fr' }],
  biens: [
    { id: BIEN, nom: 'Studio', entite_id: ENT, adresse: 'studio.k2j9x7q4@reply.hotesmart.fr' },
    { id: SANS_ENT, nom: 'Ofuro Futari', entite_id: null, adresse: 'ofuro-futari.w4n8c1rd@reply.hotesmart.fr' }
  ]
}
const geste = (c) => {
  if (c.action === 'adresses') return ADRESSES
  if (c.action === 'adresse_changer') return { ok: true, adresse: 'ofuro-futari.n3wc0d3x@reply.hotesmart.fr' }
  return { ok: true }
}

test('LE TEST QUI COMPTE : sous « Ajouter une facture », « Envoyer par e-mail » ouvre une fenêtre — UN appel, à l\'ouverture seulement — avec une adresse par entité et par logement, et le rappel pour un logement sans entité', async () => {
  const b = await monter({ ecran: () => reponseEcran({ biens: BIENS }), geste })
  try {
    const lien = b.$('[data-action="email"]')
    assert.equal(texte(lien), 'Envoyer par e-mail')
    assert.equal(lien.hidden, false)
    assert.equal(b.gestes().length, 0, 'l\'écran ne charge aucune adresse au départ')
    await b.cliquer(lien)
    assert.deepEqual(b.gestes(), [{ action: 'adresses' }])
    const f = b.$('[data-bind="email"]')
    assert.ok(f.open || f.hasAttribute('open'))
    assert.equal(texte(f.querySelector('#chg-email-titre')), 'Envoyer vos factures par e-mail')
    const lignes = [...f.querySelectorAll('[data-email-id]')]
    assert.deepEqual(lignes.map(l => [l.dataset.emailCible, texte(l.querySelector('.chg-email__nom')), texte(l.querySelector('[data-bind="email-adresse"]'))]), [
      ['entite', 'Moi', 'moi.p7x2m9qa@reply.hotesmart.fr'],
      ['bien', 'Studio', 'studio.k2j9x7q4@reply.hotesmart.fr'],
      ['bien', 'Ofuro Futari', 'ofuro-futari.w4n8c1rd@reply.hotesmart.fr']
    ])
    assert.equal(lignes[1].querySelector('.chg-email__rappel'), null)
    assert.match(texte(lignes[2].querySelector('.chg-email__rappel')), /Entité juridique manquante/)
    // Rouvrir relit (une adresse peut avoir changé ailleurs), toujours en UN appel.
    await b.cliquer(f.querySelector('[data-geste="email-fermer"]'))
    assert.ok(!f.open && !f.hasAttribute('open'))
    await b.cliquer(lien)
    assert.equal(b.gestes().length, 2)
  } finally { b.fermer() }
})

test('« Copier » met l\'adresse de SA ligne dans le presse-papiers et le dit ; un refus du navigateur le dit aussi', async () => {
  const b = await monter({ ecran: () => reponseEcran({ biens: BIENS }), geste })
  try {
    await b.cliquer(b.$('[data-action="email"]'))
    const li = b.$$('[data-email-id]')[2]
    await b.cliquer(li.querySelector('[data-geste="email-copier"]'))
    assert.deepEqual(b.journal.copies, ['ofuro-futari.w4n8c1rd@reply.hotesmart.fr'])
    assert.equal(texte(li.querySelector('[data-bind="email-retour"]')), 'Adresse copiée.')
  } finally { b.fermer() }
  const b2 = await monter({ ecran: () => reponseEcran({ biens: BIENS }), geste, copier: () => { throw new Error('refusé') } })
  try {
    await b2.cliquer(b2.$('[data-action="email"]'))
    const li = b2.$$('[data-email-id]')[0]
    await b2.cliquer(li.querySelector('[data-geste="email-copier"]'))
    assert.match(texte(li.querySelector('[data-bind="email-retour"]')), /La copie n'a pas marché/)
  } finally { b2.fermer() }
})

test('« Changer » demande confirmation (l\'ancienne adresse ne recevra plus rien), envoie la CIBLE de sa ligne, et affiche la nouvelle adresse ; refusé, rien ne part', async () => {
  const b = await monter({ ecran: () => reponseEcran({ biens: BIENS }), geste })
  try {
    await b.cliquer(b.$('[data-action="email"]'))
    const li = b.$$('[data-email-id]')[2]
    await b.cliquer(li.querySelector('[data-geste="email-changer"]'))
    assert.match(b.journal.confirmations.at(-1), /L'ancienne adresse ne recevra plus rien/)
    assert.deepEqual(b.gestes().at(-1), { action: 'adresse_changer', bien_id: SANS_ENT })
    assert.equal(texte(li.querySelector('[data-bind="email-adresse"]')), 'ofuro-futari.n3wc0d3x@reply.hotesmart.fr')
    assert.match(texte(li.querySelector('[data-bind="email-retour"]')), /Nouvelle adresse/)
    // L'entité : `entite_id`.
    await b.cliquer(b.$$('[data-email-id]')[0].querySelector('[data-geste="email-changer"]'))
    assert.deepEqual(b.gestes().at(-1), { action: 'adresse_changer', entite_id: ENT })
  } finally { b.fermer() }
  const b2 = await monter({ ecran: () => reponseEcran({ biens: BIENS }), geste, confirmer: false })
  try {
    await b2.cliquer(b2.$('[data-action="email"]'))
    await b2.cliquer(b2.$$('[data-email-id]')[1].querySelector('[data-geste="email-changer"]'))
    assert.deepEqual(b2.gestes(), [{ action: 'adresses' }])
  } finally { b2.fermer() }
})

test('une panne à l\'ouverture se dit dans la fenêtre (pas une fenêtre vide)', async () => {
  const b = await monter({ ecran: () => reponseEcran({ biens: BIENS }), geste: () => { throw { status: 503, error: 'panne' } } })
  try {
    await b.cliquer(b.$('[data-action="email"]'))
    assert.match(texte(b.$('[data-bind="email"]')), /Envoyer vos factures par e-mail/)
    assert.ok(b.$('[data-bind="email"] .chg-erreur'))
  } finally { b.fermer() }
})

test('⚠ pas titulaire : le lien n\'existe pas (le serveur refuse de toute façon en 403)', async () => {
  const b = await monter({ titulaire: false })
  try {
    assert.equal(b.$('[data-action="email"]').hidden, true)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : un e-mail reçu sans facture lisible est dans « À traiter », nommé par son expéditeur et son sujet, sans montant ; sa fiche montre ce qu\'on a reçu, et seul « Supprimer » s\'y propose', async () => {
  const sf = facture(7, {
    statut: 'sans_facture', motif: 'sans_piece', origine: 'email', bien_id: SANS_ENT, entite_juridique_id: null,
    fournisseur_nom: null, montant_ttc_cents: null, montant_ht_cents: null, montant_tva_cents: null, categorie: null,
    email_expediteur: 'edf@edf.fr', email_sujet: 'Votre facture de novembre', email_texte: 'Bonjour,\nla facture est en ligne.',
    email_recu_le: '2026-11-23T15:00:00Z', valide_le: null
  })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [sf], biens: BIENS }), geste })
  try {
    const l = b.$('[data-bind="a-traiter"] [data-ouvrir]')
    assert.equal(texte(l.querySelector('.chg-ligne__qui b')), 'edf@edf.fr')
    assert.match(texte(l.querySelector('.chg-ligne__infos')), /Votre facture de novembre · Ofuro Futari · Entité juridique manquante/)
    assert.equal(texte(l.querySelector('.chg-ligne__ttc')), '', 'ni « non lu », ni 0')
    assert.equal(texte(l.querySelector('.chg-etat')), 'Sans facture lisible')
    await b.cliquer(l)
    const f = b.$('[data-bind="fiche"]')
    assert.equal(texte(f.querySelector('#chg-fiche-titre')), 'E-mail reçu')
    assert.match(texte(f), /Cet e-mail n'a pas de facture en pièce jointe/)
    assert.match(texte(f), /edf@edf\.fr/)
    assert.match(texte(f), /Votre facture de novembre/)
    assert.equal(f.querySelector('.chg-email-recu__texte').textContent, 'Bonjour,\nla facture est en ligne.')
    assert.match(texte(f), /Entité juridique manquante : rattachez ce logement/)
    assert.equal(f.querySelector('[data-champ]'), null, 'pas de formulaire')
    assert.deepEqual([...f.querySelectorAll('.chg-fiche__pied button')].map(x => x.dataset.geste), ['supprimer'])
    await b.cliquer(f.querySelector('[data-geste="supprimer"]'))
    assert.deepEqual(b.gestes().at(-1), { action: 'supprimer', id: id(7) })
  } finally { b.fermer() }
})

test('une facture REÇUE PAR E-MAIL pour un logement sans entité porte le rappel, dans sa ligne et dans sa fiche ; rattachée, le rappel tombe', async () => {
  const c = facture(8, { statut: 'a_verifier', origine: 'email', bien_id: SANS_ENT, entite_juridique_id: null, email_expediteur: 'edf@edf.fr', valide_le: null })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], biens: BIENS }), geste })
  try {
    const l = b.$('[data-bind="a-traiter"] [data-ouvrir]')
    assert.match(texte(l.querySelector('.chg-ligne__infos')), /^reçue par e-mail · .*Ofuro Futari · Entité juridique manquante$/)
    await b.cliquer(l)
    const f = b.$('[data-bind="fiche"]')
    assert.match(texte(f), /Entité juridique manquante : rattachez ce logement/)
    assert.match(texte(f), /Reçue par e-mail, de edf@edf\.fr\./)
    assert.ok(f.querySelector('[data-geste="voir"]'), 'le justificatif se consulte')
  } finally { b.fermer() }
  const rattache = BIENS.map(x => (x.id === SANS_ENT ? { ...x, entite_id: ENT } : x))
  const b2 = await monter({ ecran: () => reponseEcran({ aTraiter: [c], biens: rattache }), geste })
  try {
    assert.doesNotMatch(texte(b2.$('[data-bind="a-traiter"] [data-ouvrir]')), /Entité juridique manquante/)
  } finally { b2.fermer() }
})

test('recette du 23 novembre : « Envoyer par e-mail » se range SOUS le bouton (à droite, comme lui), quelle que soit la règle `.chg-lien` plus bas dans la feuille', () => {
  const { JSDOM } = require('jsdom')
  const fs = require('node:fs')
  const path = require('node:path')
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'charges.html'), 'utf8')
  const barre = /<div class="chg-barre">[\s\S]*?<\/div>/.exec(page)[0]
  const d = new JSDOM(`<style>${css}</style>${barre}`)
  const doc = d.window.document
  const b = doc.querySelector('.chg-barre')
  const lien = doc.querySelector('[data-action="email"]')
  assert.equal(lien.parentElement, b, 'dans la barre du bouton')
  assert.ok(doc.querySelector('[data-action="ajouter"]').compareDocumentPosition(lien) & d.window.Node.DOCUMENT_POSITION_FOLLOWING, 'après le bouton')
  assert.equal(d.window.getComputedStyle(b).flexDirection, 'column', 'l\'un sous l\'autre')
  assert.equal(d.window.getComputedStyle(b).alignItems, 'flex-end')
  assert.equal(d.window.getComputedStyle(lien).alignSelf, 'flex-end')
  // ⚠ jsdom ne compare pas les spécificités (l'ordre seul tranche) : le
  // sélecteur composé, qui fait gagner la règle dans un vrai navigateur, se
  // vérifie à part.
  assert.match(css, /\.chg-barre \.chg-lien-email \{ align-self: flex-end; \}/)
  assert.ok(css.indexOf('.chg-barre .chg-lien-email') > css.indexOf('.chg-lien {'), 'après `.chg-lien`')
})
