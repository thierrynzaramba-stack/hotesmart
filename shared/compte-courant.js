// shared/compte-courant.js
// DOC : docs/kb/profils-et-droits.md (modif = MEME COMMIT)
//
// SOURCE UNIQUE de « sur quel compte je travaille ».
//
// ⚠ DEUX QUESTIONS A NE JAMAIS CONFONDRE :
//   moi()           -> QUI SUIS-JE            (identite de la personne connectee)
//   compteCourant() -> SUR QUEL COMPTE        (le user_id que portent les donnees)
//
// Aujourd'hui elles se confondent pour la quasi-totalite des comptes : sans
// invitation acceptee, `compteCourant() === moi()`. C'est la non-regression —
// un hote seul ne voit RIEN changer.
//
// L'audit ligne par ligne des lectures front est dans
// docs/kb/audit-user-id-front.md : chaque requete a recu une reponse a cette
// question, et c'est cette reponse qui decide du code.

import { supabase } from '/shared/supabase.js'
import { api } from '/shared/api-client.js'
import { logger } from '/shared/logger.js'

const CLE_MEMOIRE = 'hs_compte_courant'

let contexte = {
  moi: null,
  compte: null,
  comptes: [],
  permissions: null,
  charge: false
}

// ─── Chargement ──────────────────────────────────────────────────────────────

/**
 * Resout les comptes accessibles et le compte actif. Appele une fois par
 * requireAuth ; idempotent.
 *
 * ⚠ TOLERANT A LA PANNE. Si la liste des comptes ne peut pas etre chargee, on
 * retombe sur le compte propre plutot que de bloquer : un incident reseau ne
 * doit pas empecher un hote seul d'utiliser son application.
 */
export async function chargerContexte (userId) {
  if (contexte.charge && contexte.moi === userId) return contexte

  contexte = { moi: userId, compte: userId, comptes: [], permissions: null, charge: true }

  try {
    const { comptes } = await api.membres.mesComptes()
    contexte.comptes = Array.isArray(comptes) ? comptes : []
  } catch (e) {
    logger.error('compte', 'liste des comptes indisponible : ' + (e?.message || e))
    contexte.comptes = [{ user_id: userId, nom: 'Mon compte', titulaire: true }]
  }

  // ⚠ REVALIDATION DU COMPTE MEMORISE. Une invitation revoquee, un profil
  // desactive, un changement d'utilisateur sur le meme navigateur : le compte
  // garde en memoire peut ne plus etre accessible. On retombe alors
  // SILENCIEUSEMENT sur le compte propre — sinon toutes les requetes echouent
  // sans que la personne comprenne pourquoi.
  const memorise = lireMemoire()
  const accessible = memorise && contexte.comptes.some(c => String(c.user_id) === String(memorise))
  if (memorise && !accessible) {
    logger.info('compte', 'compte memorise plus accessible : retour au compte propre')
    oublierMemoire()
  }
  contexte.compte = accessible ? memorise : userId

  await chargerPermissions()
  return contexte
}

// Les droits de l'appelant SUR LE COMPTE COURANT.
// Sur son propre compte, il est titulaire : tous les droits, sans lecture.
async function chargerPermissions () {
  if (String(contexte.compte) === String(contexte.moi)) {
    contexte.permissions = null   // null = titulaire, tous droits
    return
  }
  try {
    const { data: profil } = await supabase
      .from('profiles').select('id')
      .eq('account_user_id', contexte.compte).eq('member_user_id', contexte.moi).maybeSingle()
    if (!profil) { contexte.permissions = AUCUN_DROIT; return }
    const { data: perms } = await supabase
      .from('profile_permissions').select('*').eq('profile_id', profil.id).maybeSingle()
    // ⚠ Pas de permissions lisibles -> AUCUN droit, jamais « tous ». Une panne
    // ne doit pas ouvrir l'interface.
    contexte.permissions = perms || AUCUN_DROIT
  } catch (e) {
    logger.error('compte', 'droits illisibles : ' + (e?.message || e))
    contexte.permissions = AUCUN_DROIT
  }
}

