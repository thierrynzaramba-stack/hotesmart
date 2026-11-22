// tests/charges-masse-page.test.js — lot 8c (§14.22) : l'écran.
// Dépôt de plusieurs fichiers rattachés à l'entité affichée, « À traiter » qui
// se lit au-delà de 50, parcours « une par une » dans l'ordre de dépôt,
// « Enregistrer tout » par paquets, et la facture à droite de sa fiche à
// l'ordinateur. Les gestes se mesurent en cliquant (tests/outils/banc-charges.js).

const test = require('node:test')
const assert = require('node:assert/strict')
const { monter, reponseEcran, facture, ENT, id } = require('./outils/banc-charges')

const texte = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const aVerifier = (n, extra = {}) => facture(n, { statut: 'a_verifier', valide_le: null, cree_le: `2026-11-22T10:00:${String(n).padStart(2, '0')}Z`, ...extra })
// Un écran qui répond au parcours, et à tout le reste comme d'habitude.
const ecranAvec = ({ aTraiter = [aVerifier(1)], parcours = () => ({ lignes: [], suite: null, nombre: 0 }), autre = {} } = {}) => (url) => {
  const u = new URL(url, 'https://hs.test')
  if (u.searchParams.has('parcours')) return { parcours: parcours(u.searchParams.get('parcours')) }
  return reponseEcran({ aTraiter, ...autre })
}

// ─── Le dépôt en masse ──────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : plusieurs fichiers partent UN PAR UN, SANS entité (la lecture la reconnaît) ; un refusé n\'arrête pas les autres et il est NOMMÉ', async () => {
  let n = 0
  const geste = (c) => (c.action === 'envoi' ? { ok: true, id: id(500 + ++n), url: `https://stockage.test/${n}` } : { ok: true, issue: 'a_verifier', charge: aVerifier(500 + n) })
  const b = await monter({ geste })
  try {
    await b.deposerFichiers([['a.pdf', 'application/pdf'], ['notes.txt', 'text/plain', 'du texte'], ['b.pdf', 'application/pdf']])
    const gestes = b.gestes()
    assert.deepEqual(gestes.map(g => g.action), ['envoi', 'confirmer', 'envoi', 'confirmer'])
    assert.deepEqual(gestes.filter(g => g.action === 'envoi').map(g => 'entite_id' in g), [false, false], 'aucune entité ne part avec l\'envoi (décision de Thierry)')
    assert.equal(b.$('[data-bind="envoi-entite"]'), null, 'plus de phrase « rattachées à »')
    assert.equal(b.journal.fetch.filter(f => f.url.startsWith('https://stockage.test/')).length, 2)
    const statut = texte(b.$('[data-bind="envoi"]'))
    assert.match(statut, /2 factures déposées\. 1 refusées : notes\.txt \(Seuls les PDF et les images sont acceptés\.\)/)
    assert.equal(b.$('[data-bind="fiche"]').open, false, 'aucune fiche ne s\'ouvre au milieu d\'un dépôt de plusieurs')
    assert.equal(b.lecturesEcran().length, 2, 'l\'écran est relu UNE fois, à la fin')
  } finally { b.fermer() }
})

