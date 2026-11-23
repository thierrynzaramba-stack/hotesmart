// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/email.js — RECEVOIR UNE FACTURE PAR E-MAIL (compte de charges, lot 5)
// Spec : docs/specs/spec-compte-de-charges.md §7 (« L'e-mail entrant ») et §14.24
//
// `api/inbound-email.js` aiguille ici tout e-mail dont le destinataire RELU
// chez Brevo est une adresse de factures (`<nom>.<code>@reply.hotesmart.fr`).
// Ce chemin ne répond jamais à personne : il range des factures.
//
// ⚠ LE COMPTE NE VIENT JAMAIS DU MESSAGE. Il vient de l'adresse relue, résolue
// en base (`lib/charges/adresse.js`) : l'entité et le logement aussi.
//
// ⚠ LES PIÈCES JOINTES SONT CONFRONTÉES À LA RELECTURE (Q15). Le POST n'est
// pas authentifiable ; la relecture `GET /inbound/events/<uuid>` rend, par
// pièce, son nom, son type et sa taille — pas le jeton de téléchargement, qui
// n'existe QUE dans le POST. D'où, sans exception :
//   · même nombre de pièces des deux côtés, chacune appariée par son nom et
//     son type (et son Content-ID quand les deux le donnent) ;
//   · un champ absent de la relecture est un REFUS (sans taille relue, le
//     contrôle suivant ne bloquerait plus rien) ;
//   · les octets téléchargés doivent faire EXACTEMENT la taille relue. La
//     taille du POST, elle, n'est pas comparée : Brevo la documente comme une
//     ESTIMATION (« Estimated size of the attachment »).
//
// ⚠ TROIS ISSUES, ET ELLES NE SE CONFONDENT PAS :
//   · `{ rejouer: true }` — une panne passagère (Brevo en 5xx, réseau,
//     stockage, convertisseur occupé, délai) : l'appelant rend 503 et Brevo
//     rejoue l'e-mail. Ce qui est déjà entré ne se double pas (index uniques) ;
//   · `{ issue }` avec des pièces refusées — un refus DÉFINITIF (taille qui ne
//     correspond pas, type refusé, pièce introuvable) : 200, et une ligne
//     « sans facture lisible » qui le dit à l'hôte. Sinon Brevo rejouerait
//     jusqu'à épuisement et la facture disparaîtrait sans trace ;
//   · `{ issue: 'adresse_refusee' }` — une adresse inconnue, changée, d'une
//     entité ou d'un logement archivé : 200, trace au journal SEULEMENT. Une
//     adresse abandonnée ne doit pas continuer de remplir la liste de l'hôte.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('node:crypto')
const adresse = require('./adresse')
const charges = require('../charges')
const { TYPES } = require('./regles')

// Au plus tant de pièces PRISES par e-mail (proposition du §7) ; au-delà,
// elles sont refusées en le disant.
const MAX_PIECES = 10
// ⚠ AU PLUS 50 LIGNES REÇUES PAR E-MAIL PAR COMPTE ET PAR 24 HEURES (Thierry,
// 23 novembre 2026 ; review du lot 5, constat 7). Quiconque connaît une
// adresse peut y écrire : sans plafond, il remplirait le stockage et la file
// « À traiter », et mangerait les 100 lectures IA du jour que les dépôts à la
// main partagent. Au-delà, rien n'entre, et UNE ligne par 24 heures le dit.
const QUOTA_EMAIL_JOUR = 50
// ⚠ UNE PETITE IMAGE N'EST PAS UNE FACTURE (§14.24.2, point 6) : un logo de
// signature, une icône de réseau social. Un PDF est TOUJOURS pris.
const IMAGE_MIN_OCTETS = 30 * 1024
// ⚠ UN TYPE ANNONCÉ VAGUE N'EST PAS UN REFUS (review du lot 5, constat 6) : un
// logiciel de facturation envoie souvent son PDF en `octet-stream`. La pièce
// est prise, et c'est son CONTENU qui décide (`typeReel`) ; ce qui n'est ni un
// PDF ni une image lisible est alors refusé en le disant.
const TYPES_VAGUES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-pdf',
  'application/download', 'application/force-download', 'image/jpg', 'image/pjpeg'])
