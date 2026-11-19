// tests/charges-credit-tableau.test.js — lire le tableau d'amortissement d'un
// crédit (spec §14.20), SANS IA, chaque ligne prouvée au centime.
//
// ⚠ LES QUATRE PDF SONT FICTIFS, fabriqués pour ces tests par
// `tests/fixtures/charges/fabriquer-tableaux.py` (reportlab) : en-têtes sur
// deux lignes, une ligne de frais, un déblocage (échéance 0), deux pages dont
// la seconde SANS en-tête, une ligne « TOTAL » sans date, et la même page
// imprimée en portrait puis TOURNÉE d'un quart de tour — comme le vrai
// tableau de la Banque Populaire.
//
// Éprouvé à la main sur un vrai tableau bancaire (16 pages, hors dépôt :
// données personnelles) : 301 échéances lues en 271 ms, dont les frais de
// dossier ; les totaux de chaque année égaux au centime à ceux du PDF.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { lireTableau, echeancesDesPages, centimes, dateIso, classeDe, PAGES_MAX } = require('../lib/charges/credit-tableau')

const pdf = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', 'charges', `tableau-${nom}.pdf`))

test('LE TEST QUI COMPTE : un tableau en portrait se lit en entier — frais, échéances, rangs ; le déblocage et le total sont écartés', async () => {
  const r = await lireTableau(pdf('portrait'))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.echeances.length, 15, 'les frais de dossier + 14 mensualités, sur deux pages')
  assert.deepEqual(r.echeances[0], { indice: 1, rang: null, date: '2025-01-15', interets_cents: 0, assurance_cents: 0, accessoires_cents: 25000, capital_cents: 0, echeance_cents: 25000, capital_restant_cents: null })
  assert.deepEqual(r.echeances[1], { indice: 2, rang: 1, date: '2025-02-05', interets_cents: 12000, assurance_cents: 3000, accessoires_cents: 0, capital_cents: 58000, echeance_cents: 73000, capital_restant_cents: 11942000 })
  assert.deepEqual(r.echeances.map(e => e.rang), [null, ...Array.from({ length: 14 }, (_, i) => i + 1)])
  assert.equal(r.echeances.at(-1).date, '2026-03-05', 'la seconde page, sans en-tête, reprend les colonnes de la première')
  for (const e of r.echeances) {
    assert.equal(e.interets_cents + e.assurance_cents + e.accessoires_cents + e.capital_cents, e.echeance_cents, e.date)
  }
})

test('LE TEST QUI COMPTE : le MÊME tableau tourné d\'un quart de tour rend les MÊMES échéances — l\'orientation ne se suppose pas', async () => {
  const droit = await lireTableau(pdf('portrait'))
  const tourne = await lireTableau(pdf('tourne'))
  assert.equal(tourne.ok, true, JSON.stringify(tourne))
  assert.deepEqual(tourne.echeances, droit.echeances)
})

test('LE TEST QUI COMPTE : une seule ligne qui ne fait pas son échéance au centime refuse TOUT le tableau, et le refus dit sa date', async () => {
  const r = await lireTableau(pdf('ligne-fausse'))
  assert.deepEqual(r, { ok: false, code: 'ligne_incoherente', detail: '2025-06-05' })
})

test('un tableau dont on ne reconnaît pas les colonnes nécessaires est refusé, jamais deviné', async () => {
  assert.deepEqual(await lireTableau(pdf('sans-capital')), { ok: false, code: 'tableau_illisible', detail: 'colonnes non reconnues' })
})

test('un fichier qui n\'est pas un PDF lisible, ou trop long, est refusé', async () => {
  assert.equal((await lireTableau(Buffer.from('%PDF-1.7 pas vraiment'))).code, 'pdf_illisible')
  const faux = { getDocumentProxy: async () => ({ numPages: PAGES_MAX + 1 }) }
  assert.deepEqual(await lireTableau(Buffer.from('%PDF'), { unpdf: faux }), { ok: false, code: 'tableau_illisible', detail: 'trop de pages' })
  assert.deepEqual(echeancesDesPages([[]]), { ok: false, code: 'tableau_illisible', detail: 'aucune échéance' })
})