test('plus de 50 fichiers : rien ne part, et l\'écran le dit', async () => {
  const b = await monter()
  try {
    await b.deposerFichiers(Array.from({ length: 51 }, (_, i) => [`f${i}.pdf`, 'application/pdf']))
    assert.deepEqual(b.gestes(), [])
    assert.match(texte(b.$('[data-bind="envoi"]')), /50 fichiers au plus à la fois : vous en avez choisi 51\. Rien n'est parti\./)
  } finally { b.fermer() }
})

// ─── « À traiter » au-delà de 50 (dette 153) ────────────────────────────────
test('LE TEST QUI COMPTE (dette 153) : « Afficher plus » lit la SUITE de « À traiter » et l\'ajoute', async () => {
  const suite = '2026-11-22T10:00:01Z|' + id(1)
  const b = await monter({
    ecran: (url) => (url.includes('suite_a_traiter=')
      ? { a_traiter: { lignes: [aVerifier(2)], suite: null } }
      : { ...reponseEcran({ aTraiter: [aVerifier(1)], nombre: 51 }), a_traiter: { lignes: [aVerifier(1)], nombre: 51, suite } })
  })
  try {
    const z = b.$('[data-bind="a-traiter"]')
    await b.cliquer(z.querySelector('[data-geste="plus-a-traiter"]'))
    assert.equal(b.lecturesEcran()[1].url, '/api/ecran/charges?suite_a_traiter=' + encodeURIComponent(suite))
    assert.equal(z.querySelectorAll('.chg-ligne').length, 2)
    assert.equal(z.querySelector('[data-geste="plus-a-traiter"]'), null, 'plus de suite, plus de bouton')
  } finally { b.fermer() }
})

// ─── Le parcours « une par une » ────────────────────────────────────────────
test('LE TEST QUI COMPTE : « Vérifier une par une » — dans l\'ordre de DÉPÔT, un compteur, « Passer », « Enregistrer et suivante », la page suivante lue au fil', async () => {
  const pages = { debut: { lignes: [aVerifier(1), aVerifier(2)], suite: 'C1', nombre: 3 }, C1: { lignes: [aVerifier(3)], suite: null } }
  const b = await monter({ ecran: ecranAvec({ parcours: (c) => pages[c] }), geste: () => ({ ok: true }) })
  try {
    await b.cliquer(b.$('[data-geste="parcourir"]'))
    const dlg = b.$('[data-bind="fiche"]')
    assert.equal(dlg.open, true)
    assert.equal(b.lecturesEcran()[1].url, '/api/ecran/charges?parcours=debut')
    assert.equal(texte(dlg.querySelector('[data-bind="parcours-compteur"]')), '1 sur 3')
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 1')
    assert.equal(texte(dlg.querySelector('[data-geste="valider"]')), 'Enregistrer et suivante')
    // « Passer » : rien n'est écrit.
    await b.cliquer(dlg.querySelector('[data-geste="passer"]'))
    assert.deepEqual(b.gestes(), [])
    assert.equal(texte(dlg.querySelector('[data-bind="parcours-compteur"]')), '2 sur 3')
    // « Enregistrer et suivante » : la validation de toujours, puis la suivante — lue sur la page suivante.
    await b.cliquer(dlg.querySelector('[data-geste="valider"]'))
    assert.deepEqual(b.gestes().map(g => [g.action, g.id]), [['valider', id(2)]])
    assert.equal(b.lecturesEcran()[2].url, '/api/ecran/charges?parcours=C1')
    assert.equal(texte(dlg.querySelector('[data-bind="parcours-compteur"]')), '3 sur 3')
    // La dernière : la fiche se ferme, l'écran se relit, et le dit.
    await b.cliquer(dlg.querySelector('[data-geste="valider"]'))
    assert.equal(dlg.open, false)
    assert.match(texte(b.$('[data-bind="envoi"]')), /Toutes les factures à vérifier ont été vues/)
    assert.equal(b.lecturesEcran().length, 4, 'une seule relecture de l\'écran, à la fin')
  } finally { b.fermer() }
})

test('le parcours : une fiche fermée en route l\'arrête et relit l\'écran ; hors parcours, la fiche garde « Valider »', async () => {
  const b = await monter({ ecran: ecranAvec({ parcours: () => ({ lignes: [aVerifier(1), aVerifier(2)], suite: null, nombre: 2 }) }) })
  try {
    await b.cliquer(b.$('[data-geste="parcourir"]'))
    const dlg = b.$('[data-bind="fiche"]')
    await b.cliquer(dlg.querySelector('[data-geste="fermer"]'))
    assert.equal(dlg.open, false)
    assert.equal(b.lecturesEcran().length, 3, 'l\'écran est relu')
    await b.cliquer(b.$('[data-bind="a-traiter"] .chg-ligne'))
    assert.equal(dlg.querySelector('[data-geste="passer"]'), null)
    assert.equal(dlg.querySelector('[data-bind="parcours-compteur"]'), null)
    assert.equal(texte(dlg.querySelector('[data-geste="valider"]')), 'Valider')
  } finally { b.fermer() }
})

// ─── Enregistrer tout ───────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : « Enregistrer tout » relit TOUTE la file, ne garde que les complètes, dit le compte AVANT, puis envoie par paquets de 20', async () => {
  const ENT2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const entites = [{ id: ENT, nom: 'Moi', archivee: false, debut_exercice: null }, { id: ENT2, nom: 'SCI Le Florian', archivee: false, debut_exercice: null }]
  // 22 pour la SCI, 3 pour « Moi » : la confirmation le dit, les plus nombreuses d'abord.
  const completes = Array.from({ length: 25 }, (_, i) => aVerifier(i + 1, i < 3 ? {} : { entite_juridique_id: ENT2 }))
  const incompletes = [aVerifier(40, { categorie: null }), aVerifier(41, { entite_juridique_id: null }), aVerifier(42, { signal: 'doublon', signal_tranche: false })]
  const pages = { debut: { lignes: [...completes.slice(0, 20), incompletes[0]], suite: 'C1', nombre: 28 }, C1: { lignes: [...completes.slice(20), ...incompletes.slice(1)], suite: null } }
  const lots = []
  const geste = (c) => { lots.push(c.ids); return { ok: true, enregistrees: c.ids.slice(0, c.ids.length - (lots.length === 2 ? 1 : 0)), refusees: lots.length === 2 ? [{ id: c.ids[c.ids.length - 1], code: 'incomplete' }] : [] } }
  const b = await monter({ ecran: ecranAvec({ parcours: (c) => pages[c], autre: { entites } }), geste })
  try {
    await b.cliquer(b.$('[data-geste="tout-enregistrer"]'))
    for (let i = 0; i < 20; i++) await b.attendre()
    assert.deepEqual(b.journal.confirmations, ['25 factures vont être enregistrées telles que lues : 22 pour SCI Le Florian, 3 pour Moi. 3 restent à vérifier une par une.'])
    assert.deepEqual(b.gestes().map(g => g.action), ['valider_lot', 'valider_lot'])
    assert.deepEqual(lots.map(l => l.length), [20, 5])
    assert.deepEqual(lots.flat(), completes.map(c => c.id), 'les complètes, dans l\'ordre de dépôt — et aucune autre')
    assert.match(texte(b.$('[data-bind="envoi"]')), /24 factures enregistrées\. 1 n'ont pas pu l'être et restent à vérifier\./)
    assert.equal(b.lecturesEcran().filter(f => !f.url.includes('parcours=')).length, 2, 'l\'écran est relu')
  } finally { b.fermer() }
})

