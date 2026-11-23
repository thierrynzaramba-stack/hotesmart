// tests/charges-export.test.js — lot 8d (§14.23) : les modules de l'export
// d'un exercice, sans écran. Le ZIP se RELIT (répertoire central ET en-têtes
// locaux, CRC, tailles), le PDF se RELIT par unpdf ET se vérifie octet par
// octet (xref, `Length`, `startxref` — unpdf relit un PDF cassé, review du
// lot 8d, M10), le CSV se lit au caractère, et le téléchargement des
// fichiers se mesure essai par essai.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const charger = (f) => import(path.join(RACINE, 'shared', f))

// Un lecteur de ZIP : le répertoire central, puis chaque en-tête local, qui
// doit dire la même chose (nom, CRC, tailles).
function lireZip (octets) {
  const v = new DataView(octets.buffer, octets.byteOffset, octets.byteLength)
  const fin = octets.length - 22
  assert.equal(v.getUint32(fin, true), 0x06054b50, 'fin du répertoire central')
  const n = v.getUint16(fin + 10, true)
  const tailleCentral = v.getUint32(fin + 12, true)
  let p = v.getUint32(fin + 16, true)
  assert.equal(p + tailleCentral, fin, 'le répertoire central finit où commence la fin')
  const dec = new TextDecoder()
  const entrees = []
  for (let i = 0; i < n; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50)
    const methode = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true)
    const taille = v.getUint32(p + 24, true)
    assert.equal(v.getUint32(p + 20, true), taille, 'stocké : taille compressée = taille')
    const lNom = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const nom = dec.decode(octets.subarray(p + 46, p + 46 + lNom))
    assert.equal(v.getUint32(local, true), 0x04034b50)
    assert.equal(v.getUint32(local + 14, true), crc, `CRC local de ${nom}`)
    assert.equal(v.getUint32(local + 18, true), taille, `taille locale de ${nom}`)
    assert.equal(v.getUint32(local + 22, true), taille)
    const lNomLocal = v.getUint16(local + 26, true)
    assert.equal(dec.decode(octets.subarray(local + 30, local + 30 + lNomLocal)), nom, 'nom local')
    const debut = local + 30 + lNomLocal + v.getUint16(local + 28, true)
    entrees.push({ nom, methode, crc, octets: octets.subarray(debut, debut + taille) })
    p += 46 + lNom + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
  }
  return entrees
}
async function concat (morceaux) {
  return new Uint8Array(await new Blob(morceaux).arrayBuffer())
}
const texte = (o) => new TextDecoder().decode(o)

// La structure d'un PDF : chaque entrée du xref pointe sur « N 0 obj », chaque
// `/Length` est la taille réelle de son flux, `startxref` pointe sur « xref ».
function verifierStructurePdf (octets) {
  const s = Buffer.from(octets).toString('latin1')
  const sx = /startxref\n(\d+)\n%%EOF\n$/.exec(s)
  assert.ok(sx, 'startxref à la fin')
  const xref = Number(sx[1])
  assert.equal(s.slice(xref, xref + 5), 'xref\n', 'startxref pointe sur xref')
  const tete = /^xref\n0 (\d+)\n/.exec(s.slice(xref))
  const n = Number(tete[1])
  const entrees = s.slice(xref + tete[0].length).split('\n').slice(0, n)
  assert.equal(entrees[0], '0000000000 65535 f ')
  for (let i = 1; i < n; i++) {
    const m = /^(\d{10}) 00000 n $/.exec(entrees[i])
    assert.ok(m, `entrée ${i} du xref`)
    assert.equal(s.slice(Number(m[1]), Number(m[1]) + `${i} 0 obj\n`.length), `${i} 0 obj\n`, `l'objet ${i} est où le xref le dit`)
  }
  const flux = /<< \/Length (\d+) >>\nstream\n/g
  let f
  let vus = 0
  while ((f = flux.exec(s))) {
    const debut = f.index + f[0].length
    assert.equal(s.slice(debut + Number(f[1]), debut + Number(f[1]) + '\nendstream'.length), '\nendstream', 'Length exacte')
    vus++
  }
  assert.ok(vus > 0)
}
async function textePdf (octets) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(octets))
  return extractText(pdf, { mergePages: false })
}

