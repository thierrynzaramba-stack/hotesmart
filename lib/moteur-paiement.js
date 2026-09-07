// lib/moteur-paiement.js
// DOC : docs/kb/moteur-reservation.md §11 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §2 (ordre) et §5.2
//
// LA LOGIQUE D'ARGENT, ISOLEE ET PURE.
// Ni Supabase, ni Stripe, ni reseau. Tout ce qui decide d'un montant, d'une cle
// d'idempotence ou d'une transition de statut vit ici — ou ca se teste sans rien
// brancher, et ou ca ne peut rien encaisser tout seul.
//
// L'ORDRE QUI PROTEGE L'ARGENT (§2, grave) :
//   1. verrou + verification capacite/stop-sell — RIEN N'EST PROMIS AVANT
//   2. tenue des nuits, puis Checkout Session
//   3. creation CRS                              <- etape 3
//   4. echec de creation apres encaissement -> remboursement + alarme
//
// « Rien n'est promis avant » veut dire : on refuse AVANT d'encaisser, jamais
// apres. Rendre son argent a un voyageur trente secondes apres l'avoir pris ne
// repare pas la reservation qu'il croyait avoir.

const crypto = require('crypto')

// ─── Statuts d'une tentative ─────────────────────────────────────────────────
// `paid` est l'etat DANGEREUX : de l'argent est encaisse et aucune reservation
// n'existe encore. Il doit etre le plus court possible, et jamais silencieux.
const ETAT = {
  EN_ATTENTE: 'pending',
  PAYE:       'paid',
  RESERVE:    'booked',
  REFUSE:     'failed',
  EXPIRE:     'expired',
  REMBOURSE:  'refunded'
}
const ETATS = Object.values(ETAT)

// Transitions autorisees. Tout le reste est refuse — Stripe REJOUE ses webhooks,
// et pas toujours dans l'ordre. Recevoir `completed` apres avoir cree la
// reservation est normal ; repasser `booked` a `paid` ferait recreer la
// reservation a l'etape 3.
const TRANSITIONS = {
  pending:  [ETAT.PAYE, ETAT.REFUSE, ETAT.EXPIRE],
  paid:     [ETAT.RESERVE, ETAT.REMBOURSE],
  booked:   [ETAT.REMBOURSE],
  failed:   [ETAT.EN_ATTENTE],   // le voyageur retente avec une autre carte
  expired:  [ETAT.EN_ATTENTE],   // il revient plus tard sur les memes dates
  refunded: []
}

function transitionPermise (avant, apres) {
  if (!ETATS.includes(avant) || !ETATS.includes(apres)) return false
  if (avant === apres) return true          // rejeu du meme evenement : sans effet
  return (TRANSITIONS[avant] || []).includes(apres)
}

// ─── Le montant ──────────────────────────────────────────────────────────────
// ⚠ EN CENTIMES, ENTIER, TOUJOURS. C'est l'unite de Stripe, et la seule qui ne
// derive pas : additionner des euros en flottant finit par rendre
// 269.99999999999994 pour trois nuits a 90.
//
// La source est le DEVIS SERVEUR (lib/moteur-reservation.validerSejour), jamais
// un montant venu du navigateur.
function montantEnCentimes (devis) {
  if (!devis || devis.ok !== true) return null
  const total = Number(devis.total)
  if (!Number.isFinite(total) || total <= 0) return null
  const cents = Math.round(total * 100)
  return cents > 0 ? cents : null
}

// Devises « zero decimale » (JPY, KRW…) : Stripe y attend l'unite entiere, pas
// des centimes. Aucun bien du parc n'est concerne (tout est en EUR), mais
// l'erreur serait un facteur 100 sur le debit — elle ne se rattrape pas.
const SANS_DECIMALE = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
                       'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']

function montantStripe (devis, devise) {
  const cents = montantEnCentimes(devis)
  if (cents == null) return null
  if (SANS_DECIMALE.includes(String(devise || '').toUpperCase())) {
    return Math.round(cents / 100)
  }
  return cents
}

