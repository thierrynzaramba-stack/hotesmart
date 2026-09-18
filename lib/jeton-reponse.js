// lib/jeton-reponse.js
// DOC : docs/kb/guestflow.md (modif = MEME COMMIT)
// Chantier « inbound e-mail » — etape 3.
//
// L'ADRESSE DE REPONSE D'UNE RESERVATION.
//
// Le voyageur repond a `<jeton>@reply.hotesmart.fr`, et ce jeton doit dire DE
// QUELLE RESERVATION il s'agit — sans que personne puisse en fabriquer un.
//
// ⚠ PAS DE PLUS-ADRESSAGE. `reply+<booking>@` etait tentant : le `+` est
// reecrit ou refuse par une partie des clients mail, et surtout un identifiant
// nu se DEVINE. Quiconque connait un booking_id ecrirait dans le fil d'autrui.
// Le sous-domaine inbound accepte n'importe quelle adresse locale (wildcard,
// verifie chez Brevo) : on s'en sert pour porter identifiant ET signature.
//
// ⚠ AUCUNE TABLE, ET C'EST DELIBERE. Un jeton aleatoire stocke aurait demande
// une migration — donc un collage manuel dans Supabase, donc un chantier
// suspendu a un geste humain. La signature HMAC porte la meme garantie sans
// rien persister : on ne peut pas la forger sans le secret, et on la verifie
// sans rien lire.
//
// Contrepartie assumee : un jeton ne se REVOQUE pas. Sans importance ici — la
// validite reelle se decide a la lecture de la reservation (annulee, terminee,
// bien disparu), pas a la lecture du jeton.

const { createHmac, timingSafeEqual } = require('crypto')

const DOMAINE = 'reply.hotesmart.fr'
// Longueur de la signature, en caracteres base36. 12 caracteres ~= 62 bits :
// hors de portee d'une recherche exhaustive, et l'adresse reste lisible.
const TAILLE_SIGNATURE = 12

function secret () {
  const s = process.env.REPLY_TOKEN_SECRET
  if (!s || s.length < 32) return null
  return s
}

// ⚠ MINUSCULES PARTOUT. La partie locale d'une adresse est theoriquement
// sensible a la casse ; en pratique, relais et clients la reecrivent sans
// prevenir. Une signature qui dependrait de la casse se briserait au premier
// intermediaire zele — et on rejetterait la reponse d'un vrai voyageur.
function signature (identifiant) {
  const cle = secret()
  if (!cle) return null
  return createHmac('sha256', cle)
    .update(`reponse:${identifiant}`)
    .digest('hex')
    .slice(0, TAILLE_SIGNATURE)
    .toLowerCase()
}

// Un UUID porte des tirets, qui separeraient mal de la signature : on les
// retire. Un identifiant Beds24 est deja numerique.
const compacter = id => String(id || '').replace(/-/g, '').toLowerCase()

/**
 * L'adresse a mettre en `reply-to` pour cette reservation.
 * Rend `null` si le secret manque — l'appelant retombe alors sur l'ancien
 * comportement plutot que d'envoyer une adresse qui ne repondra a personne.
 */
function adresseDeReponse (bookingId) {
  const id = compacter(bookingId)
  if (!id) return null
  const sig = signature(id)
  if (!sig) return null
  return `${id}-${sig}@${DOMAINE}`
}

/**
 * L'inverse : de quelle reservation vient cette adresse ?
 * Rend { ok:true, bookingCompact } ou { ok:false, raison }.
 *
 * ⚠ ON NE REND PAS LE booking_id D'ORIGINE, mais sa forme COMPACTE : les
 * tirets d'un UUID sont perdus a l'aller. L'appelant retrouve la reservation en
 * base par comparaison — c'est une lecture de plus, et c'est le prix a payer
 * pour ne rien persister. Il ne doit SURTOUT pas reconstruire un UUID en
 * replacant les tirets « au bon endroit » : tous les identifiants ne sont pas
 * des UUID (Beds24 est numerique), et deviner la forme d'un identifiant est le
 * genre de pari qui marche jusqu'au jour ou il ne marche plus.
 */
function bookingDepuisAdresse (adresse) {
  const brut = String(adresse || '').trim().toLowerCase()
  if (!brut) return { ok: false, raison: 'adresse_vide' }

  const [local, domaine] = brut.split('@')
  if (!domaine || domaine !== DOMAINE) return { ok: false, raison: 'domaine_inattendu' }

  const sep = local.lastIndexOf('-')
  if (sep <= 0) return { ok: false, raison: 'format_inattendu' }

  const identifiant = local.slice(0, sep)
  const fournie = local.slice(sep + 1)
  if (fournie.length !== TAILLE_SIGNATURE) return { ok: false, raison: 'signature_malformee' }

  const attendue = signature(identifiant)
  if (!attendue) return { ok: false, raison: 'secret_absent' }

  // ⚠ COMPARAISON A TEMPS CONSTANT. Un `===` sur une signature fuit, par sa
  // duree, le nombre de caracteres justes : de quoi la reconstruire octet par
  // octet. Le cout est nul ici, l'habitude vaut mieux que l'exception.
  const a = Buffer.from(fournie, 'utf8')
  const b = Buffer.from(attendue, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, raison: 'signature_invalide' }
  }
  return { ok: true, bookingCompact: identifiant }
}

/** L'adresse porte-t-elle notre domaine de reponse ? (sans rien valider d'autre) */
const estAdresseDeReponse = a =>
  String(a || '').trim().toLowerCase().endsWith('@' + DOMAINE)

module.exports = {
  DOMAINE, TAILLE_SIGNATURE,
  adresseDeReponse, bookingDepuisAdresse, estAdresseDeReponse,
  compacter, secretPresent: () => !!secret()
}