test('« Enregistrer tout » refusé à la confirmation : rien ne part ; aucune complète : rien n\'est demandé', async () => {
  const b = await monter({ confirmer: false, ecran: ecranAvec({ parcours: () => ({ lignes: [aVerifier(1)], suite: null, nombre: 1 }) }) })
  try {
    await b.cliquer(b.$('[data-geste="tout-enregistrer"]'))
    assert.equal(b.journal.confirmations.length, 1)
    assert.deepEqual(b.gestes(), [])
  } finally { b.fermer() }
  const c = await monter({ ecran: ecranAvec({ parcours: () => ({ lignes: [aVerifier(1, { categorie: null })], suite: null, nombre: 1 }) }) })
  try {
    await c.cliquer(c.$('[data-geste="tout-enregistrer"]'))
    assert.deepEqual(c.journal.confirmations, [])
    assert.deepEqual(c.gestes(), [])
    assert.match(texte(c.$('[data-bind="envoi"]')), /Aucune facture complète à enregistrer/)
  } finally { c.fermer() }
})

// ─── La facture à droite, à l'ordinateur ───────────────────────────────────
test('LE TEST QUI COMPTE : à l\'ordinateur, la fiche s\'ouvre en deux colonnes et la facture s\'affiche À DROITE ; au téléphone, rien n\'est demandé', async () => {
  const geste = (c) => (c.action === 'consulter' ? { ok: true, url: `https://stockage.test/lire/${c.id}` } : { ok: true })
  const b = await monter({ large: true, geste, ecran: ecranAvec() })
  try {
    await b.cliquer(b.$('[data-bind="a-traiter"] .chg-ligne'))
    const dlg = b.$('[data-bind="fiche"]')
    assert.equal(dlg.classList.contains('chg-fiche--double'), true)
    assert.deepEqual(b.gestes(), [{ action: 'consulter', id: id(1) }])
    const cadre = dlg.querySelector('[data-bind="fiche-doc"] iframe')
    assert.equal(cadre.getAttribute('src'), `https://stockage.test/lire/${id(1)}`)
    assert.equal(cadre.getAttribute('title'), 'La facture')
    assert.ok(dlg.querySelector('[data-champ="fournisseur_nom"]'), 'les champs restent à gauche')
  } finally { b.fermer() }
  const t = await monter({ geste, ecran: ecranAvec() })
  try {
    await t.cliquer(t.$('[data-bind="a-traiter"] .chg-ligne'))
    const dlg = t.$('[data-bind="fiche"]')
    assert.equal(dlg.classList.contains('chg-fiche--double'), false)
    assert.equal(dlg.querySelector('[data-bind="fiche-doc"]'), null)
    assert.deepEqual(t.gestes(), [], 'au téléphone, « Voir la facture » reste le chemin')
  } finally { t.fermer() }
})

