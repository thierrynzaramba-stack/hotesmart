// shared/charges-export.js — TÉLÉCHARGER UN EXERCICE EN ZIP (compte de charges, lot 8d, §14.23).
//
// Le ZIP : la LISTE des factures en PDF, les FACTURES en fichiers séparés
// (« les factures ne sont pas concaténées », décision de Thierry du
// 23 novembre 2026), et un tableau CSV. Les factures ENREGISTRÉES seulement.
//
// ⚠ TOUT SE FABRIQUE DANS LE NAVIGATEUR : une réponse de fonction est bornée
// à 4,5 Mo. Le serveur rend la liste (`/api/ecran/charges?export=1`) et des
// adresses de lecture de 60 s (`export_urls`) ; ce module télécharge chaque
// fichier au stockage et écrit le reste.
// ⚠ UN FICHIER QUI NE VIENT PAS ARRÊTE L'EXPORT, ET LE DIT : un ZIP auquel il
// manque une facture, rendu sans un mot, serait pire que pas de ZIP.
// ⚠ AUCUN TEXTE EN DUR : les noms (dossier, fournisseur inconnu) viennent de
// l'appelant, traduits.

import { zipStocke, crc32, ZIP_MAX_OCTETS } from './zip-simple.js'
import { creerPdf, couper } from './pdf-simple.js'

// Ce que le serveur accepte par appel de `export_urls` (lib/charges.js).
export const PAQUET_URLS = 20
// Téléchargements menés de front. ⚠ LES ADRESSES SE DEMANDENT PAR GROUPE DE
// CETTE TAILLE, juste avant de télécharger le groupe (review du lot 8d, M5) :
// prises par vingt, celles de la fin du paquet expiraient (60 s) sur une
// connexion lente avant même d'avoir servi.
export const EN_PARALLELE = 4
// Essais par fichier, chacun avec une adresse neuve après le premier.
const ESSAIS = 3

export const EXTENSIONS = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/tiff': 'tif',
  'image/heic': 'heic', 'image/heif': 'heif'
}

/** Un nom de fichier en caractères simples : accents retirés, le reste en tirets. */
export function nomSimple (texte, max = 40) {
  // Les ligatures ne se décomposent pas : « Cœur » doit donner « Coeur ».
  const s = String(texte == null ? '' : texte).replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, max).replace(/-+$/, '')
}

// Un montant pour un NOM de fichier : « 84,20 », « -50,00 » pour un avoir.
const montantNom = (c) => (Number.isInteger(c) ? (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2).replace('.', ',') : null)

/**
 * Les lignes de l'export, numérotées dans l'ordre du serveur (jour, puis
 * arrivée), avec le nom de leur fichier dans le ZIP — ou `null` pour une
 * charge sans fichier (commission de plateforme, échéance de crédit).
 * `dossier` : le nom du dossier des factures dans le ZIP ; `sansNom` : le mot
 * d'un fichier dont le fournisseur n'est pas lu (ou s'écrit hors de l'alphabet
 * latin). Tous deux traduits par l'appelant.
 */
export function preparerExport (lignes, { dossier, sansNom }) {
  const largeurNumero = Math.max(3, String(lignes.length).length)
  return lignes.map((l, i) => {
    const numero = String(i + 1).padStart(largeurNumero, '0')
    const ext = EXTENSIONS[l.justificatif_type] || 'bin'
    const parties = [numero, l.jour, nomSimple(l.fournisseur_nom) || nomSimple(sansNom), montantNom(l.montant_ttc_cents)].filter(Boolean)
    return { ...l, numero, chemin: l.fichier ? `${dossier}/${parties.join('_')}.${ext}` : null }
  })
}

const COLONNES_MONTANT = [['ht', 'montant_ht_cents'], ['tva', 'montant_tva_cents'], ['ttc', 'montant_ttc_cents']]

/**
 * Les totaux de la liste, colonne par colonne. ⚠ UNE CHARGE « NON COMPTÉE »
 * (échéancier, doublon ou commission non tranchés — la règle du résumé, rendue
 * par le serveur) n'y entre pas : le total est celui de l'écran (review du
 * lot 8d, B1). ⚠ UN MONTANT NON LU N'Y ENTRE PAS NON PLUS, ET SE COMPTE PAR
 * COLONNE (B2) ; une colonne sans aucun montant lu n'a pas de total (`null`),
 * jamais 0.
 */