const FR = require('../shared/i18n/fr.json')
const t = (k, v = {}) => (FR[k] === undefined ? k : FR[k].replace(/\{(\w+)\}/g, (m, c) => (v[c] !== undefined ? String(v[c]) : m)))
const NOMS = {
  bien: (id) => (id === 'b1' ? 'La bulle' : 'Cœur de vie 23'),
  categorie: (k) => t('charges.cat_' + k),
  type: (l) => (l.categorie === 'credit' ? t('charges.type_echeance_credit') : t('charges.type_' + (l.type_document || 'facture')))
}
const OPTS = { dossier: 'Factures', sansNom: 'Facture' }
const ligne = (n, extra = {}) => ({
  id: `id-${n}`, jour: `2026-01-${String(n).padStart(2, '0')}`, fournisseur_nom: `Fournisseur ${n}`, fournisseur_siret: null,
  numero_facture: `F-${n}`, type_document: 'facture', categorie: 'energie', bien_id: 'b1', periode_debut: null, periode_fin: null,
  montant_ht_cents: 7017, montant_tva_cents: 1403, montant_ttc_cents: 8420, origine: 'fichier', justificatif_type: 'application/pdf',
  fichier: true, compte: true, ...extra
})
const ENTETE = { titre: 'Factures de l\'exercice 2026', entite: 'Thierry · SIRET 12345678900012', du_au: 'Du 1 janv. 2026 au 31 déc. 2026', compte: 'édité le 23 nov. 2026', a_traiter: '3 factures sont encore à traiter et ne sont pas dans cet export.' }

// ─── Le ZIP ─────────────────────────────────────────────────────────────────
test('ZIP : le CRC-32 de référence, et un ZIP stocké RELU — en-têtes locaux et répertoire central d\'accord, octet par octet', async () => {
  const { crc32, zipStocke } = await charger('zip-simple.js')
  const enc = new TextEncoder()
  assert.equal(crc32(enc.encode('123456789')).toString(16), 'cbf43926')
  const entrees = [
    { nom: 'Liste-2026.pdf', octets: enc.encode('%PDF') },
    { nom: 'Factures/001_2026-01-05_EDF_84,20.pdf', octets: new Uint8Array(3000).fill(7) },
    { nom: 'Factures-2026.csv', octets: enc.encode('a;b\r\n') }
  ]
  const relu = lireZip(await concat(zipStocke(entrees, new Date(2026, 10, 23, 1, 2, 4))))
  assert.deepEqual(relu.map(e => e.nom), entrees.map(e => e.nom))
  for (const [i, e] of relu.entries()) {
    assert.equal(e.methode, 0, 'stocké, sans compression')
    assert.deepEqual([...e.octets], [...entrees[i].octets])
    assert.equal(e.crc, crc32(entrees[i].octets))
  }
})

test('ZIP (review M9) : une facture gardée en Blob, son CRC calculé à la réception, entre dans le ZIP sans être recopiée — et se relit', async () => {
  const { crc32 } = await charger('zip-simple.js')
  const { zipExport } = await charger('charges-export.js')
  const octets = new Uint8Array(5000).map((_, i) => i % 251)
  const prepare = [{ id: 'a', chemin: 'Factures/001_x.pdf' }, { id: 'b', chemin: null }]
  const morceaux = zipExport({
    nomListe: 'Liste-2026.pdf', pdf: new TextEncoder().encode('%PDF'), nomCsv: 'Factures-2026.csv', csv: 'x',
    prepare, fichiers: new Map([['a', { blob: new Blob([octets]), crc: crc32(octets), taille: octets.length }]]), date: new Date()
  })
  assert.ok(morceaux.some(m => m instanceof Blob), 'le Blob est un morceau, pas une copie')
  const relu = lireZip(await concat(morceaux))
  assert.deepEqual(relu.map(e => e.nom), ['Liste-2026.pdf', 'Factures/001_x.pdf', 'Factures-2026.csv'])
  assert.deepEqual([...relu[1].octets], [...octets])
})

