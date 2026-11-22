// tests/charges-masse-page.test.js — lot 8c (§14.22) : l'écran.
// Dépôt de plusieurs fichiers SANS entité (la lecture la reconnaît), une
// fenêtre de chargement qui dit où en est le dépôt, puis la vérification une
// par une qui s'ouvre d'elle-même sur ce dépôt (recette du 22 novembre 2026) ;
// « À traiter » qui se lit au-delà de 50, le parcours de toute la file dans
// l'ordre de dépôt, et la facture à droite de sa fiche à l'ordinateur.
// « Enregistrer les factures complètes » est RETIRÉ (même recette). Les gestes
// se mesurent en cliquant (tests/outils/banc-charges.js).

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
    assert.equal(b.lecturesEcran().length, 2, 'l\'écran est relu UNE fois, à la fin')
    // Un refus se lit d'abord DANS LA FENÊTRE : la fiche le cacherait.
    const fen = b.$('[data-bind="chargement"]')
    assert.equal(fen.open, true)
    assert.match(texte(fen.querySelector('[data-bind="chargement-fin"]')), /2 factures déposées\. 1 refusées : notes\.txt/)
    assert.equal(b.$('[data-bind="fiche"]').open, false, 'la fiche attend « Continuer »')
    await b.cliquer(fen.querySelector('[data-geste="chargement-continuer"]'))
    assert.equal(fen.open, false)
    const dlg = b.$('[data-bind="fiche"]')
    assert.equal(dlg.open, true, 'la vérification s\'ouvre sur le dépôt')
    assert.equal(texte(dlg.querySelector('[data-bind="parcours-compteur"]')), '1 sur 2')
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 501')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (recette du lot 8c) : après un dépôt sans refus, la vérification une par une s\'ouvre D\'ELLE-MÊME sur les factures DÉPOSÉES, dans l\'ordre — sans relire la file du compte', async () => {
  let n = 0
  // La deuxième attend sa lecture (plafond du jour) : elle reste dans « À traiter ».
  const geste = (c) => {
    if (c.action === 'envoi') return { ok: true, id: id(600 + ++n), url: `https://stockage.test/${n}` }
    if (c.action === 'confirmer') return { ok: true, issue: n === 2 ? 'plafond' : 'a_verifier', charge: aVerifier(600 + n, n === 2 ? { statut: 'a_lire', fournisseur_nom: null } : {}) }
    return { ok: true }
  }
  // Une facture plus ancienne attend aussi : elle n'entre pas dans ce parcours.
  const b = await monter({ geste, ecran: ecranAvec({ aTraiter: [aVerifier(1)] }) })
  try {
    await b.deposerFichiers([['a.pdf', 'application/pdf'], ['b.pdf', 'application/pdf'], ['c.pdf', 'application/pdf']])
    assert.equal(b.$('[data-bind="chargement"]').open, false, 'la fenêtre se ferme d\'elle-même')
    const dlg = b.$('[data-bind="fiche"]')
    assert.equal(dlg.open, true)
    assert.equal(texte(dlg.querySelector('[data-bind="parcours-compteur"]')), '1 sur 2', 'les deux lues, pas celle en attente ni l\'ancienne')
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 601')
    await b.cliquer(dlg.querySelector('[data-geste="passer"]'))
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 603')
    assert.equal(texte(dlg.querySelector('[data-bind="parcours-compteur"]')), '2 sur 2')
    await b.cliquer(dlg.querySelector('[data-geste="valider"]'))
    assert.deepEqual(b.gestes().filter(g => g.action === 'valider').map(g => g.id), [id(603)])
    assert.equal(dlg.open, false)
    assert.match(texte(b.$('[data-bind="envoi"]')), /Toutes les factures déposées ont été vues/)
    assert.equal(b.lecturesEcran().filter(f => f.url.includes('parcours=')).length, 0, 'la file du compte n\'est pas relue')
    assert.equal(b.lecturesEcran().length, 3, 'au chargement, après le dépôt, à la fin du parcours')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (recette du lot 8c) : PENDANT le dépôt, la fenêtre dit la facture en cours sur combien, son étape, son nom, et la barre avance ; Échap ne la ferme pas', async () => {
  let n = 0
  let lacher = null
  const geste = (c) => {
    if (c.action === 'envoi') return { ok: true, id: id(700 + ++n), url: `https://stockage.test/${n}` }
    const charge = aVerifier(700 + n)
    if (n === 2) return new Promise(r => { lacher = () => r({ ok: true, issue: 'a_verifier', charge }) })
    return { ok: true, issue: 'a_verifier', charge }
  }
  const b = await monter({ geste })
  try {
    const input = b.$('[data-bind="fichier"]')
    Object.defineProperty(input, 'files', { value: ['a.pdf', 'b.pdf', 'c.pdf'].map(nom => new b.w.File(['%PDF-1.4'], nom, { type: 'application/pdf' })), configurable: true })
    input.dispatchEvent(new b.w.Event('change', { bubbles: true }))
    for (let i = 0; i < 40 && !lacher; i++) await b.attendre()
    assert.equal(typeof lacher, 'function', 'la lecture de la deuxième est en cours')
    const fen = b.$('[data-bind="chargement"]')
    assert.equal(fen.open, true)
    assert.equal(fen.getAttribute('aria-busy'), 'true')
    assert.equal(texte(fen.querySelector('#chg-chargement-titre')), 'Dépôt de 3 factures')
    assert.equal(texte(fen.querySelector('[data-bind="chargement-compte"]')), 'Facture 2 sur 3')
    assert.equal(texte(fen.querySelector('[data-bind="chargement-etape"]')), 'Lecture de la facture…')
    assert.equal(texte(fen.querySelector('[data-bind="chargement-nom"]')), 'b.pdf')
    const barre = fen.querySelector('[data-bind="chargement-barre"]')
    assert.deepEqual([Number(barre.getAttribute('max')), Number(barre.value)], [3, 1.5])
    const echap = new b.w.Event('cancel', { cancelable: true })
    fen.dispatchEvent(echap)
    assert.equal(echap.defaultPrevented, true, 'Échap ne ferme pas la fenêtre pendant le dépôt')
    lacher()
    for (let i = 0; i < 60; i++) await b.attendre()
    assert.equal(fen.open, false)
    assert.equal(b.$('[data-bind="fiche"]').open, true)
    assert.equal(texte(b.$('[data-bind="parcours-compteur"]')), '1 sur 3')
  } finally { b.fermer() }
})