const AUCUN_DROIT = {
  property_scope: 'selected', property_ids: [], property_refs: [],
  reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none',
  avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none',
  self_availability: 'none', self_view_reviews: false
}

// ─── Lecture ─────────────────────────────────────────────────────────────────

/** Le user_id que doivent porter les donnees. */
export function compteCourant () { return contexte.compte || contexte.moi }

/** L'identite de la personne connectee — distincte du compte. */
export function moi () { return contexte.moi }

/** true si l'appelant est titulaire du compte courant. */
export function estTitulaire () {
  return String(contexte.compte) === String(contexte.moi)
}

/** Les comptes accessibles. Un seul element = pas de selecteur a afficher. */
export function comptes () { return contexte.comptes }

/**
 * ⚠ LE SELECTEUR NE S'AFFICHE QUE S'IL Y A UN CHOIX. Un hote sans invitation
 * ne doit rien voir changer : c'est la non-regression absolue demandee.
 */
export function doitAfficherSelecteur () { return contexte.comptes.length > 1 }

export function permissions () { return contexte.permissions }

const NIVEAU = { none: 0, read: 1, write: 2 }

/** Droit de LECTURE sur un domaine. Titulaire : toujours vrai. */
export function peutLire (domaine) {
  if (estTitulaire()) return true
  return (NIVEAU[contexte.permissions?.[domaine]] || 0) >= NIVEAU.read
}

/** Droit d'ECRITURE sur un domaine. Titulaire : toujours vrai. */
export function peutEcrire (domaine) {
  if (estTitulaire()) return true
  // facturation et equipe ne se deleguent pas : le serveur le refuse de toute
  // facon, l'interface ne doit pas proposer un bouton qui echouerait.
  if (domaine === 'facturation' || domaine === 'equipe') return false
  return (NIVEAU[contexte.permissions?.[domaine]] || 0) >= NIVEAU.write
}

/**
 * Les biens du perimetre, ou null quand il n'y a aucune restriction.
 * null signifie « tous », jamais « aucun » — l'appelant doit traiter les deux.
 */
export function biensAutorises () {
  if (estTitulaire()) return null
  const p = contexte.permissions
  if (!p || p.property_scope !== 'selected') return p ? null : []
  return [...(p.property_ids || []).map(String), ...(p.property_refs || []).map(String)]
}

/** Un bien donne est-il dans le perimetre ? Accepte UUID ou reference canal. */
export function bienAutorise (idOuRef) {
  const autorises = biensAutorises()
  if (autorises === null) return true
  return autorises.includes(String(idOuRef))
}

// ─── Bascule ─────────────────────────────────────────────────────────────────

/**
 * Change de compte et recharge la page.
 *
 * ⚠ RECHARGEMENT VOLONTAIRE. Chaque page a deja lu ses donnees avec l'ancien
 * compte ; les rafraichir une par une laisserait forcement un fragment derriere.
 * Recharger est la seule facon simple de garantir qu'aucune donnee de l'ancien
 * compte ne reste a l'ecran.
 */
export async function basculerVers (userId) {
  const cible = String(userId)
  if (!contexte.comptes.some(c => String(c.user_id) === cible)) {
    logger.error('compte', 'bascule refusee : compte non accessible')
    return false
  }
  if (cible === String(contexte.moi)) oublierMemoire()
  else ecrireMemoire(cible)
  window.location.reload()
  return true
}

// ─── Memoire ─────────────────────────────────────────────────────────────────
// localStorage : le choix survit aux onglets et aux rechargements. Toujours
// revalide au chargement (voir chargerContexte).

function lireMemoire () {
  try { return localStorage.getItem(CLE_MEMOIRE) } catch { return null }
}
function ecrireMemoire (v) {
  try { localStorage.setItem(CLE_MEMOIRE, v) } catch { /* navigation privee */ }
}
function oublierMemoire () {
  try { localStorage.removeItem(CLE_MEMOIRE) } catch { /* idem */ }
}

/** Appele a la deconnexion : le compte choisi ne doit pas survivre a l'utilisateur. */
export function reinitialiser () {
  oublierMemoire()
  contexte = { moi: null, compte: null, comptes: [], permissions: null, charge: false }
}
