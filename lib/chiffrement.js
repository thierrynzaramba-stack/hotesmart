// lib/chiffrement.js
// DOC : docs/kb/moteur-reservation.md §10 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §3 bis, exigence 1
//
// LE CHIFFREMENT DES SECRETS D'HOTE.
// Premier mecanisme de chiffrement du depot. Il existe parce que HoteSmart va
// detenir les cles Stripe de ses hotes : de quoi encaisser et rembourser chez
// eux. Une base lue par un tiers ne doit pas suffire a s'en servir.
//
// AES-256-GCM, et GCM plutot que CBC pour une raison precise : il AUTHENTIFIE.
// Un chiffre modifie en base ne se dechiffre pas en silence, il leve. Sans cela,
// une alteration produirait des octets quelconques qu'on enverrait a Stripe.
//
// FORMAT : `v1:<iv b64>:<tag b64>:<chiffre b64>`
// Le prefixe de version n'est pas decoratif — c'est ce qui permettra de tourner
// l'algorithme ou la cle sans avoir a deviner comment une ligne a ete ecrite.
//
// ⚠ LA CLE, `BOOKING_SECRET_ENCRYPTION_KEY` : 32 octets en base64.
//   PERDUE    -> toutes les connexions Stripe meurent, chaque hote recolle.
//   DIVULGUEE -> toutes les cles des hotes sont exposees.
// Elle ne se regenere pas a la legere.

const crypto = require('crypto')

const VERSION = 'v1'
const ALGO = 'aes-256-gcm'
const TAILLE_CLE = 32
const TAILLE_IV = 12          // 96 bits : la taille recommandee pour GCM

// La cle est lue A CHAQUE APPEL, jamais mise en cache au chargement du module.
// Un cache au niveau module fait echouer les tests qui posent la variable apres
// l'import, et masque une variable changee a chaud.
function cle () {
  const brut = process.env.BOOKING_SECRET_ENCRYPTION_KEY
  if (!brut) throw new Error('BOOKING_SECRET_ENCRYPTION_KEY absente')
  let k
  try { k = Buffer.from(String(brut).trim(), 'base64') } catch (e) {
    throw new Error('BOOKING_SECRET_ENCRYPTION_KEY illisible')
  }
  // ⚠ Un base64 invalide ne LEVE PAS en Node : il rend un Buffer plus court.
  // Sans ce controle, une cle tronquee passerait pour valide et chiffrerait avec
  // beaucoup moins d'entropie que prevu.
  if (k.length !== TAILLE_CLE) {
    throw new Error(`BOOKING_SECRET_ENCRYPTION_KEY : ${k.length} octets au lieu de ${TAILLE_CLE}`)
  }
  return k
}

// Rend le format versionne. Refuse une valeur vide : chiffrer du vide donnerait
// un chiffre valide qu'on prendrait plus tard pour une cle posee.
function chiffrer (clair) {
  const texte = String(clair == null ? '' : clair)
  if (!texte) throw new Error('rien a chiffrer')
  const iv = crypto.randomBytes(TAILLE_IV)
  const c = crypto.createCipheriv(ALGO, cle(), iv)
  const chiffre = Buffer.concat([c.update(texte, 'utf8'), c.final()])
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'),
          chiffre.toString('base64')].join(':')
}

// Leve sur tout ce qui n'est pas exactement ce qu'on a ecrit : mauvaise version,
// forme cassee, tag qui ne correspond pas, cle differente. C'est voulu — un
// dechiffrement approximatif enverrait des octets faux a Stripe.
function dechiffrer (paquet) {
  const s = String(paquet == null ? '' : paquet)
  const bouts = s.split(':')
  if (bouts.length !== 4) throw new Error('secret : forme invalide')
  const [version, ivB64, tagB64, chiffreB64] = bouts
  if (version !== VERSION) throw new Error(`secret : version ${version} inconnue`)
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  if (iv.length !== TAILLE_IV || tag.length !== 16) throw new Error('secret : forme invalide')
  const d = crypto.createDecipheriv(ALGO, cle(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(Buffer.from(chiffreB64, 'base64')), d.final()]).toString('utf8')
}

// Est-ce deja du chiffre ? Sert a ne jamais rechiffrer par accident, et a
// reperer une ligne ecrite en clair par erreur.
function estChiffre (v) {
  return typeof v === 'string' && /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(v)
}

// ─── Ce qu'on a le droit de MONTRER d'une cle ────────────────────────────────
// Jamais la cle. Le mode et les 4 derniers caracteres suffisent a ce qu'un hote
// reconnaisse la sienne, et ne suffisent a personne pour s'en servir.
// ⚠ `sk_test_…` et `rk_test_…` : le mode se lit dans le PREFIXE, jamais ailleurs.
function empreinteCle (cleStripe) {
  const k = String(cleStripe || '').trim()
  const mode = /_live_/.test(k) ? 'live' : (/_test_/.test(k) ? 'test' : null)
  return { mode, last4: k.length >= 4 ? k.slice(-4) : null, restreinte: k.startsWith('rk_') }
}

// ⚠ NE JAMAIS JOURNALISER UNE CLE. Cette fonction existe pour que le message
// d'erreur d'un appel Stripe rate ne recopie pas la cle dans les journaux
// Vercel — ou elle resterait lisible bien apres.
function sansSecrets (message) {
  return String(message == null ? '' : message)
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '$1_***')
}

module.exports = {
  VERSION, ALGO, TAILLE_CLE, TAILLE_IV,
  chiffrer, dechiffrer, estChiffre, empreinteCle, sansSecrets
}