test('un dépôt dont rien n\'est encore à vérifier : la fenêtre se ferme, aucune fiche ne s\'ouvre, et la ligne d\'état le dit', async () => {
  let n = 0
  const geste = (c) => (c.action === 'envoi'
    ? { ok: true, id: id(800 + ++n), url: `https://stockage.test/${n}` }
    : { ok: true, issue: 'plafond', charge: aVerifier(800 + n, { statut: 'a_lire' }) })
  const b = await monter({ geste })
  try {
    await b.deposerFichiers([['a.pdf', 'application/pdf'], ['b.pdf', 'application/pdf']])
    assert.equal(b.$('[data-bind="chargement"]').open, false)
    assert.equal(b.$('[data-bind="fiche"]').open, false)
    assert.equal(texte(b.$('[data-bind="envoi"]')), '2 factures déposées. Aucune n\'est à vérifier pour l\'instant : retrouvez-les dans « À traiter ».')
  } finally { b.fermer() }
})

test('UN seul fichier : la fenêtre le suit aussi (sans compteur), puis SA fiche s\'ouvre, comme avant le lot', async () => {
  let vue = null
  const geste = (c) => {
    if (c.action === 'envoi') return { ok: true, id: id(900), url: 'https://stockage.test/1' }
    const fen = vue && vue.$('[data-bind="chargement"]')
    if (fen) geste.pendant = [fen.open, texte(fen.querySelector('#chg-chargement-titre')), texte(fen.querySelector('[data-bind="chargement-compte"]')), texte(fen.querySelector('[data-bind="chargement-etape"]'))]
    return { ok: true, issue: 'a_verifier', charge: aVerifier(900) }
  }
  const b = await monter({ geste })
  vue = b
  try {
    await b.deposerFichier('seule.pdf', 'application/pdf')
    assert.deepEqual(geste.pendant, [true, 'Dépôt de la facture', '', 'Lecture de la facture…'])
    assert.equal(b.$('[data-bind="chargement"]').open, false)
    const dlg = b.$('[data-bind="fiche"]')
    assert.equal(dlg.open, true)
    assert.equal(dlg.querySelector('[data-bind="parcours-compteur"]'), null, 'une facture seule n\'est pas un parcours')
    assert.equal(dlg.querySelector('[data-champ="fournisseur_nom"]').value, 'Fournisseur 900')
  } finally { b.fermer() }
})

test('recette du lot 8c : « Enregistrer les factures complètes » n\'existe plus ; « Vérifier une par une » reste', async () => {
  const b = await monter({ ecran: ecranAvec({ aTraiter: [aVerifier(1), aVerifier(2)] }) })
  try {
    const z = b.$('[data-bind="a-traiter"]')
    assert.equal(z.querySelector('[data-geste="tout-enregistrer"]'), null)
    assert.equal(texte(z.querySelector('[data-geste="parcourir"]')), 'Vérifier une par une')
    assert.doesNotMatch(texte(z), /complètes/)
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
    // L'arrêt se lit dans la fenêtre ; rien à vérifier : son bouton la ferme.
    const fen = b.$('[data-bind="chargement"]')
    assert.match(texte(fen), /2 fichiers non envoyés/)
    const bouton = fen.querySelector('[data-geste="chargement-continuer"]')
    assert.equal(texte(bouton), 'Fermer')
    await b.cliquer(bouton)
    assert.equal(fen.open, false)
    assert.equal(b.$('[data-bind="fiche"]').open, false)
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