test('les montants, les dates et les en-têtes, un par un', () => {
  assert.equal(centimes('1 235,43'), 123543)
  assert.equal(centimes('235 000,00'), 23500000)
  assert.equal(centimes('1.235,43'), 123543)
  assert.equal(centimes('0,00'), 0)
  for (const x of ['12,5', '1235', 'abc', '1 23,45', '']) assert.equal(centimes(x), null, x)
  assert.equal(dateIso('22/03/2022'), '2022-03-22')
  assert.equal(dateIso('30/02/2022'), null, 'une date qui n\'existe pas')
  assert.equal(classeDe('MONTANT INTÉRÊTS (*)'), 'interets')
  assert.equal(classeDe('MONTANT ASSURANCES (*)'), 'assurance')
  assert.equal(classeDe('MONTANT ACCESSOIRES'), 'accessoires')
  assert.equal(classeDe('CAPITAL AMORTI'), 'capital')
  assert.equal(classeDe('MONTANT ECHEANCE'), 'echeance')
  assert.equal(classeDe('DATE ECHEANCE'), null, 'la colonne des dates n\'est pas l\'échéance')
  assert.equal(classeDe('CAPITAL RESTANT DU'), 'capital_restant')
  assert.equal(classeDe('SOMMES TOTALES RESTANT DUES'), null)
  assert.equal(classeDe('ELEMENTS CAPITALISES'), null)
})

// ─── Des cellules fabriquées, pour les cas que les PDF fictifs ne portent pas ─
// Une cellule de pdf.js : texte, matrice (texte horizontal), largeur ; les
// montants sont cadrés à droite sur la fin de leur colonne.
const FINS = { date: 75, interets: 180, assurance: 250, accessoires: 320, capital: 390, echeance: 460, restant: 540 }
const cellule = (fin, str, y) => ({ str, transform: [9, 0, 0, 9, fin - 5 * str.length, y], width: 5 * str.length })
const ENTETE = [
  ['interets', 'MONTANT', 'INTERETS'], ['assurance', 'MONTANT', 'ASSURANCE'], ['accessoires', 'MONTANT', 'ACCESSOIRES'],
  ['capital', 'CAPITAL', 'AMORTI'], ['echeance', 'MONTANT', 'ECHEANCE'], ['restant', 'CAPITAL', 'RESTANT DU']
].flatMap(([k, h1, h2]) => [cellule(FINS[k], h1, 790), cellule(FINS[k], h2, 780)])
function page (lignes) {
  const items = [...ENTETE]
  lignes.forEach((l, i) => {
    const y = 760 - 12 * i
    for (const [k, v] of Object.entries(l)) if (v !== undefined) items.push(cellule(FINS[k], v, y))
  })
  return items
}
const L = (date, interets, assurance, capital, echeance, extra = {}) => ({ date, interets, assurance, accessoires: '0,00', capital, echeance, restant: '1 000,00', ...extra })

test('un déblocage dont les cellules d\'échéance et de capital sont VIDES est écarté, pas refusé (review, mineur 3)', () => {
  const r = echeancesDesPages([page([
    { date: '22/01/2025', interets: '0,00', assurance: '0,00', restant: '50 000,00' },
    L('22/02/2025', '10,00', '5,00', '100,00', '115,00')
  ])])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.echeances.map(e => e.date), ['2025-02-22'])
})

test('une date SEULE au-dessus du tableau ne cache pas l\'en-tête (review, mineur 4)', () => {
  const items = [cellule(200, "Date d'effet :", 805), cellule(260, '15/01/2025', 805), ...page([L('22/02/2025', '10,00', '5,00', '100,00', '115,00')])]
  const r = echeancesDesPages([items])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.echeances.length, 1)
})

test('refusés : une cellule de capital absente, un montant négatif, des dates qui reculent (review, mineur 8)', () => {
  assert.deepEqual(echeancesDesPages([page([L('22/01/2025', '10,00', '5,00', '100,00', '115,00'), L('22/02/2025', '10,00', '5,00', undefined, '115,00')])]), { ok: false, code: 'ligne_incoherente', detail: '2025-02-22' })
  assert.deepEqual(echeancesDesPages([page([L('22/02/2025', '-10,00', '5,00', '120,00', '115,00')])]), { ok: false, code: 'ligne_incoherente', detail: '2025-02-22' })
  assert.deepEqual(echeancesDesPages([page([L('22/03/2025', '10,00', '5,00', '100,00', '115,00'), L('22/02/2025', '10,00', '5,00', '100,00', '115,00')])]), { ok: false, code: 'ligne_incoherente', detail: '2025-02-22' })
})

