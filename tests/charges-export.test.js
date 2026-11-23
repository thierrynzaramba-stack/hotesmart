// tests/charges-export.test.js — lot 8d (§14.23) : les modules de l'export
// d'un exercice, sans écran. Le ZIP se RELIT (en-têtes, CRC, noms), le PDF se
// RELIT par unpdf (le texte que verra le comptable), le CSV se lit au
// caractère, et le téléchargement des fichiers se mesure essai par essai.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const charger = (f) => import(path.join(RACINE, 'shared', f))

// Un lecteur de ZIP minimal : le répertoire central, puis chaque en-tête local.
function lireZip (octets) {
  const v = new DataView(octets.buffer, octets.byteOffset, octets.byteLength)
  const fin = octets.length - 22
  assert.equal(v.getUint32(fin, true), 0x06054b50, 'fin du répertoire central')
  const n = v.getUint16(fin + 10, true)
  let p = v.getUint32(fin + 16, true)
  const dec = new TextDecoder()
  const entrees = []
  for (let i = 0; i < n; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50)
    const methode = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true)
    const taille = v.getUint32(p + 24, true)
    const lNom = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const nom = dec.decode(octets.subarray(p + 46, p + 46 + lNom))
    assert.equal(v.getUint32(local, true), 0x04034b50)
    const lNomLocal = v.getUint16(local + 26, true)
    const debut = local + 30 + lNomLocal + v.getUint16(local + 28, true)
    entrees.push({ nom, methode, crc, octets: octets.subarray(debut, debut + taille) })
    p += 46 + lNom + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
  }
  return entrees
}
const concat = (morceaux) => {
  const total = morceaux.reduce((s, m) => s + m.length, 0)
  const o = new Uint8Array(total)
  let i = 0
  for (const m of morceaux) { o.set(m, i); i += m.length }
  return o
}
const texte = (o) => new TextDecoder().decode(o)
async function textePdf (octets) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(octets))
  return extractText(pdf, { mergePages: false })
}

const FR = require('../shared/i18n/fr.json')
const t = (k, v = {}) => (FR[k] === undefined ? k : FR[k].replace(/\{(\w+)\}/g, (m, c) => (v[c] !== undefined ? String(v[c]) : m)))
const NOMS = { bien: (id) => (id === 'b1' ? 'La bulle' : 'Cœur de vie 23'), categorie: (k) => t('charges.cat_' + k), type: (k) => t('charges.type_' + k) }
const ligne = (n, extra = {}) => ({
  id: `id-${n}`, jour: `2026-01-${String(n).padStart(2, '0')}`, fournisseur_nom: `Fournisseur ${n}`, fournisseur_siret: null,
  numero_facture: `F-${n}`, type_document: 'facture', categorie: 'energie', bien_id: 'b1', periode_debut: null, periode_fin: null,
  montant_ht_cents: 7017, montant_tva_cents: 1403, montant_ttc_cents: 8420, origine: 'fichier', justificatif_type: 'application/pdf',
  fichier: true, ...extra
})

// ─── Le ZIP ─────────────────────────────────────────────────────────────────
test('ZIP : le CRC-32 de référence, et un ZIP stocké que l\'on RELIT nom par nom, octet par octet', async () => {
  const { crc32, zipStocke } = await charger('zip-simple.js')
  const enc = new TextEncoder()
  assert.equal(crc32(enc.encode('123456789')).toString(16), 'cbf43926')
  const entrees = [
    { nom: 'Liste-2026.pdf', octets: enc.encode('%PDF') },
    { nom: 'Factures/001_2026-01-05_EDF_84,20.pdf', octets: new Uint8Array(3000).fill(7) },
    { nom: 'Factures-2026.csv', octets: enc.encode('a;b\r\n') }
  ]
  const relu = lireZip(concat(zipStocke(entrees, new Date(2026, 10, 23, 1, 2, 4))))
  assert.deepEqual(relu.map(e => e.nom), entrees.map(e => e.nom))
  for (const [i, e] of relu.entries()) {
    assert.equal(e.methode, 0, 'stocké, sans compression')
    assert.deepEqual([...e.octets], [...entrees[i].octets])
    assert.equal(e.crc, crc32(entrees[i].octets))
  }
})

