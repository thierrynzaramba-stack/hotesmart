// tests/charges-export-page.test.js — lot 8d (§14.23) : « Télécharger
// l'exercice », dans la VRAIE page (tests/outils/banc-charges.js). On clique,
// on compte ce qui part au serveur et au stockage, et on RELIT le ZIP proposé
// au téléchargement : la liste en PDF, chaque facture sous son numéro, le CSV.

const test = require('node:test')
const assert = require('node:assert/strict')
const { monter, reponseEcran, ENT, BIEN } = require('./outils/banc-charges')

const texte = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const lireBlob = (w, b) => new Promise((ok, ko) => { const r = new w.FileReader(); r.onload = () => ok(new Uint8Array(r.result)); r.onerror = ko; r.readAsArrayBuffer(b) })
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// Les noms du répertoire central d'un ZIP, dans l'ordre.
function nomsDuZip (o) {
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength)
  const fin = o.length - 22
  assert.equal(v.getUint32(fin, true), 0x06054b50)
  const n = v.getUint16(fin + 10, true)
  let p = v.getUint32(fin + 16, true)
  const noms = []
  for (let i = 0; i < n; i++) {
    const l = v.getUint16(p + 28, true)
    noms.push(new TextDecoder().decode(o.subarray(p + 46, p + 46 + l)))
    p += 46 + l + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
  }
  return noms
}

const ligne = (n, extra = {}) => ({
  id: id(n), jour: `2026-02-${String((n % 27) + 1).padStart(2, '0')}`, date_facture: null, fournisseur_nom: `Fournisseur ${n}`,
  fournisseur_siret: null, numero_facture: `F-${n}`, type_document: 'facture', categorie: 'energie', bien_id: BIEN,
  periode_debut: null, periode_fin: null, montant_ht_cents: 1000, montant_tva_cents: 200, montant_ttc_cents: 1200,
  origine: 'fichier', justificatif_type: 'application/pdf', fichier: true, cree_le: '2026-02-01T10:00:00Z', ...extra
})
const exportDe = (lignes, extra = {}) => ({
  export: { entite: { id: ENT, nom: 'Moi', siret: null }, periode: '2026', debut: '2026-01-01', fin: '2026-12-31', standard: true, lignes, a_traiter: 2, ...extra }
})
const ecranAvecExport = (exp) => (url) => (url.includes('export=1') ? (typeof exp === 'function' ? exp(url) : exp) : reponseEcran())
const urls = (c) => (c.action === 'export_urls' ? { ok: true, urls: c.ids.map(i => ({ id: i, url: `https://stockage.test/lire/${i}` })), absentes: [] } : { ok: true })

test('LE TEST QUI COMPTE (8d) : « Télécharger l\'exercice » lit la liste de l\'entité et de l\'exercice affichés, demande les adresses par 20, télécharge chaque fichier et propose UN ZIP — la liste, les factures numérotées, le CSV', async () => {
  // 25 factures avec fichier, et une commission sans fichier.
  const lignes = [...Array.from({ length: 25 }, (_, i) => ligne(i + 1)), ligne(26, { origine: 'ota', fichier: false })]
  const b = await monter({ ecran: ecranAvecExport(exportDe(lignes)), geste: urls })
  try {
    const bouton = b.$('[data-geste="exporter"]')
    assert.equal(texte(bouton), 'Télécharger l\'exercice')
    await b.cliquer(bouton)
    for (let i = 0; i < 200; i++) await b.attendre()
    const lecture = b.lecturesEcran().find(f => f.url.includes('export=1'))
    assert.equal(lecture.url, `/api/ecran/charges?export=1&entite=${ENT}&periode=2026`)
    assert.deepEqual(b.gestes().map(g => [g.action, g.ids.length]), [['export_urls', 20], ['export_urls', 5]])
    assert.equal(b.journal.fetch.filter(f => f.url.startsWith('https://stockage.test/lire/')).length, 25, 'un téléchargement par fichier, pas pour la commission')
    assert.equal(b.journal.zips.length, 1)
    assert.deepEqual(b.journal.clics.map(c => c.download), ['Charges-2026-Moi.zip'])
    const zip = await lireBlob(b.w, b.journal.zips[0])
    const noms = nomsDuZip(zip)
    assert.equal(noms[0], 'Liste-2026.pdf')
    assert.equal(noms[noms.length - 1], 'Factures-2026.csv')
    assert.equal(noms.length, 27, 'la liste, 25 factures, le CSV')
    assert.ok(noms.slice(1, -1).every((n, i) => n.startsWith(`Factures/${String(i + 1).padStart(3, '0')}_`)), 'chaque facture sous son numéro, dans l\'ordre')
    const fen = b.$('[data-bind="chargement"]')
    assert.match(texte(fen.querySelector('[data-bind="chargement-fin"]')), /26 factures dans le ZIP, dont 25 avec leur fichier/)
    assert.equal(texte(fen.querySelector('[data-geste="chargement-continuer"]')), 'Fermer')
  } finally { b.fermer() }
})