const TAILLE_MAX = Math.max(...Object.values(TYPES).map(t => t.max))
// ⚠ LE BUDGET DU WEBHOOK (60 s dans vercel.json), ET CHAQUE ÉTAPE EST BORNÉE
// PAR CE QUI RESTE (review du lot 5, constat 2) — pas seulement son début :
//   · une pièce ne commence plus après 17 s (pire cas d'une pièce :
//     téléchargement 15 s, conversion HEIC 15 s, dépôt 8 s) ; ce qui reste
//     se fait au rejeu, qui saute les pièces déjà entrées ;
//   · une lecture IA ne commence plus après 28 s (reconnaissance d'un
//     tableau 6 s, puis IA 20 s au plus) ;
//   · rien ne dépasse 55 s.
const BUDGET_TOTAL_MS = 55000
const DEBUT_PIECE_MAX_MS = 17000
const DEBUT_LECTURES_MAX_MS = 28000
const DELAI_PIECE_MS = 15000
const DELAI_STOCKAGE_MS = 8000
// Le jeton de téléchargement vient du POST : contrôlé avant d'entrer dans une
// URL, puis encodé.
const JETON_PIECE_RE = /^[A-Za-z0-9._~-]{8,1024}$/
const URL_PIECES = 'https://api.brevo.com/v3/inbound/attachments/'