// ─── Les noms, la numérotation ─────────────────────────────────────────────
test('LE TEST QUI COMPTE (8d) : chaque facture a un numéro, dans l\'ordre de la liste, et un nom de fichier SIMPLE qui le porte ; une charge sans fichier n\'en a pas', async () => {
  const { preparerExport, nomSimple } = await charger('charges-export.js')
  const p = preparerExport([
    ligne(5, { fournisseur_nom: 'Électricité de France — Agence n°3' }),
    ligne(6, { type_document: 'avoir', montant_ttc_cents: -5000, justificatif_type: 'image/jpeg' }),
    ligne(7, { origine: 'ota', fichier: false }),
    ligne(8, { fournisseur_nom: null, montant_ttc_cents: null })
  ])
  assert.deepEqual(p.map(l => l.numero), ['001', '002', '003', '004'])
  assert.deepEqual(p.map(l => l.chemin), [
    'Factures/001_2026-01-05_Electricite-de-France-Agence-n-3_84,20.pdf',
    'Factures/002_2026-01-06_Fournisseur-6_-50,00.jpg',
    null,
    'Factures/004_2026-01-08_Facture.pdf'
  ])
  assert.equal(nomSimple('Cœur de vie 23 / 2026'), 'Coeur-de-vie-23-2026')
  // Au-delà de 999 factures, les numéros s'allongent tous : l'ordre alphabétique
  // des fichiers reste celui de la liste.
  const mille = preparerExport(Array.from({ length: 1000 }, (_, i) => ligne(1, { id: `x${i}` })))
  assert.deepEqual([mille[0].numero, mille[999].numero], ['0001', '1000'])
})

// ─── Le CSV ─────────────────────────────────────────────────────────────────
test('CSV : UTF-8 avec BOM, séparateur « ; », virgule décimale, un texte qui porte « ; » ou « " » entre guillemets', async () => {
  const { preparerExport, csvExport } = await charger('charges-export.js')
  const p = preparerExport([ligne(5, { fournisseur_nom: 'Dupont; "et fils"', periode_debut: '2026-01-01', periode_fin: '2026-03-31' }), ligne(6, { origine: 'credit', fichier: false, bien_id: null, montant_ht_cents: null })])
  const csv = csvExport(p, { t, langue: 'fr', noms: NOMS })
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  const lignes = csv.slice(1).split('\r\n')
  assert.equal(lignes[0], 'N°;Date;Fournisseur;SIRET;N° de facture;Type;Catégorie;Logement;Début de période;Fin de période;HT;TVA;TTC;Fichier')
  assert.equal(lignes[1], '001;05/01/2026;"Dupont; ""et fils""";;F-5;Facture;Eau, électricité, gaz;La bulle;01/01/2026;31/03/2026;70,17;14,03;84,20;Factures/001_2026-01-05_Dupont-et-fils_84,20.pdf')
  assert.equal(lignes[2], '002;06/01/2026;Fournisseur 6;;F-6;Facture;Eau, électricité, gaz;;;;;14,03;84,20;')
  assert.equal(lignes[3], '', 'une fin de ligne après la dernière')
})