test('à l\'ordinateur, une commission de plateforme (sans fichier) garde la fiche simple', async () => {
  const geste = () => ({ ok: true, url: 'https://stockage.test/x' })
  const b = await monter({ large: true, geste, ecran: ecranAvec({ aTraiter: [aVerifier(1, { origine: 'ota' })] }) })
  try {
    await b.cliquer(b.$('[data-bind="a-traiter"] .chg-ligne'))
    assert.equal(b.$('[data-bind="fiche"]').classList.contains('chg-fiche--double'), false)
    assert.deepEqual(b.gestes(), [])
  } finally { b.fermer() }
})

test('à l\'ordinateur, l\'adresse d\'une facture arrivée APRÈS le passage à une autre fiche est jetée : jamais le document d\'une autre facture', async () => {
  let lacher
  const lente = new Promise(r => { lacher = r })
  const geste = (c) => (c.action === 'consulter' && c.id === id(1) ? lente.then(() => ({ ok: true, url: 'https://stockage.test/lire/1' })) : { ok: true, url: `https://stockage.test/lire/${c.id}` })
  const b = await monter({ large: true, geste, ecran: ecranAvec({ aTraiter: [aVerifier(1), aVerifier(2)] }) })
  try {
    const lignes = b.$$('[data-bind="a-traiter"] .chg-ligne')
    await b.cliquer(lignes[0])
    await b.cliquer(lignes[1])
    lacher()
    for (let i = 0; i < 10; i++) await b.attendre()
    const dlg = b.$('[data-bind="fiche"]')
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 2')
    assert.deepEqual(b.$$('[data-bind="fiche-doc"] iframe').map(f => f.getAttribute('src')), [`https://stockage.test/lire/${id(2)}`])
  } finally { b.fermer() }
})