// ─── Le PDF piégé (review du lot, constat de sécurité S1) ──────────────────
const zlib = require('node:zlib')
const { fluxSousBorne, lireTableauIsole, FLUX_MAX, FLUX_TOTAL_MAX } = require('../lib/charges/credit-tableau')
const flux = (n, dico, donnees) => Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${donnees.length} ${dico} >>\nstream\n`, 'latin1'), donnees, Buffer.from('\nendstream\nendobj\n', 'latin1')])
const pdfDe = (...objets) => Buffer.concat([Buffer.from('%PDF-1.4\n'), ...objets, Buffer.from('%%EOF\n')])

test('LE TEST QUI COMPTE (S1) : un flux qui décompresse au-delà de sa borne fait refuser le PDF AVANT pdf.js — en moins d\'une seconde', async () => {
  const bombe = zlib.deflateSync(Buffer.alloc(FLUX_MAX + 1024))
  assert.ok(bombe.length < 64 * 1024, `une bombe de ${bombe.length} octets`)
  const t0 = Date.now()
  const r = await lireTableau(pdfDe(flux(1, '/Filter /FlateDecode', bombe)))
  assert.deepEqual(r, { ok: false, code: 'tableau_illisible', detail: 'flux_trop_gros' })
  assert.ok(Date.now() - t0 < 1000)
  // Tronquée, elle se compte quand même (pdf.js la décompresserait aussi loin).
  const grosse = zlib.deflateSync(Buffer.alloc(2 * FLUX_MAX))
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /FlateDecode', grosse.subarray(0, grosse.length - 40)))), 'flux_trop_gros')
  // Plusieurs flux sous leur borne, mais au-delà du total.
  const morceau = zlib.deflateSync(Buffer.alloc(FLUX_MAX - 1024))
  const n = Math.ceil(FLUX_TOTAL_MAX / (FLUX_MAX - 1024)) + 1
  assert.equal(fluxSousBorne(pdfDe(...Array.from({ length: n }, (_, i) => flux(i + 1, '/Filter /FlateDecode', morceau)))), 'flux_trop_gros')
})

test('les filtres : ASCII85 + Flate se suivent, un flux Flate que zlib refuse est refusé, LZW n\'est pas pris, une image est laissée', () => {
  const texte = zlib.deflateSync(Buffer.from('BT /F1 9 Tf (22/03/2022) Tj ET'))
  // ASCII85 de `texte`, encodé ici à la main.
  const a85 = (b) => {
    let s = ''
    for (let i = 0; i < b.length; i += 4) {
      const g = Buffer.alloc(4); b.copy(g, 0, i, i + 4)
      let v = g.readUInt32BE(0); const c = []
      for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85) }
      s += c.join('').slice(0, Math.min(5, b.length - i + 1))
    }
    return Buffer.from(s + '~>', 'latin1')
  }
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter [ /ASCII85Decode /FlateDecode ]', a85(texte)))), null)
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /FlateDecode', Buffer.from('pas du zlib')))), 'flux_illisible')
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /LZWDecode', Buffer.from('xx')))), 'filtre_non_pris')
  // Une image est laissée — mais seulement une IMAGE (seconde review) : un flux
  // « JPEG » lu comme contenu serait décodé par pdf.js, à la taille qu'il déclare.
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Type /XObject /Subtype /Image /Filter /DCTDecode', Buffer.from([0xFF, 0xD8, 0xFF])))), null)
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /DCTDecode', Buffer.from([0xFF, 0xD8, 0xFF])))), 'filtre_non_pris')
  // ASCII85 DEVANT une bombe : la chaîne est suivie jusqu'au bout (mutation « ASCII85 ignoré »).
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter [ /ASCII85Decode /FlateDecode ]', a85(zlib.deflateSync(Buffer.alloc(FLUX_MAX + 1024)))))), 'flux_trop_gros')
  // Un flux TRONQUÉ se lit aussi loin qu'il va, comme pdf.js le lit (mutation « sans Z_SYNC_FLUSH ») ;
  // une somme de contrôle fausse ne fait rien refuser (pdf.js ne la vérifie pas) ; un en-tête faux, si.
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /FlateDecode', texte.subarray(0, texte.length - 8)))), null)
  const sommeFausse = Buffer.from(texte); sommeFausse[sommeFausse.length - 1] ^= 0xff
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /FlateDecode', sommeFausse))), null)
  assert.equal(fluxSousBorne(pdfDe(flux(1, '/Filter /FlateDecode', Buffer.concat([Buffer.from([0x78, 0x00]), texte.subarray(2)])))), 'flux_illisible')
})

// ─── Fermé par défaut (seconde review, S1) ─────────────────────────────────
// Chacune de ces formes a passé le contrôle d'avant, et pdf.js les lit.
const BOMBE = zlib.deflateSync(Buffer.alloc(FLUX_MAX + 1024))
const brut = (entete, dico, donnees, mot = 'stream\n') => Buffer.concat([Buffer.from(`${entete}\n<< ${dico} >>\n${mot}`, 'latin1'), donnees, Buffer.from('\nendstream\nendobj\n', 'latin1')])

test('LE TEST QUI COMPTE (S1, fermé par défaut) : clé /F, filtre indirect, nom échappé, fin de ligne exotique, filtres doublés, chaîne déséquilibrée — refusés', () => {
  const L = `/Length ${BOMBE.length}`
  for (const [cas, objet] of [
    ['clé /F (pdf.js lit F comme Filter)', brut('7 0 obj', `${L} /F /FlateDecode`, BOMBE)],
    ['filtre par référence', brut('7 0 obj', `${L} /Filter 8 0 R`, BOMBE)],
    ['nom échappé', brut('7 0 obj', `${L} /Filter /F#6CateDecode`, BOMBE)],
    ['CR seul après stream', brut('7 0 obj', `${L} /Filter /FlateDecode`, BOMBE, 'stream\r')],
    ['espaces avant le LF', brut('7 0 obj', `${L} /Filter /FlateDecode`, BOMBE, 'stream  \n')],
    ['deux /Filter', brut('7 0 obj', `${L} /Filter /DCTDecode /Filter /FlateDecode`, BOMBE)],
    ['un commentaire dans le dictionnaire', brut('7 0 obj', `${L} %x\n/Filter /FlateDecode`, BOMBE)],
    ['un faux en-tête logé dans une chaîne', brut('7 0 obj', `${L} /Filter /FlateDecode /X (8 0 obj)`, BOMBE)],
    ['un tableau de filtres qui n\'est pas fait de noms', brut('7 0 obj', `${L} /Filter [ 8 0 R ]`, BOMBE)]
  ]) assert.equal(fluxSousBorne(pdfDe(objet)), 'flux_suspect', cas)
})

