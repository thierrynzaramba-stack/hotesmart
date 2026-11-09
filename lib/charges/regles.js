// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/regles.js — LES RÈGLES PURES DU COMPTE DE CHARGES
// Spec : docs/specs/spec-compte-de-charges.md (§4 Q5, Q14, Q17, Q18 ; §6)
//
// ⚠ CE MODULE NE LIT AUCUNE BASE, N'APPELLE AUCUNE HORLOGE SANS QU'ON LA LUI
// DONNE, NE JOURNALISE RIEN. Le writer (`lib/charges.js`), la lecture IA
// (`lib/charges/lecture.js`) et l'endpoint s'en servent tous : une règle écrite
// à un seul endroit ne peut pas diverger d'une copie.
//
// ⚠ ET RIEN N'EST INVENTÉ. Une valeur illisible devient `null`, jamais 0 ni une
// date du jour : une facture « à 0 € » ou « du jour » passerait pour un vrai
// chiffre dans les totaux (règle du dépôt : un `null` n'est pas un 0).
// ═══════════════════════════════════════════════════════════════════════════

// ─── Les catégories (Q5, liste fermée) ──────────────────────────────────────
// ⚠ L'ORDRE ET LES CLÉS SONT AUSSI DANS LA MIGRATION (contrainte
// `charges_categorie_ck`) : tests/charges-migration.test.js compare les deux.
const CATEGORIES = [
  { cle: 'menage', libelle: 'Ménage' },
  { cle: 'linge', libelle: 'Linge et blanchisserie' },
  { cle: 'consommables', libelle: "Consommables et produits d'accueil" },
  { cle: 'energie', libelle: 'Eau, électricité, gaz' },
  { cle: 'internet_telephone', libelle: 'Internet et téléphone' },
  { cle: 'entretien', libelle: 'Entretien et petites réparations' },
  { cle: 'travaux_equipement', libelle: 'Travaux et équipement' },
  { cle: 'assurance', libelle: 'Assurance' },
  { cle: 'impots_taxes', libelle: 'Impôts et taxes' },
  { cle: 'copropriete', libelle: 'Charges de copropriété' },
  { cle: 'abonnements_logiciels', libelle: 'Abonnements et logiciels' },
  { cle: 'honoraires', libelle: 'Honoraires' },
  { cle: 'commissions_plateformes', libelle: 'Commissions des plateformes' },
  { cle: 'frais_bancaires', libelle: 'Frais bancaires' },
  { cle: 'autre', libelle: 'Autre' }
]
const CLES_CATEGORIES = new Set(CATEGORIES.map(c => c.cle))

// ─── Les justificatifs ──────────────────────────────────────────────────────
const BUCKET = 'justificatifs'
// ⚠ L'API Claude limite une image à 10 Mo ENCODÉE EN BASE64, soit ~7,5 Mo
// bruts : au-delà, la lecture échouerait à chaque passage. Le téléphone réduit
// ses photos avant l'envoi ; le serveur refuse ce qui dépasse.
const TYPES = {
  'application/pdf': { max: 10 * 1024 * 1024, bloc: 'document' },
  'image/jpeg': { max: 7 * 1024 * 1024, bloc: 'image' },
  'image/png': { max: 7 * 1024 * 1024, bloc: 'image' }
}

/**
 * Le type RÉEL d'un fichier, lu dans ses premiers octets — jamais son nom ni
 * le type annoncé par le navigateur. Rend le type MIME, ou `null`.
 */
function typeReel (octets) {
  if (!octets || octets.length < 4) return null
  const b = octets
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf' // %PDF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png'
  return null
}

// ─── Montants, dates, identifiants ──────────────────────────────────────────
const MAX_CENTIMES = 100000000000 // 1 milliard d'euros : au-delà, ce n'est pas une facture lue

/** Euros (nombre ou texte « 1 234,56 ») -> centimes entiers, ou `null`. */
function centimesDepuisEuros (v) {
  if (v === null || v === undefined || v === '') return null
  let n
  if (typeof v === 'number') n = v
  else {
    const t = String(v).replace(/[\s €]/g, '').replace(',', '.')
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null
    n = Number(t)
  }
  if (!Number.isFinite(n) || n < 0) return null
  const c = Math.round(n * 100)
  return c <= MAX_CENTIMES ? c : null
}

/** Centimes envoyés par l'écran : entier ≥ 0, ou `null` pour « vide ». */
function centimesSaisis (v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > MAX_CENTIMES) return undefined // invalide
  return n
}

/** « AAAA-MM-JJ » d'une date qui EXISTE, entre 2000 et 2100 ; sinon `null`. */
function dateValide (v) {
  const t = String(v == null ? '' : v).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return null
  const [a, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (a < 2000 || a > 2100) return null
  const d = new Date(Date.UTC(a, mo - 1, j))
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== j) return null
  return t
}