// ─── Les noms, la numérotation ─────────────────────────────────────────────
test('LE TEST QUI COMPTE (8d) : chaque facture a un numéro, dans l\'ordre de la liste, et un nom de fichier SIMPLE qui le porte ; une charge sans fichier n\'en a pas', async () => {
  const { preparerExport, nomSimple } = await charger('charges-export.js')
  const p = preparerExport([
    ligne(5, { fournisseur_nom: 'Électricité de France — Agence n°3' }),
    ligne(6, { type_document: 'avoir', montant_ttc_cents: -5000, justificatif_type: 'image/jpeg' }),
    ligne(7, { origine: 'ota', fichier: false }),
    ligne(8, { fournisseur_nom: null, montant_ttc_cents: null }),
    ligne(9, { fournisseur_nom: '株式会社' })
  ], { dossier: 'Invoices', sansNom: 'Invoice' })
  assert.deepEqual(p.map(l => l.numero), ['001', '002', '003', '004', '005'])
  assert.deepEqual(p.map(l => l.chemin), [
    'Invoices/001_2026-01-05_Electricite-de-France-Agence-n-3_84,20.pdf',
    'Invoices/002_2026-01-06_Fournisseur-6_-50,00.jpg',
    null,
    'Invoices/004_2026-01-08_Invoice.pdf',
    'Invoices/005_2026-01-09_Invoice_84,20.pdf'
  ], 'le mot d\'un fournisseur inconnu est celui de la langue (review M8)')
  assert.equal(nomSimple('Cœur de vie 23 / 2026'), 'Coeur-de-vie-23-2026')
  // Au-delà de 999 factures, les numéros s'allongent tous : l'ordre alphabétique
  // des fichiers reste celui de la liste.
  const mille = preparerExport(Array.from({ length: 1000 }, (_, i) => ligne(1, { id: `x${i}` })), OPTS)
  assert.deepEqual([mille[0].numero, mille[999].numero], ['0001', '1000'])
})

// ─── Le CSV ─────────────────────────────────────────────────────────────────
test('CSV (review M1, M2, M3) : BOM, « ; », virgule décimale ; les identifiants restent du TEXTE dans Excel, les dates sont JJ/MM/AAAA, un texte lu ne devient jamais une formule, une échéance de crédit n\'est pas une « Facture »', async () => {
  const { preparerExport, csvExport } = await charger('charges-export.js')
  const p = preparerExport([
    ligne(5, { fournisseur_nom: 'Dupont; "et fils"', fournisseur_siret: '12345678900012', numero_facture: '000123', periode_debut: '2026-01-01', periode_fin: '2026-03-31' }),
    ligne(6, { origine: 'credit', categorie: 'credit', fichier: false, bien_id: null, montant_ht_cents: null, compte: true }),
    ligne(7, { fournisseur_nom: '=HYPERLINK("http://x")', type_document: 'echeancier', compte: false })
  ], OPTS)
  const csv = csvExport(p, { t, noms: NOMS })
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  const lignes = csv.slice(1).split('\r\n')
  assert.equal(lignes[0], 'N°;Date;Fournisseur;SIRET;N° de facture;Type;Catégorie;Logement;Début de période;Fin de période;HT;TVA;TTC;Comptée dans le total;Fichier')
  assert.equal(lignes[1], '"=""001""";05/01/2026;"Dupont; ""et fils""";"=""12345678900012""";"=""000123""";Facture;Eau, électricité, gaz;La bulle;01/01/2026;31/03/2026;70,17;14,03;84,20;oui;Factures/001_2026-01-05_Dupont-et-fils_84,20.pdf')
  assert.equal(lignes[2], '"=""002""";06/01/2026;Fournisseur 6;;"=""F-6""";Échéance de crédit;Crédit : intérêts et assurance;;;;;14,03;84,20;oui;')
  assert.ok(lignes[3].startsWith('"=""003""";07/01/2026;"\'=HYPERLINK(""http://x"")";'), lignes[3])
  assert.ok(lignes[3].includes(';Échéancier;') && lignes[3].includes(';non;'))
  assert.equal(lignes[4], '', 'une fin de ligne après la dernière')
})