// ─── Review du lot 8c ───────────────────────────────────────────────────────
test('review, M6 : trois PANNES de suite arrêtent un dépôt de plusieurs, et l\'écran dit combien ne sont pas partis ; un refus de fichier n\'en est pas une', async () => {
  const geste = (c) => { if (c.action === 'envoi') throw Object.assign(new Error('x'), { status: 503, error: 'panne' }); return { ok: true } }
  const b = await monter({ geste })
  try {
    await b.deposerFichiers([['t.txt', 'text/plain', 'x'], ['a.pdf', 'application/pdf'], ['b.pdf', 'application/pdf'], ['c.pdf', 'application/pdf'], ['d.pdf', 'application/pdf'], ['e.pdf', 'application/pdf']])
    assert.equal(b.gestes().filter(g => g.action === 'envoi').length, 3, 'a, b, c — puis arrêt')
    assert.match(b.$('[data-bind="envoi"]').textContent, /2 fichiers non envoyés : le dépôt s'est arrêté après trois pannes de suite/)
  } finally { b.fermer() }
})

test('review, M2 et M3 : une page suivante qui ne se lit pas ne fait sauter aucune facture ; une fiche fermée pendant la lecture ne se rouvre pas', async () => {
  let echecs = 1
  let lacher = null
  const pages = (c) => {
    if (c === 'debut') return { lignes: [aVerifier(1)], suite: 'C1', nombre: 3 }
    if (echecs-- > 0) throw Object.assign(new Error('x'), { status: 503 })
    if (lacher === 'attendre') return new Promise(r => { lacher = () => r({ lignes: [aVerifier(2), aVerifier(3)], suite: null }) })
    return { lignes: [aVerifier(2), aVerifier(3)], suite: null }
  }
  const ecran = (url) => {
    const u = new URL(url, 'https://hs.test')
    if (u.searchParams.has('parcours')) { const r = pages(u.searchParams.get('parcours')); return r && r.then ? r.then(p => ({ parcours: p })) : { parcours: r } }
    return reponseEcran({ aTraiter: [aVerifier(1)] })
  }
  const b = await monter({ ecran })
  try {
    await b.cliquer(b.$('[data-geste="parcourir"]'))
    const dlg = b.$('[data-bind="fiche"]')
    await b.cliquer(dlg.querySelector('[data-geste="passer"]'))
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 1', 'la page n\'est pas lue : on reste sur la facture')
    assert.equal(dlg.querySelector('[data-bind="parcours-compteur"]').textContent, '1 sur 3')
    await b.cliquer(dlg.querySelector('[data-geste="passer"]'))
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 2', 'la facture 2 n\'est pas sautée')
  } finally { b.fermer() }

  // La page suivante tarde ; l'hôte ferme la fiche (Échap : le dialogue se
  // ferme et émet `close`) avant qu'elle arrive.
  const ecranLent = (url) => {
    const u = new URL(url, 'https://hs.test')
    if (!u.searchParams.has('parcours')) return reponseEcran({ aTraiter: [aVerifier(1)] })
    if (u.searchParams.get('parcours') === 'debut') return { parcours: { lignes: [aVerifier(1)], suite: 'C1', nombre: 2 } }
    return new Promise(r => { lacher = () => r({ parcours: { lignes: [aVerifier(2)], suite: null } }) })
  }
  const c = await monter({ ecran: ecranLent })
  try {
    await c.cliquer(c.$('[data-geste="parcourir"]'))
    const dlg = c.$('[data-bind="fiche"]')
    await c.cliquer(dlg.querySelector('[data-geste="passer"]'))
    assert.equal(typeof lacher, 'function', 'la page suivante est bien en attente')
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open')
    dlg.dispatchEvent(new c.w.Event('close'))
    lacher()
    for (let i = 0; i < 10; i++) await c.attendre()
    assert.equal(dlg.open || dlg.hasAttribute('open'), false, 'la fiche fermée ne se rouvre pas')
  } finally { c.fermer() }
})

test('review, M4 : à l\'ordinateur, la fiche d\'un tableau reconnu revient à UNE colonne, même après une facture', async () => {
  const tableau = aVerifier(9, { statut: 'tableau', type_document: 'tableau_amortissement', fournisseur_nom: null, montant_ttc_cents: null, entite_juridique_id: null, tableau_lu: { echeances: 15, debut: '2025-01-15', fin: '2026-03-05' } })
  const geste = () => ({ ok: true, url: 'https://stockage.test/x' })
  const b = await monter({ large: true, geste, ecran: ecranAvec({ aTraiter: [aVerifier(1), tableau] }) })
  try {
    const lignes = b.$$('[data-bind="a-traiter"] .chg-ligne')
    await b.cliquer(lignes[0])
    assert.equal(b.$('[data-bind="fiche"]').classList.contains('chg-fiche--double'), true)
    await b.cliquer(lignes[1])
    assert.equal(b.$('[data-bind="fiche"]').classList.contains('chg-fiche--double'), false)
  } finally { b.fermer() }
})