/** SIRET (14 chiffres) ou SIREN (9 chiffres), espaces retirés ; sinon `null`. */
function siretNormalise (v) {
  const t = String(v == null ? '' : v).replace(/[\s. -]/g, '')
  return /^\d{9}$|^\d{14}$/.test(t) ? t : null
}

const sansAccents = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
/** Un nom comparable : minuscules, sans accents ni ponctuation, espaces réduits. */
function nomComparable (v) {
  return sansAccents(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const texteCourt = (v, max) => {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

// ─── La lecture IA, normalisée ──────────────────────────────────────────────
/**
 * Ce que l'IA a rendu (objet JSON déjà parsé) -> les champs d'une charge.
 * Tout ce qui n'a pas la bonne forme devient `null`. La confiance par champ
 * est gardée telle quelle, bornée à [0, 1].
 */
function normaliserLecture (brut) {
  const b = brut && typeof brut === 'object' ? brut : {}
  const conf = b.confiance && typeof b.confiance === 'object' ? b.confiance : {}
  const confiance = {}
  for (const [k, v] of Object.entries(conf)) {
    const n = Number(v)
    if (Number.isFinite(n)) confiance[k] = Math.max(0, Math.min(1, n))
  }
  const categorie = CLES_CATEGORIES.has(b.categorie) ? b.categorie : null
  return {
    fournisseur_nom: texteCourt(b.fournisseur_nom, 200),
    fournisseur_siret: siretNormalise(b.fournisseur_siret),
    numero_facture: texteCourt(b.numero_facture, 100),
    date_facture: dateValide(b.date_facture),
    date_echeance: dateValide(b.date_echeance),
    montant_ht_cents: centimesDepuisEuros(b.montant_ht),
    montant_tva_cents: centimesDepuisEuros(b.montant_tva),
    montant_ttc_cents: centimesDepuisEuros(b.montant_ttc),
    destinataire_nom: texteCourt(b.destinataire_nom, 200),
    destinataire_siret: siretNormalise(b.destinataire_siret),
    categorie,
    confiance
  }
}

// ─── L'entité proposée (Q6) ─────────────────────────────────────────────────
/**
 * L'entité du destinataire lu sur la facture : par SIRET (ou SIREN, ses
 * 9 premiers chiffres), puis par nom, parmi les entités NON ARCHIVÉES.
 * ⚠ L'IA NE CHOISIT JAMAIS L'ENTITÉ : elle lit un destinataire, et ce code
 * rapproche. Deux candidates possibles, ou aucune : `null` — l'hôte choisit.
 */
function proposerEntite (entites, lu) {
  const actives = (entites || []).filter(e => e && e.id && !e.archivee_le)
  const siret = lu && lu.destinataire_siret
  if (siret) {
    const siren = siret.slice(0, 9)
    const par = actives.filter(e => {
      const s = siretNormalise(e.siret)
      return s && (s === siret || s.slice(0, 9) === siren)
    })
    if (par.length === 1) return par[0].id
    if (par.length > 1) return null
  }
  const nom = nomComparable(lu && lu.destinataire_nom)
  if (!nom) return null
  const par = actives.filter(e => nomComparable(e.nom) === nom)
  return par.length === 1 ? par[0].id : null
}

// ─── Doublons (Q14) ─────────────────────────────────────────────────────────
/**
 * La clé « même fournisseur, même numéro » : le SIREN si on l'a, sinon le nom
 * comparable ; et le numéro sans espaces ni ponctuation. `null` si l'une des
 * deux manque — on ne déclare pas un doublon sur une moitié de preuve.
 */
function cleFournisseurNumero (c) {
  const numero = String((c && c.numero_facture) || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!numero) return null
  const siret = siretNormalise(c.fournisseur_siret)
  const fournisseur = siret ? `siren:${siret.slice(0, 9)}` : (nomComparable(c.fournisseur_nom) ? `nom:${nomComparable(c.fournisseur_nom)}` : '')
  return fournisseur ? `${fournisseur}|${numero}` : null
}

// ─── Le jour d'une charge (§6) ──────────────────────────────────────────────
// Le jour à Paris, en AAAA-MM-JJ : le calendrier de l'hôte, pas celui de
// Vercel (UTC).
const JOUR_PARIS = new Intl.DateTimeFormat('fr-CA',
  { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
const jourParis = (d = new Date()) => JOUR_PARIS.format(d)

/** `date_facture` si elle est connue ; sinon le jour de réception, MARQUÉ. */
function jourDeLaCharge (dateFacture, jourReception) {
  const d = dateValide(dateFacture)
  return d ? { jour: d, date_repli: false } : { jour: jourReception, date_repli: true }
}

module.exports = {
  CATEGORIES, CLES_CATEGORIES, BUCKET, TYPES, MAX_CENTIMES,
  typeReel, centimesDepuisEuros, centimesSaisis, dateValide, siretNormalise,
  nomComparable, texteCourt, normaliserLecture, proposerEntite,
  cleFournisseurNumero, jourParis, jourDeLaCharge
}