// ─── Le PDF ─────────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE (8d) : le PDF de la liste est BIEN FORMÉ (xref, Length, startxref) et se RELIT — en-tête, chaque facture, le total, « Page x sur y »', async () => {
  const { preparerExport, pdfExport } = await charger('charges-export.js')
  const p = preparerExport(Array.from({ length: 40 }, (_, i) => ligne(i + 1, i === 3 ? { origine: 'ota', fichier: false } : {})), OPTS)
  const pdf = pdfExport(p, { t, langue: 'fr', noms: NOMS, entete: ENTETE })
  verifierStructurePdf(pdf)
  const r = await textePdf(pdf)
  assert.equal(r.totalPages, 2, 'quarante lignes tiennent sur deux pages')
  const tout = r.text.join('\n').replace(/[\u00A0\u202F]/g, ' ')
  for (const attendu of [ENTETE.titre, ENTETE.entite, ENTETE.du_au, ENTETE.compte, ENTETE.a_traiter, 'Fournisseur 1', 'Fournisseur 40', 'La bulle', 'Eau, électricité, gaz', '004 *', 'Total', 'Page 1 sur 2', 'Page 2 sur 2', t('charges.export_sans_fichier')]) {
    assert.ok(tout.includes(attendu), `le PDF dit « ${attendu} »`)
  }
  // 40 × 70,17 / 14,03 / 84,20.
  assert.match(tout, /2 806,80 €/)
  assert.match(tout, /561,20 €/)
  assert.match(tout, /3 368,00 €/)
  assert.ok(r.text[1].includes(ENTETE.titre), 'le titre se répète en tête de page')
})

test('LE TEST QUI COMPTE (review B1) : un échéancier, un doublon ou une commission NON COMPTÉS sont dans la liste, marqués « ° », et HORS du total — le total est celui de l\'écran', async () => {
  const { preparerExport, pdfExport, totauxExport } = await charger('charges-export.js')
  const p = preparerExport([
    ligne(1, { montant_ttc_cents: 12000, montant_ht_cents: 10000, montant_tva_cents: 2000 }),
    ligne(2, { type_document: 'echeancier', montant_ttc_cents: 96000, montant_ht_cents: 80000, montant_tva_cents: 16000, compte: false }),
    ligne(3, { type_document: 'avoir', montant_ttc_cents: -5000, montant_ht_cents: -4167, montant_tva_cents: -833 }),
    ligne(4, { montant_ttc_cents: 12000, montant_ht_cents: 10000, montant_tva_cents: 2000 })
  ], OPTS)
  const tot = totauxExport(p)
  assert.deepEqual([tot.ttc, tot.ht, tot.tva, tot.hors], [19000, 15833, 3167, 1])
  const pdf = pdfExport(p, { t, langue: 'fr', noms: NOMS, entete: ENTETE })
  verifierStructurePdf(pdf)
  const tout = (await textePdf(pdf)).text.join('\n').replace(/[\u00A0\u202F]/g, ' ')
  assert.match(tout, /190,00 €/)
  assert.doesNotMatch(tout, /1 150,00 €/)
  assert.ok(tout.includes('002 °'))
  assert.ok(tout.includes(t('charges.export_hors_total')))
})

test('LE TEST QUI COMPTE (review B2) : un HT ou une TVA non lus sont dits colonne par colonne ; une colonne sans aucun montant lu n\'a pas de total (« — »), jamais 0', async () => {
  const { preparerExport, pdfExport, totauxExport } = await charger('charges-export.js')
  const p = preparerExport([ligne(1, { montant_ht_cents: null }), ligne(2, { montant_ht_cents: null, montant_tva_cents: null })], OPTS)
  const tot = totauxExport(p)
  assert.deepEqual(tot.non_lus, { ht: 2, tva: 1, ttc: 0 })
  assert.equal(tot.ht, null, 'aucun HT lu : pas de total HT')
  assert.equal(tot.tva, 1403)
  const tout = (await textePdf(pdfExport(p, { t, langue: 'fr', noms: NOMS, entete: ENTETE }))).text.join('\n').replace(/[\u00A0\u202F]/g, ' ')
  assert.ok(tout.includes(t('charges.export_non_lus_col', { ht: 2, tva: 1, ttc: 0 })))
  assert.doesNotMatch(tout, /0,00 €/, 'jamais un 0 inventé')
})