// ─── L'identite d'une VENTE ──────────────────────────────────────────────────
// Elle identifie UNE VENTE, pas un clic. Deux soumissions du meme sejour, par le
// meme voyageur, retombent sur la meme cle — donc sur la meme ligne, donc sur la
// meme Checkout Session, donc un seul debit.
//
// ⚠ LE MONTANT N'EN FAIT PAS PARTIE. Constat de review du 7 septembre :
// il y etait, et il DESARMAIT la protection qu'il croyait renforcer. Une fois
// les nuits tenues, le calendrier les compte prises, `validerSejour` echoue,
// `montantStripe` rend `null` — et la cle calculee au retour du voyageur
// differait de celle de sa vente. La tentative deja PAYEE devenait
// introuvable, et il lisait « ces nuits ne sont plus disponibles » a propos de
// nuits qu'il venait de payer.
//
// Un changement de prix se traite ou il doit l'etre : sur la ligne, en comparant
// le montant stocke au montant recalcule — pas en fabriquant une seconde vente.
//
// L'e-mail est HACHE avec le reste, jamais laisse en clair : cette cle finit
// dans nos journaux et chez Stripe.
function cleIdempotence ({ lienId, arrival, departure, personnes, email }) {
  const brut = [
    String(lienId || ''), String(arrival || ''), String(departure || ''),
    String(personnes || ''), String(email || '').trim().toLowerCase()
  ].join('|')
  return 'bk_' + crypto.createHash('sha256').update(brut).digest('hex').slice(0, 40)
}

// ─── La cle d'idempotence envoyee A STRIPE ───────────────────────────────────
// DISTINCTE de celle de la vente, et pour une raison precise : Stripe REFUSE
// (400) une cle rejouee avec des parametres differents pendant 24 h. Le montant
// peut changer d'une tentative a l'autre, et `expires_at` aussi — reutiliser la
// cle de vente bloquait alors le voyageur sur ces dates pendant une journee
// entiere. Constat de review.
//
// Elle porte donc ce qui DOIT rester stable pour un rejeu utile : la tentative
// et le montant. Deux appels pour la meme tentative au meme prix rejouent la
// meme Session ; un prix different en cree une nouvelle, ce qui est correct.
// ⚠ ELLE PORTE AUSSI LA TENUE. `expires_at` en derive : une tenue renouvelee
// change ce parametre, et Stripe refuse (400) une cle rejouee avec des
// parametres differents. Sans la tenue dans la cle, tout renouvellement
// bloquait le voyageur pendant 24 h.
function cleStripe (tentativeId, montant, holdIso) {
  const t = Date.parse(holdIso)
  return `bkcs_${tentativeId}_${montant}_${Number.isFinite(t) ? t : 0}`
}
// ─── La fenetre de tenue des nuits ───────────────────────────────────────────
// ⚠ ELLE DOIT SURVIVRE A LA CHECKOUT SESSION.
// Stripe n'autorise pas une Session a expirer avant 30 minutes. Une tenue plus
// courte que la Session laisserait un voyageur payer, sur la page Stripe encore
// ouverte, des nuits que nous avons deja reliberees et peut-etre revendues.
// On tient donc 35 minutes : la duree de la Session, plus une marge pour que le
// webhook d'expiration nous parvienne.
// Stripe n'autorise pas une Session a expirer avant 30 minutes.
const SESSION_MINUTES = 30
// La Session expire AVANT la tenue : jamais l'inverse, sans quoi un voyageur
// paierait sur une page encore ouverte des nuits deja reliberees.
const MARGE_MINUTES = 10
// ⚠ LA TENUE DOIT DEPASSER SESSION + MARGE, ET AVEC DU JEU.
// Elle valait 35 = 30 + 5, et c'etait un BLOQUEUR : la cible se calcule depuis
// la pose de la tenue, le minimum depuis l'instant de l'appel, et quelques
// centaines de millisecondes de requetes suffisaient a faire passer la cible
// SOUS le minimum. Mesure : `null` des 1,2 seconde apres la pose — aucune
// Session n'aurait jamais pu etre creee. Trouve en review.
// 45 = 30 + 10 + 5 minutes de jeu.
const TENUE_MINUTES = 45
const TENUE_MS = TENUE_MINUTES * 60 * 1000

function tenueExpireA (maintenant) {
  return new Date((maintenant || Date.now()) + TENUE_MS).toISOString()
}

function tenueExpiree (tentative, maintenant) {
  if (!tentative || !tentative.hold_expires_at) return true
  return new Date(tentative.hold_expires_at).getTime() <= (maintenant || Date.now())
}