export function totauxExport (lignes) {
  const t = { ht: 0, tva: 0, ttc: 0, lus: { ht: 0, tva: 0, ttc: 0 }, non_lus: { ht: 0, tva: 0, ttc: 0 }, hors: 0 }
  for (const l of lignes) {
    if (l.compte === false) { t.hors++; continue }
    for (const [k, col] of COLONNES_MONTANT) {
      if (Number.isInteger(l[col])) { t[k] += l[col]; t.lus[k]++ } else t.non_lus[k]++
    }
  }
  for (const [k] of COLONNES_MONTANT) if (!t.lus[k]) t[k] = null
  return t
}

// Une date JJ/MM/AAAA, quelle que soit la langue (review du lot 8d, M2 : un
// « 01/05/2026 » anglais se lirait 1er mai dans Excel en français).
const jourFixe = (j) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(j || ''))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

// ─── Le CSV ─────────────────────────────────────────────────────────────────
// ⚠ POUR EXCEL EN FRANÇAIS, TEL QUEL : UTF-8 AVEC BOM (sinon les accents
// sortent mal), séparateur `;`, virgule décimale, aucune espace de milliers.
const champCsv = (v) => {
  const s = v == null ? '' : String(v)
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
// ⚠ UN TEXTE LU SUR UNE FACTURE NE DEVIENT JAMAIS UNE FORMULE (review du lot
// 8d, M1) : un fournisseur « =HYPERLINK(…) » s'écrit précédé d'une apostrophe.
const texteCsv = (v) => {
  const s = v == null ? '' : String(v)
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}
// ⚠ UN IDENTIFIANT RESTE DU TEXTE (M1) : un SIRET de 14 chiffres ne devient
// pas « 1,23457E+13 », ni « 001 » le nombre 1, ni « 2026-03 » une date.
const identifiantCsv = (v) => (v == null || v === '' ? '' : `="${String(v).replace(/"/g, '""')}"`)
const montantCsv = (c) => (Number.isInteger(c) ? (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2).replace('.', ',') : '')

/**
 * Le CSV de la liste préparée. `noms` : { bien(id), categorie(cle),
 * type(ligne) } ; `t` pour les titres et « oui / non ».
 */
export function csvExport (prepare, { t, noms }) {
  const tete = ['numero', 'date', 'fournisseur', 'siret', 'numero_facture', 'type', 'categorie', 'logement', 'periode_debut', 'periode_fin', 'ht', 'tva', 'ttc', 'comptee', 'fichier']
    .map(k => t('charges.export_col_' + k))
  const lignes = prepare.map(l => [
    identifiantCsv(l.numero), jourFixe(l.jour), texteCsv(l.fournisseur_nom), identifiantCsv(l.fournisseur_siret), identifiantCsv(l.numero_facture),
    noms.type(l), l.categorie ? noms.categorie(l.categorie) : '', l.bien_id ? texteCsv(noms.bien(l.bien_id)) : '',
    jourFixe(l.periode_debut), jourFixe(l.periode_fin),
    montantCsv(l.montant_ht_cents), montantCsv(l.montant_tva_cents), montantCsv(l.montant_ttc_cents),
    t(l.compte === false ? 'charges.export_non' : 'charges.export_oui'),
    texteCsv(l.chemin || '')
  ])
  return '\ufeff' + [tete, ...lignes].map(r => r.map(champCsv).join(';')).join('\r\n') + '\r\n'
}

// ─── Le PDF de la liste ─────────────────────────────────────────────────────
// A4 paysage, marges de 36 points. Les colonnes et leur largeur (770 points).
const COLONNES = [
  { cle: 'numero', l: 38 }, { cle: 'date', l: 58 }, { cle: 'fournisseur', l: 166 }, { cle: 'numero_facture', l: 90 },
  { cle: 'categorie', l: 140 }, { cle: 'logement', l: 100 },
  { cle: 'ht', l: 58, droite: true }, { cle: 'tva', l: 54, droite: true }, { cle: 'ttc', l: 66, droite: true }
]
const MARGE = 36
const TAILLE = 8
const PAS = 14

/**
 * Le PDF de la liste. `entete` : { titre, entite, du_au, compte, a_traiter }
 * — des textes déjà traduits ; `noms` comme pour le CSV. Repères de ligne :
 * « * » sans fichier, « ° » non comptée dans le total ; chacun expliqué en
 * bas de la liste s'il sert.
 */
export function pdfExport (prepare, { t, langue = 'fr', noms, entete }) {
  const doc = creerPdf()
  const H = doc.hauteur
  const fmt = new Intl.NumberFormat(langue, { style: 'currency', currency: 'EUR' })
  const montant = (c) => (Number.isInteger(c) ? fmt.format(c / 100) : '—')
  let y = 0
  const colonnesX = []
  let x0 = MARGE
  for (const c of COLONNES) { colonnesX.push(x0); x0 += c.l }
  const ligneDeTitres = () => {
    COLONNES.forEach((c, i) => {
      const txt = t('charges.export_col_' + c.cle)
      doc.texte(c.droite ? colonnesX[i] + c.l - 4 : colonnesX[i], y, txt, { taille: TAILLE, gras: true, aDroite: c.droite })
    })
    doc.trait(MARGE, y - 4, MARGE + 770, y - 4, { epaisseur: 0.6, gris: 0.4 })
    y -= PAS + 2
  }
  const nouvellePage = (premiere) => {
    doc.page()
    y = H - MARGE - 10
    if (premiere) {
      doc.texte(MARGE, y, entete.titre, { taille: 15, gras: true })
      doc.texte(MARGE + 770, y, t('charges.export_marque'), { taille: 9, gris: 0.45, aDroite: true })
      y -= 20
      for (const ligne of [entete.entite, entete.du_au, entete.compte].filter(Boolean)) { doc.texte(MARGE, y, ligne, { taille: 9 }); y -= 13 }
      if (entete.a_traiter) { doc.texte(MARGE, y, entete.a_traiter, { taille: 9, gras: true }); y -= 13 }
      y -= 10
    } else {
      doc.texte(MARGE, y, entete.titre, { taille: 9, gris: 0.45 })
      y -= 18
    }
    ligneDeTitres()
  }
  nouvellePage(true)
  let sansFichier = false
  let horsTotal = false
  for (const l of prepare) {
    if (y < MARGE + 30) nouvellePage(false)
    const reperes = (l.chemin ? '' : ' *') + (l.compte === false ? ' °' : '')
    const valeurs = {
      numero: l.numero + reperes,
      date: jourFixe(l.jour),
      fournisseur: l.fournisseur_nom || t('charges.fournisseur_inconnu'),
      numero_facture: l.numero_facture || '',
      categorie: l.categorie ? noms.categorie(l.categorie) : '',
      logement: l.bien_id ? noms.bien(l.bien_id) : '',
      ht: montant(l.montant_ht_cents), tva: montant(l.montant_tva_cents), ttc: montant(l.montant_ttc_cents)
    }
    if (!l.chemin) sansFichier = true
    if (l.compte === false) horsTotal = true
    // Une ligne non comptée s'écrit en gris : elle est là, elle ne compte pas.
    const gris = l.compte === false ? 0.45 : 0
    COLONNES.forEach((c, i) => {
      const txt = couper(valeurs[c.cle], c.l - 6, TAILLE)
      doc.texte(c.droite ? colonnesX[i] + c.l - 4 : colonnesX[i], y, txt, { taille: TAILLE, gris, aDroite: c.droite })
    })
    doc.trait(MARGE, y - 4, MARGE + 770, y - 4, { epaisseur: 0.3, gris: 0.8 })
    y -= PAS
  }
  // Le total, puis ce qu'il faut savoir pour le lire.
  if (y < MARGE + 70) nouvellePage(false)
  const tot = totauxExport(prepare)
  y -= 4
  doc.texte(colonnesX[0], y, t('charges.export_total'), { taille: TAILLE + 1, gras: true })
  for (const [cle] of COLONNES_MONTANT) {
    const i = COLONNES.findIndex(c => c.cle === cle)
    doc.texte(colonnesX[i] + COLONNES[i].l - 4, y, tot[cle] == null ? '—' : fmt.format(tot[cle] / 100), { taille: TAILLE + 1, gras: true, aDroite: true })
  }
  y -= PAS + 4
  const notes = []
  const nl = tot.non_lus
  if (nl.ht || nl.tva || nl.ttc) notes.push(t('charges.export_non_lus_col', { ht: nl.ht, tva: nl.tva, ttc: nl.ttc }))
  if (horsTotal) notes.push(t('charges.export_hors_total'))
  if (sansFichier) notes.push(t('charges.export_sans_fichier'))
  for (const n of notes) { doc.texte(MARGE, y, n, { taille: TAILLE, gris: 0.35 }); y -= 12 }
  // Les numéros de page, une fois le nombre connu.
  const n = doc.nombrePages
  for (let p = 1; p <= n; p++) doc.texte(MARGE + 770, 20, t('charges.export_page', { i: p, n }), { taille: 8, gris: 0.45, aDroite: true, page: p })
  return doc.octets()
}

// ─── Le téléchargement des fichiers ─────────────────────────────────────────
/**
 * Télécharge le fichier de chaque ligne qui en a un, quatre de front.
 * `agir(corps)` : `POST /api/charges` ; `telecharger(url, { signal })` →
 * `Uint8Array` (lève si le stockage refuse ou si le délai passe) ;
 * `avancer(fait, total, ligne)` à chaque fichier reçu ; `Blob` et
 * `AbortController` : ceux de la fenêtre de la page (un signal d'une autre
 * fenêtre est refusé par `AbortSignal.any`).
 * Rend `Map(id → { blob, crc, taille })`, ou lève `{ code: 'fichier_absent',
 * ligne }` si un fichier ne vient pas après trois essais, `{ code:
 * 'zip_trop_gros' }` si l'ensemble dépasse ce qu'un ZIP peut porter.
 * ⚠ LE PREMIER ÉCHEC ARRÊTE TOUT (review du lot 8d, M4) : les
 * téléchargements en cours sont interrompus, et plus rien n'est annoncé.
 * ⚠ CHAQUE FICHIER EST GARDÉ EN BLOB, son CRC calculé à la réception (M9) :
 * le ZIP final référence ces Blob au lieu de recopier les octets.
 */
export async function telechargerFichiers (prepare, { agir, telecharger, avancer = () => {}, Blob: Bloc = globalThis.Blob, AbortController: Arret = globalThis.AbortController }) {
  const aPrendre = prepare.filter(l => l.chemin)
  const recus = new Map()
  const arret = new Arret()
  let fini = false
  let fait = 0
  let poids = 0
  const urlNeuve = async (l) => {
    const r = await agir({ action: 'export_urls', ids: [l.id] })
    const u = ((r && r.urls) || []).find(x => String(x.id) === String(l.id))
    return u ? u.url : null
  }
  const prendre = async (l, url) => {
    for (let essai = 1; essai <= ESSAIS; essai++) {
      if (fini) return
      if (url) {
        try {
          const octets = await telecharger(url, { signal: arret.signal })
          if (fini) return
          poids += octets.length
          if (poids > ZIP_MAX_OCTETS) throw Object.assign(new Error('zip_trop_gros'), { code: 'zip_trop_gros', definitif: true })
          recus.set(String(l.id), { blob: new Bloc([octets]), crc: crc32(octets), taille: octets.length })
          avancer(++fait, aPrendre.length, l)
          return
        } catch (e) {
          if (e && e.definitif) throw e
          /* un autre essai, avec une adresse neuve */
        }
      }
      if (essai < ESSAIS && !fini) { try { url = await urlNeuve(l) } catch { url = null } }
    }
    throw Object.assign(new Error('fichier_absent'), { code: 'fichier_absent', ligne: l })
  }
  try {
    for (let i = 0; i < aPrendre.length; i += EN_PARALLELE) {
      const groupe = aPrendre.slice(i, i + EN_PARALLELE)
      // Une demande d'adresses en panne n'arrête rien : chaque fichier
      // redemande alors la sienne (review du lot 8d, M5).
      let urls = new Map()
      try {
        const r = await agir({ action: 'export_urls', ids: groupe.map(l => l.id) })
        urls = new Map(((r && r.urls) || []).map(u => [String(u.id), u.url]))
      } catch { urls = new Map() }
      await Promise.all(groupe.map(l => prendre(l, urls.get(String(l.id)) || null)))
    }
  } catch (e) {
    fini = true
    arret.abort()
    throw e
  }
  return recus
}

/** Les morceaux du ZIP : la liste, les factures, le CSV. */
export function zipExport ({ nomListe, pdf, nomCsv, csv, prepare, fichiers, date }) {
  const enc = new TextEncoder()
  const entrees = [{ nom: nomListe, octets: pdf }]
  for (const l of prepare) {
    if (!l.chemin) continue
    const f = fichiers.get(String(l.id))
    entrees.push({ nom: l.chemin, blob: f.blob, crc: f.crc, taille: f.taille })
  }
  entrees.push({ nom: nomCsv, octets: enc.encode(csv) })
  return zipStocke(entrees, date)
}