const typeAnnonce = (v) => String(v == null ? '' : v).toLowerCase().split(';')[0].trim()
const champ = (o, ...cles) => {
  for (const k of cles) if (o && o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}

/** Les pièces du POST, telles qu'il les décrit. */
function piecesDuPost (item) {
  const brut = champ(item, 'Attachments', 'attachments')
  if (!Array.isArray(brut)) return []
  return brut.map(p => ({
    nom: String(champ(p, 'Name', 'name') ?? ''),
    type: typeAnnonce(champ(p, 'ContentType', 'contentType')),
    contentId: champ(p, 'ContentID', 'ContentId', 'contentId') ?? null,
    jeton: champ(p, 'DownloadToken', 'downloadToken') ?? null
  }))
}

/**
 * Le POST et la relecture décrivent-ils les mêmes pièces ? Rend les paires
 * (le nom, le type et la taille RELUS, le jeton du POST), ou le motif d'un
 * refus de TOUT l'e-mail : sans accord sur la liste, aucune pièce n'est sûre.
 */
function apparier (post, ref) {
  const relues = champ(ref, 'attachments', 'Attachments')
  // ⚠ UN POST SANS PIÈCE FACE À UNE RELECTURE QUI EN LISTE n'est pas « sans
  // pièce » (review du lot 5, constat 5) : c'est un désaccord, et l'hôte doit
  // lire que des pièces n'ont pas pu être vérifiées.
  if (!post.length) {
    return Array.isArray(relues) && relues.length ? { ok: false, motif: 'pieces_divergentes' } : { ok: true, paires: [] }
  }
  if (!Array.isArray(relues)) return { ok: false, motif: 'relecture_incomplete' }
  if (relues.length !== post.length) return { ok: false, motif: 'pieces_divergentes' }
  const decrites = []
  for (const r of relues) {
    const nom = champ(r, 'name', 'Name')
    const type = champ(r, 'contentType', 'ContentType')
    const taille = Number(champ(r, 'contentLength', 'ContentLength'))
    if (nom === undefined || type === undefined || !Number.isInteger(taille) || taille < 0) {
      return { ok: false, motif: 'relecture_incomplete' }
    }
    decrites.push({ nom: String(nom), type: typeAnnonce(type), taille, contentId: champ(r, 'contentId', 'ContentId', 'ContentID') ?? null, prise: false })
  }
  const paires = []
  for (const p of post) {
    const r = decrites.find(x => !x.prise && x.nom === p.nom && x.type === p.type &&
      (p.contentId == null || x.contentId == null || String(p.contentId) === String(x.contentId)))
    if (!r) return { ok: false, motif: 'pieces_divergentes' }
    r.prise = true
    paires.push({ nom: r.nom, type: r.type, taille: r.taille, jeton: p.jeton })
  }
  return { ok: true, paires }
}

/**
 * Ce qu'on fait de chaque pièce, AVANT tout téléchargement : `prendre`,
 * `ignorer` (pas une facture : un type qu'on ne lit pas, une petite image),
 * ou `refuser` avec son motif.
 */
function trier (paires) {
  let prises = 0
  return paires.map((p, rang) => {
    const t = TYPES[p.type]
    const vague = !t && TYPES_VAGUES.has(p.type)
    if (!t && !vague) return { ...p, rang, sort: 'ignorer' }
    // Une petite pièce au type vague est prise : ce peut être un petit PDF.
    if (p.type.startsWith('image/') && p.taille < IMAGE_MIN_OCTETS) return { ...p, rang, sort: 'ignorer' }
    if (p.taille > (t ? t.max : TAILLE_MAX)) return { ...p, rang, sort: 'refuser', motif: 'trop_gros' }
    if (!p.jeton || !JETON_PIECE_RE.test(String(p.jeton))) return { ...p, rang, sort: 'refuser', motif: 'jeton_piece_invalide' }
    if (prises >= MAX_PIECES) return { ...p, rang, sort: 'refuser', motif: 'trop_de_pieces' }
    prises++
    return { ...p, rang, sort: 'prendre' }
  })
}

/**
 * L'identifiant d'une pièce, LE MÊME À CHAQUE REJEU : tiré du compte, de
 * l'e-mail et de ce que la RELECTURE dit de la pièce (rang, nom, type,
 * taille). Il nomme la charge et le chemin du fichier : un rejeu reconnaît
 * une pièce déjà entrée AVANT de la retélécharger (review du lot 5,
 * constat 1), et réécrit le même objet au lieu d'en laisser un orphelin.
 * Forme d'un UUID v4 (version 4, variante 8 à b), comme `crypto.randomUUID`.
 */
function idDePiece (compte, uuid, piece) {
  const h = crypto.createHash('sha256')
    .update([compte, uuid, piece.rang, piece.nom, piece.type, piece.taille].join('|')).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Les octets d'une pièce chez Brevo : `{ octets }`, `{ refus }` ou `{ panne }`. */
async function telechargerPiece (jeton, { cle, fetch: f = fetch, delaiMs = DELAI_PIECE_MS } = {}) {
  if (!cle) return { panne: 'cle_plateforme_absente' }
  let r
  try {
    r = await f(URL_PIECES + encodeURIComponent(jeton), {
      headers: { 'api-key': cle }, signal: AbortSignal.timeout(delaiMs)
    })
  } catch (e) {
    return { panne: 'brevo_injoignable' }
  }
  if (r.status >= 500 || r.status === 408 || r.status === 425 || r.status === 429) return { panne: `brevo_${r.status}` }
  if (!r.ok) return { refus: 'piece_introuvable', statut: r.status }
  try {
    return { octets: Buffer.from(await r.arrayBuffer()) }
  } catch (e) {
    return { panne: 'brevo_coupe' }
  }
}

/**
 * Reçoit un e-mail adressé à une adresse de factures.
 * @param p.ref        la relecture Brevo (`GET /inbound/events/<uuid>`)
 * @param p.item       le POST de Brevo
 * @param p.uuid       l'identifiant Brevo de l'événement
 * @param p.expediteur l'expéditeur RELU (repli : celui du POST)
 * @param p.sujet      le sujet RELU
 * @param p.texte      le texte utile du POST (pour « sans facture lisible »)
 * @param p.debut      l'instant où le webhook a commencé (le budget en part)
 * @param deps.cle     la clé Brevo de la plateforme
 */
async function recevoir (db, p, deps = {}) {
  const maintenant = deps.maintenant || (() => Date.now())
  const debut = p.debut || maintenant()

  const cible = await adresse.resoudre(db, p.ref && p.ref.recipient, deps)
  if (!cible.ok) {
    return cible.definitif
      ? { issue: 'adresse_refusee', trace: { raison: cible.raison } }
      : { rejouer: true, raison: cible.raison }
  }
  const commun = {
    compte: cible.compte, uuid: p.uuid, entiteId: cible.entiteId, bienId: cible.bienId,
    expediteur: p.expediteur, recuLe: p.ref && p.ref.receivedAt, sujet: p.sujet
  }

  const a = apparier(piecesDuPost(p.item), p.ref)
  const triees = a.ok ? trier(a.paires) : []
  const refusees = a.ok ? triees.filter(x => x.sort === 'refuser').map(x => x.motif) : [a.motif]
  const ignorees = triees.filter(x => x.sort === 'ignorer').length
  const aPrendre = triees.filter(x => x.sort === 'prendre')
  const nouvelles = []
  let deja = 0

  // Les pièces déjà entrées (un rejeu) : sautées sans être retéléchargées.
  let dejaLa = new Set()
  if (aPrendre.length) {
    const l = await charges.piecesDeLEmail(db, { compte: cible.compte, uuid: p.uuid })
    if (!l.ok) return { rejouer: true, raison: l.code }
    dejaLa = l.ids
  }
  // Le plafond du jour : ce qui reste de place. Une pièce déjà entrée (rejeu)
  // est déjà comptée et n'en reprend pas.
  const volume = await charges.lignesEmailDuJour(db, cible.compte, deps)
  if (!volume.ok) return { rejouer: true, raison: volume.code }
  let libres = QUOTA_EMAIL_JOUR - volume.nombre
  const reste = () => debut + BUDGET_TOTAL_MS - maintenant()

  for (const piece of aPrendre) {
    const id = idDePiece(cible.compte, p.uuid, piece)
    if (dejaLa.has(id)) { deja++; continue }
    if (libres <= 0) { refusees.push('quota_jour'); continue }
    // Une pièce ne commence plus passé 17 s : ce qui reste se fait au rejeu,
    // qui saute ce qui est déjà entré — chaque passage avance.
    if (maintenant() > debut + DEBUT_PIECE_MAX_MS) return { rejouer: true, raison: 'delai' }
    const t = await telechargerPiece(piece.jeton, { cle: deps.cle, fetch: deps.fetch, delaiMs: Math.min(DELAI_PIECE_MS, Math.max(1, reste())) })
    if (t.panne) return { rejouer: true, raison: t.panne }
    if (t.refus) {
      console.error('[charges-email] piece refusee par Brevo', t.statut)
      refusees.push(t.refus)
      continue
    }
    if (t.octets.length !== piece.taille) {
      console.error('[charges-email] taille differente', t.octets.length, piece.taille)
      refusees.push('taille_differente')
      continue
    }
    const d = await charges.deposerPieceEmail(db, { ...commun, id, octets: t.octets },
      { ...deps, delaiStockageMs: Math.min(DELAI_STOCKAGE_MS, Math.max(1, reste())) })
    if (!d.ok && d.statut >= 500) return { rejouer: true, raison: d.code }
    if (!d.ok) { refusees.push(d.code); continue }
    if (d.deja) { deja++; continue }
    nouvelles.push(d)
    libres--
  }

  // ⚠ L'HÔTE VOIT TOUJOURS QU'ON LUI A ÉCRIT : un e-mail dont aucune pièce
  // n'est entrée, ou dont une pièce a été refusée, laisse UNE ligne qui le dit.
  // Plafond atteint : cette ligne dit le plafond, et elle n'est posée qu'UNE
  // fois par 24 heures — sinon un expéditeur en boucle remplirait la file
  // avec elle. Un refus de la base sur cette ligne est définitif : tracé, pas
  // rejoué.
  const auPlafond = libres <= 0
  if (refusees.length || nouvelles.length + deja === 0) {
    if (auPlafond && volume.quotaSignale) {
      console.error('[charges-email] plafond du jour atteint, deja signale')
    } else {
      const motif = auPlafond ? 'quota_jour' : (refusees[0] || 'sans_piece')
      const s = await charges.noterSansFacture(db, { ...commun, texte: p.texte, motif })
      if (!s.ok && s.statut >= 500) return { rejouer: true, raison: s.code }
      if (!s.ok) console.error('[charges-email] ligne sans facture refusee', s.code)
    }
  }

  // La lecture à l'arrivée (Q28), tant que le budget le permet ; sinon, ou
  // en cas de panne, la facture reste `a_lire` et le cron quotidien la relit.
  // ⚠ RIEN ICI NE FAIT REJOUER : les factures sont déjà entrées.
  let lues = 0
  try {
    const lire = deps.lire || charges.avecReconnaissance(require('./lecture').lireDocument, deps)
    const autorise = deps.lectureAutorisee || charges.lectureAutorisee
    for (const n of nouvelles) {
      if (maintenant() > debut + DEBUT_LECTURES_MAX_MS) break
      const resultat = (await autorise(db, cible.compte))
        ? await lire({ octets: n.octets, type: n.type, compte: cible.compte })
        : { plafond: true }
      await charges.appliquerLecture(db, { compte: cible.compte, id: n.charge.id, resultat }, deps)
      if (resultat && (resultat.panne || resultat.plafond)) break
      lues++
    }
  } catch (e) {
    console.error('[charges-email] lecture', e && e.message)
  }

  return {
    issue: 'recue',
    trace: { prises: nouvelles.length, deja, ignorees, refusees, lues, plafond: auPlafond, rappel_entite: Boolean(cible.bienId && !cible.entiteId) }
  }
}

module.exports = {
  recevoir, apparier, trier, piecesDuPost, telechargerPiece, idDePiece,
  MAX_PIECES, QUOTA_EMAIL_JOUR, IMAGE_MIN_OCTETS, BUDGET_TOTAL_MS, DEBUT_PIECE_MAX_MS, DEBUT_LECTURES_MAX_MS, JETON_PIECE_RE
}