// ─── Le PDF ─────────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE (8d) : le PDF de la liste se RELIT — en-tête, chaque facture avec son numéro, le total, la note « sans fichier », et « Page x sur y »', async () => {
  const { preparerExport, pdfExport } = await charger('charges-export.js')
  const lignes = Array.from({ length: 40 }, (_, i) => ligne(i + 1, i === 3 ? { origine: 'ota', fichier: false, montant_ttc_cents: null } : {}))
  const p = preparerExport(lignes)
  const entete = { titre: 'Factures de l\'exercice 2026', entite: 'Thierry · SIRET 12345678900012', du_au: 'Du 1 janv. 2026 au 31 déc. 2026', compte: '40 factures enregistrées · édité le 23 nov. 2026', a_traiter: '3 factures sont encore à traiter et ne sont pas dans cet export.' }
  const pdf = pdfExport(p, { t, langue: 'fr', noms: NOMS, entete })
  assert.equal(texte(pdf.subarray(0, 8)), '%PDF-1.4')
  const r = await textePdf(pdf)
  assert.equal(r.totalPages, 2, 'quarante lignes tiennent sur deux pages')
  const tout = r.text.join('\n')
  for (const attendu of [entete.titre, entete.entite, entete.du_au, entete.compte, entete.a_traiter, 'Fournisseur 1', 'Fournisseur 40', 'La bulle', 'Eau, électricité, gaz', '004 *', 'Total', 'Page 1 sur 2', 'Page 2 sur 2']) {
    assert.ok(tout.includes(attendu), `le PDF dit « ${attendu} »`)
  }
  assert.ok(tout.includes(t('charges.export_sans_fichier')))
  assert.ok(tout.includes(t('charges.export_non_lus', { n: 1 })), 'un TTC non lu est dit, pas compté')
  // 39 factures à 84,20 € : 3 283,80 € (le non lu ne compte pas).
  assert.match(tout.replace(/[  ]/g, ' '), /3 283,80 €/)
  assert.ok(r.text[1].includes(entete.titre), 'le titre se répète en tête de page')
})

test('PDF : un caractère hors du codage s\'écrit « ? », un texte trop long est coupé par « … »', async () => {
  const { octetsWinAnsi, couper, largeur } = await charger('pdf-simple.js')
  assert.deepEqual(octetsWinAnsi('€ œ😀'), [0x80, 0xA0, 0x9C, 0x3F])
  const c = couper('Fournisseur au nom vraiment très long', 60, 8)
  assert.ok(c.endsWith('…'))
  assert.ok(largeur(c, 8) <= 60)
  assert.equal(couper('Court', 60, 8), 'Court')
})

// ─── Le téléchargement des fichiers ─────────────────────────────────────────
test('LE TEST QUI COMPTE (8d) : les adresses se demandent par paquets de 20, seulement pour les factures qui ont un fichier ; chaque fichier est rangé sous SA facture', async () => {
  const { preparerExport, telechargerFichiers, PAQUET_URLS } = await charger('charges-export.js')
  assert.equal(PAQUET_URLS, 20)
  const p = preparerExport(Array.from({ length: 26 }, (_, i) => ligne(i + 1, i === 25 ? { origine: 'credit', fichier: false } : {})))
  const demandes = []
  const avance = []
  const recus = await telechargerFichiers(p, {
    agir: async (c) => { demandes.push(c.ids.length); return { urls: c.ids.map(id => ({ id, url: `u:${id}` })), absentes: [] } },
    telecharger: async (url) => new TextEncoder().encode(url),
    avancer: (fait, total) => avance.push([fait, total])
  })
  assert.deepEqual(demandes, [20, 5])
  assert.equal(recus.size, 25)
  assert.equal(texte(recus.get('id-7')), 'u:id-7')
  assert.deepEqual(avance[avance.length - 1], [25, 25])
})

test('8d : un fichier qui ne vient pas est REDEMANDÉ avec une adresse neuve ; au troisième échec l\'export s\'arrête en nommant la facture', async () => {
  const { preparerExport, telechargerFichiers } = await charger('charges-export.js')
  const p = preparerExport([ligne(1), ligne(2)])
  // id-1 échoue une fois puis passe ; id-2 échoue toujours.
  const essais = {}
  const demandes = []
  const agir = async (c) => { demandes.push(c.ids); return { urls: c.ids.map(id => ({ id, url: `u:${id}:${demandes.length}` })), absentes: [] } }
  const telecharger = async (url) => {
    const id = url.split(':')[1]
    essais[id] = (essais[id] || 0) + 1
    if (id === 'id-2' || essais[id] === 1) throw Object.assign(new Error('x'), { status: 400 })
    return new Uint8Array([1])
  }
  await assert.rejects(telechargerFichiers(p, { agir, telecharger }), (e) => e.code === 'fichier_absent' && e.ligne.numero === '002')
  assert.equal(essais['id-1'], 2, 'la première facture passe à son deuxième essai')
  assert.equal(essais['id-2'], 3, 'trois essais, pas plus')
  assert.ok(demandes.filter(d => d.length === 1).length >= 3, 'chaque nouvel essai a demandé une adresse neuve')
})