test('S1 : un leurre dans une chaîne, un « endstream » caché dans les données, un en-tête coupé — la vraie bombe est vue', () => {
  const L = `/Length ${BOMBE.length}`
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', `${L} /Note (/Filter /DCTDecode) /Filter /FlateDecode`, BOMBE))), 'flux_trop_gros', 'le leurre est retiré, le vrai filtre lu')
  // « endstream » dans un bloc stocké, en tête du flux zlib ; /Length juste.
  const mot = Buffer.from('endstream')
  const stocke = Buffer.concat([Buffer.from([0x00, mot.length, 0, ~mot.length & 0xff, 0xff]), mot])
  const cache = Buffer.concat([Buffer.from([0x78, 0xda]), stocke, zlib.deflateRawSync(Buffer.alloc(2 * FLUX_MAX)), Buffer.alloc(4)])
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', `/Length ${cache.length} /Filter /FlateDecode`, cache))), 'flux_trop_gros', 'l\'étendue vient de /Length')
  // La même, /Length indirect.
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', '/Length 9 0 R /Filter /FlateDecode', cache), Buffer.from(`9 0 obj\n${cache.length}\nendobj\n`))), 'flux_trop_gros', '/Length indirect résolu')
  // En-tête « 7 0\nobj », précédé d'une image : le dictionnaire lu est le bon.
  const image = brut('8 0 obj', '/Length 4 /Type /XObject /Subtype /Image /Filter /DCTDecode', Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]))
  assert.equal(fluxSousBorne(pdfDe(image, brut('7 0\nobj', `${L} /Filter /FlateDecode`, BOMBE))), 'flux_trop_gros')
  // Brotli (pdf.js 5 le décode), et un flux sans fin.
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', '/Length 2 /Filter /BrotliDecode', Buffer.from('xx')))), 'filtre_non_pris')
  assert.equal(fluxSousBorne(Buffer.from('%PDF-1.4\n7 0 obj\n<< /Length 999 /Filter /FlateDecode >>\nstream\nxx', 'latin1')), 'flux_illisible')
})