// Stripe attend un horodatage UNIX en secondes.
function sessionExpireA (maintenant) {
  return Math.floor(((maintenant || Date.now()) + SESSION_MINUTES * 60 * 1000) / 1000)
}

// ⚠ L'EXPIRATION DE LA SESSION SE DERIVE DE LA TENUE, pas de l'horloge.
// Sinon elle change a chaque appel, la cle d'idempotence Stripe est rejouee avec
// des parametres differents, et Stripe repond 400 pendant 24 h.
//
// Rend `null` quand la tenue est trop entamee pour porter une Session de 30
// minutes. L'appelant ne doit alors PAS refuser le voyageur : il RENOUVELLE la
// tenue (`tenueExpireA()`) et rappelle. Refuser bloquerait les dates pendant
// toute la duree restante — le defaut trouve en review.
function sessionExpireDepuisTenue (holdIso) {
  const fin = new Date(holdIso).getTime()
  if (!Number.isFinite(fin)) return null
  const cible = Math.floor((fin - MARGE_MINUTES * 60 * 1000) / 1000)
  const minimum = Math.floor((Date.now() + SESSION_MINUTES * 60 * 1000) / 1000)
  return cible >= minimum ? cible : null
}

// ─── Les coordonnees du voyageur ─────────────────────────────────────────────
// Validees ICI, cote serveur. Le navigateur valide pour le confort ; c'est cette
// fonction qui fait foi. Un champ vide arriverait sinon jusqu'a la reservation
// provider, ou il serait bien plus couteux a rattraper.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function nettoyerVoyageur (brut) {
  const texte = (v, max) => String(v == null ? '' : v).trim().slice(0, max)
  const v = {
    prenom: texte(brut && brut.prenom, 80),
    nom:    texte(brut && brut.nom, 80),
    // ⚠ 254, la longueur maximale d'une adresse selon la RFC — pas une valeur
    // ronde choisie au hasard. Trouve en ecrivant les tests : couper a 160
    // transformait une adresse longue mais VALIDE en adresse invalide, et le
    // voyageur lisait « e-mail invalide » sur une adresse qui l'est.
    email:  texte(brut && brut.email, 254).toLowerCase(),
    tel:    texte(brut && brut.tel, 40)
  }
  if (!v.prenom) return { ok: false, raison: 'prenom_manquant' }
  if (!v.nom) return { ok: false, raison: 'nom_manquant' }
  if (!EMAIL.test(v.email)) return { ok: false, raison: 'email_invalide' }
  // Un numero utilisable : au moins 6 chiffres, quel que soit le formatage.
  if ((v.tel.match(/\d/g) || []).length < 6) return { ok: false, raison: 'telephone_invalide' }
  return { ok: true, voyageur: v }
}

// ─── Langue ──────────────────────────────────────────────────────────────────
// Figee sur la tentative : l'e-mail de confirmation (etape 3) doit partir dans
// la langue ou le voyageur a reserve, pas dans celle du serveur.
const LANGUES = ['fr', 'es', 'en']
const langueValide = l => (LANGUES.includes(String(l || '').toLowerCase())
  ? String(l).toLowerCase() : 'fr')

// ─── LA GARDE DE L'ETAPE 2 ───────────────────────────────────────────────────
// Tant que le chemin de CREATION (etape 3) n'existe pas, un paiement reussi
// laisserait de l'argent encaisse sans reservation — ce que la regle 4 du §2
// interdit.
//
// Fermee PAR DEFAUT, ouverte par `BOOKING_ENGINE_PAYMENT` a 'true'. Meme forme
// que SENDVIABEDS24_ENABLED : l'ABSENCE de la variable est le comportement SUR.
function paiementAutorise (env) {
  return String((env || process.env).BOOKING_ENGINE_PAYMENT || '').trim() === 'true'
}

module.exports = {
  ETAT, ETATS, TRANSITIONS, transitionPermise,
  montantEnCentimes, montantStripe, SANS_DECIMALE,
  cleIdempotence,
  cleStripe,
  SESSION_MINUTES, MARGE_MINUTES, TENUE_MINUTES, TENUE_MS, tenueExpireA, tenueExpiree,
  sessionExpireA, sessionExpireDepuisTenue,
  nettoyerVoyageur, langueValide, paiementAutorise
}