test('8d : PENDANT le téléchargement, la fenêtre dit la facture en cours sur combien et la barre avance ; Échap ne la ferme pas', async () => {
  let lacher = null
  let vus = 0
  const fichier = (u) => {
    vus++
    if (vus === 2) return new Promise(r => { lacher = () => r({ octets: new TextEncoder().encode(u) }) })
    return { octets: new TextEncoder().encode(u) }
  }
  const b = await monter({ ecran: ecranAvecExport(exportDe([ligne(1), ligne(2), ligne(3)])), geste: urls, fichier })
  try {
    b.$('[data-geste="exporter"]').dispatchEvent(new b.w.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 60 && !lacher; i++) await b.attendre()
    assert.equal(typeof lacher, 'function')
    const fen = b.$('[data-bind="chargement"]')
    assert.equal(fen.open, true)
    assert.equal(texte(fen.querySelector('#chg-chargement-titre')), 'Téléchargement de l\'exercice 2026')
    assert.equal(texte(fen.querySelector('[data-bind="chargement-etape"]')), 'Téléchargement des factures…')
    assert.match(texte(fen.querySelector('[data-bind="chargement-compte"]')), /^Facture \d sur 3$/)
    assert.ok(Number(fen.querySelector('[data-bind="chargement-barre"]').value) >= 1)
    const echap = new b.w.Event('cancel', { cancelable: true })
    fen.dispatchEvent(echap)
    assert.equal(echap.defaultPrevented, true)
    lacher()
    for (let i = 0; i < 100; i++) await b.attendre()
    assert.equal(b.journal.zips.length, 1)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (8d) : un fichier qui ne vient pas ARRÊTE l\'export — aucun ZIP, et la fenêtre nomme la facture', async () => {
  const b = await monter({
    ecran: ecranAvecExport(exportDe([ligne(1), ligne(2, { fournisseur_nom: 'EDF' })])),
    geste: urls,
    fichier: (u) => (u.endsWith(id(2)) ? { statut: 403 } : { octets: new Uint8Array([1]) })
  })
  try {
    await b.cliquer(b.$('[data-geste="exporter"]'))
    for (let i = 0; i < 200; i++) await b.attendre()
    assert.equal(b.journal.zips.length, 0, 'aucun ZIP incomplet')
    assert.equal(b.journal.clics.length, 0)
    const fen = b.$('[data-bind="chargement"]')
    assert.match(texte(fen.querySelector('[data-bind="chargement-fin"]')), /La facture n° 002 \(EDF\) ne se télécharge pas\. Aucun ZIP n'a été créé/)
    assert.match(texte(b.$('[data-bind="envoi"]')), /La facture n° 002/)
    assert.equal(b.journal.fetch.filter(f => f.url.endsWith(id(2))).length, 3, 'trois essais')
  } finally { b.fermer() }
})

test('8d : un exercice sans facture enregistrée ne demande rien au stockage et le dit ; trop de factures : le refus du serveur est dit', async () => {
  const b = await monter({ ecran: ecranAvecExport(exportDe([])), geste: urls })
  try {
    await b.cliquer(b.$('[data-geste="exporter"]'))
    for (let i = 0; i < 30; i++) await b.attendre()
    assert.deepEqual(b.gestes(), [])
    assert.equal(b.journal.zips.length, 0)
    assert.match(texte(b.$('[data-bind="chargement"]')), /Aucune facture enregistrée sur cet exercice/)
  } finally { b.fermer() }
  const c = await monter({ ecran: ecranAvecExport(() => { throw Object.assign(new Error('x'), { status: 413, error: 'trop_de_factures' }) }), geste: urls })
  try {
    await c.cliquer(c.$('[data-geste="exporter"]'))
    for (let i = 0; i < 30; i++) await c.attendre()
    assert.match(texte(c.$('[data-bind="chargement"]')), /Trop de factures sur cet exercice/)
  } finally { c.fermer() }
})

test('8d : sans entité (compte sans entité juridique), pas de bouton', async () => {
  const b = await monter({ ecran: () => reponseEcran({ totaux: { sans_entite: true } }) })
  try {
    assert.equal(b.$('[data-geste="exporter"]'), null)
  } finally { b.fermer() }
})