test('LE TEST QUI COMPTE (troisième review, mineur 1) : le blanc est celui du LEXEUR de pdf.js — un NUL avant « stream » ne cache plus la bombe, un faux « stream » après 0xA0 ne la fait plus sauter', () => {
  const L = `/Length ${BOMBE.length}`
  // NUL avant le mot : pdf.js le tient pour un blanc, donc pour un flux.
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', `${L} /Filter /FlateDecode`, BOMBE, '\0stream\n'))), 'flux_trop_gros')
  // 0xA0 avant un faux mot : pdf.js n'y voit pas de flux ; son /Length sautait la vraie bombe.
  const vraie = Buffer.concat([Buffer.from(`\nendstream\nendobj\n8 0 obj\n<< ${L} /Filter /FlateDecode >>\nstream\n`, 'latin1'), BOMBE])
  const tete = (n) => Buffer.from(`%PDF-1.4\n7 0 obj\n<< /Length ${String(n).padStart(10, '0')} >>\n\xA0stream\n`, 'latin1')
  const piege = Buffer.concat([tete(vraie.length), vraie, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')])
  assert.equal(fluxSousBorne(piege), 'flux_trop_gros')
})

test('un PDF PROTÉGÉ par un mot de passe de propriétaire, comme en livrent les banques, se lit (troisième review, mineur 7) — le contrôle s\'efface, la garde borne', async () => {
  // tableau-tourne-protege.pdf : tableau-tourne.pdf passé par
  // `qpdf --encrypt "" "proprietaire-fictif" 256 --print=none --modify=none`.
  const protege = pdf('tourne-protege')
  assert.equal(fluxSousBorne(protege), null)
  const [a, b] = [await lireTableau(pdf('tourne')), await lireTableau(protege)]
  assert.equal(b.ok, true, JSON.stringify(b))
  assert.deepEqual(b.echeances, a.echeances)
  // Et un /Encrypt fait s'effacer le contrôle, même devant une bombe : c'est la garde qui la tient.
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', `/Length ${BOMBE.length} /Filter /FlateDecode`, BOMBE), Buffer.from('trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n'))), null)
})

test('une IMAGE n\'est pas décompressée : un logo Flate de plus de 4 Mo ne fait plus refuser le tableau (troisième review, mineur 7)', () => {
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', `/Length ${BOMBE.length} /Type /XObject /Subtype /Image /Width 2480 /Height 600 /Filter /FlateDecode`, BOMBE))), null)
  // La même hors d'une image est une bombe.
  assert.equal(fluxSousBorne(pdfDe(brut('7 0 obj', `/Length ${BOMBE.length} /Filter /FlateDecode`, BOMBE))), 'flux_trop_gros')
})

test('fermé par défaut, mais pas aveugle : le vrai tableau et les fixtures passent, un mot « stream » dans un titre ne déclenche rien', () => {
  for (const nom of ['portrait', 'tourne', 'ligne-fausse', 'sans-capital']) assert.equal(fluxSousBorne(pdf(nom)), null, nom)
  assert.equal(fluxSousBorne(pdfDe(Buffer.from('1 0 obj\n<< /Title (Livestream) /Producer (stream-x) >>\nendobj\n'), flux(2, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from('BT ET'))))), null)
})

test('LE TEST QUI COMPTE (S1) : la lecture tourne dans un fil, bornée en temps — un fil muet est refusé « trop long » et tué ; une instance occupée est une panne', async () => {
  const { EventEmitter } = require('node:events')
  const etat = { vivants: 0, max: 0, termines: 0, limites: null }
  class Muet extends EventEmitter {
    constructor (f, o) { super(); etat.vivants++; etat.max = Math.max(etat.max, etat.vivants); etat.limites = o.resourceLimits; this.stdout = { resume () {} }; this.stderr = { resume () {} } }
    postMessage () {}
    async terminate () { etat.vivants--; etat.termines++ }
  }
  const lents = [1, 2, 3, 4].map(() => lireTableauIsole(Buffer.from('%PDF'), { delaiMs: 60 }, { Worker: Muet }))
  const r = await Promise.all(lents)
  assert.deepEqual(r[3], { panne: 'occupe' }, 'au-delà d\'une file de 2 : occupé')
  assert.deepEqual(r[0], { ok: false, code: 'tableau_illisible', detail: 'trop_long' })
  assert.equal(etat.max, 1, 'jamais deux fils vivants')
  assert.ok(etat.limites && etat.limites.maxOldGenerationSizeMb > 0, 'le tas du fil est borné')
  await new Promise(res => setTimeout(res, 20))
  assert.equal(etat.vivants, 0, 'chaque fil muet est tué')
  // Et le vrai fil lit un vrai tableau (fictif).
  const vrai = await lireTableauIsole(pdf('tourne'))
  assert.equal(vrai.ok, true)
  assert.equal(vrai.echeances.length, 15)
})