test('PDF : un caractère hors du codage s\'écrit « ? », un texte trop long est coupé par « … »', async () => {
  const { octetsWinAnsi, couper, largeur } = await charger('pdf-simple.js')
  assert.deepEqual(octetsWinAnsi('€\u202Fœ😀'), [0x80, 0xA0, 0x9C, 0x3F])
  const c = couper('Fournisseur au nom vraiment très long', 60, 8)
  assert.ok(c.endsWith('…'))
  assert.ok(largeur(c, 8) <= 60)
  assert.equal(couper('Court', 60, 8), 'Court')
  assert.equal(largeur('Ÿ', 1000), largeur('Ý', 1000))
})

// ─── Le téléchargement des fichiers ─────────────────────────────────────────
test('LE TEST QUI COMPTE (8d, review M5) : les adresses se demandent PAR GROUPE DE QUATRE, juste avant de télécharger le groupe, et seulement pour les factures qui ont un fichier ; chaque fichier est rangé sous SA facture', async () => {
  const { preparerExport, telechargerFichiers, EN_PARALLELE } = await charger('charges-export.js')
  assert.equal(EN_PARALLELE, 4)
  const p = preparerExport(Array.from({ length: 26 }, (_, i) => ligne(i + 1, i === 25 ? { origine: 'credit', fichier: false } : {})), OPTS)
  const demandes = []
  const avance = []
  const recus = await telechargerFichiers(p, {
    agir: async (c) => { demandes.push(c.ids.length); return { urls: c.ids.map(id => ({ id, url: `u:${id}` })), absentes: [] } },
    telecharger: async (url) => new TextEncoder().encode(url),
    avancer: (fait, total) => avance.push([fait, total])
  })
  assert.deepEqual(demandes, [4, 4, 4, 4, 4, 4, 1])
  assert.equal(recus.size, 25)
  assert.equal(texte(new Uint8Array(await recus.get('id-7').blob.arrayBuffer())), 'u:id-7')
  assert.equal(recus.get('id-7').taille, 'u:id-7'.length)
  assert.deepEqual(avance[avance.length - 1], [25, 25])
})

test('8d : un fichier qui ne vient pas est REDEMANDÉ avec une adresse neuve ; au troisième échec l\'export s\'arrête en nommant la facture', async () => {
  const { preparerExport, telechargerFichiers } = await charger('charges-export.js')
  const p = preparerExport([ligne(1), ligne(2)], OPTS)
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

test('8d (review M4) : après l\'échec, les téléchargements en cours sont INTERROMPUS et plus rien n\'est annoncé', async () => {
  const { preparerExport, telechargerFichiers } = await charger('charges-export.js')
  const p = preparerExport([ligne(1), ligne(2), ligne(3), ligne(4)], OPTS)
  const signaux = []
  const lents = []
  const avance = []
  const telecharger = (url, { signal }) => {
    signaux.push(signal)
    if (url.endsWith('id-1')) return Promise.reject(Object.assign(new Error('x'), { status: 403 }))
    // Les trois autres attendent : ils ne répondent qu'après l'échec.
    return new Promise(r => lents.push(() => r(new Uint8Array([1]))))
  }
  const agir = async (c) => ({ urls: c.ids.map(id => ({ id, url: `u:${id}` })) })
  await assert.rejects(telechargerFichiers(p, { agir, telecharger, avancer: (f, n) => avance.push([f, n]) }), (e) => e.code === 'fichier_absent')
  assert.ok(signaux.length && signaux.every(s => s && s.aborted), 'chaque téléchargement reçoit le signal, et il est levé')
  lents.forEach(r => r())
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(avance, [], 'rien n\'est annoncé après l\'arrêt')
})

test('8d (review M5) : une demande d\'adresses en PANNE n\'arrête pas l\'export — chaque fichier redemande la sienne', async () => {
  const { preparerExport, telechargerFichiers } = await charger('charges-export.js')
  const p = preparerExport([ligne(1), ligne(2)], OPTS)
  let appels = 0
  const agir = async (c) => {
    appels++
    if (c.ids.length > 1) throw Object.assign(new Error('x'), { status: 503 })
    return { urls: [{ id: c.ids[0], url: `u:${c.ids[0]}` }] }
  }
  const recus = await telechargerFichiers(p, { agir, telecharger: async () => new Uint8Array([1]) })
  assert.equal(recus.size, 2)
  assert.equal(appels, 3, 'le groupe en panne, puis une adresse par fichier')
})
