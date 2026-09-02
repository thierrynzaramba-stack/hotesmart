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

  // ⚠ DISTINGUER « liste indisponible » de « acces revoque ».
  // Sur panne, on ne connait PAS les comptes accessibles : effacer le choix
  // memorise ferait perdre son compte a quelqu'un pour un 503 de trente
  // secondes. On garde la memoire intacte et on retombe sur le compte propre
  // pour cette session — le prochain chargement reussi restaurera le choix.
  let listeFiable = true
  try {
    const { comptes } = await api.membres.mesComptes()
    contexte.comptes = Array.isArray(comptes) ? comptes : []
  } catch (e) {
    logger.error('compte', 'liste des comptes indisponible : ' + (e?.message || e))
    contexte.comptes = [{ user_id: userId, nom: 'Mon compte', titulaire: true }]
    listeFiable = false
  }

  // ⚠ SUR PANNE, LE SELECTEUR DOIT SURVIVRE. Reduit au seul compte propre, il
  // disparaissait (`doitAfficherSelecteur` exige plus d'un compte) : le membre
  // etait bascule sur son compte vide SANS AUCUN MOYEN DE REVENIR. On reinjecte
  // donc l'entree memorisee, marquee indisponible, pour qu'il voie ce qui se
  // passe et puisse reessayer.
  const memoriseAvant = lireMemoire()
  if (!listeFiable && memoriseAvant && memoriseAvant !== String(userId)) {
    contexte.comptes.push({
      user_id: memoriseAvant, nom: 'Compte partagé (indisponible)',
      titulaire: false, indisponible: true
    })
  }

  // ⚠ REVALIDATION DU COMPTE MEMORISE. Une invitation revoquee, un profil
  // desactive, un changement d'utilisateur sur le meme navigateur : le compte
  // garde en memoire peut ne plus etre accessible. On retombe alors
  // SILENCIEUSEMENT sur le compte propre — sinon toutes les requetes echouent
  // sans que la personne comprenne pourquoi.
  const memorise = lireMemoire()
  const accessible = memorise && contexte.comptes.some(c => String(c.user_id) === String(memorise))
  if (memorise && !accessible && listeFiable) {
    // Liste FIABLE et compte absent : l'acces a reellement ete revoque.
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

/**
 * true si l'appelant est titulaire du compte courant.
 *
 * ⚠ FAUX TANT QUE LE CONTEXTE N'EST PAS CHARGE. `String(null) === String(null)`
 * valait vrai, donc `peutLire` ouvrait TOUS les domaines : une sidebar rendue
 * avant `chargerContexte` affichait a un membre la section Configuration et
 * Reglages. Le serveur reste la vraie garde, mais le masquage — objet meme de ce
 * lot — etait ouvert par defaut.
 */
export function estTitulaire () {
  if (!contexte.charge || !contexte.moi) return false
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

/**
 * En-tete a poser sur un `fetch` BRUT (hors shared/api-client.js, qui le fait
 * seul).
 *
 * ⚠ Plusieurs pages appellent l'API en `fetch` direct. Sans cet en-tete, le
 * serveur travaille sur le compte de l'appelant alors que le reste de la page
 * lit le compte courant : l'ecran melange deux comptes, et la delegation ne
 * fonctionne pas de bout en bout. Rien n'est emis quand on est sur son propre
 * compte.
 */
export function enteteCompte () {
  const c = compteCourant()
  return (c && contexte.moi && String(c) !== String(contexte.moi)) ? { 'X-Compte': c } : {}
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
  if (cible === String(contexte.moi)) {
    oublierMemoire()
  } else if (!ecrireMemoire(cible)) {
    // ⚠ localStorage indisponible (navigation privee, quota) : recharger
    // ramenerait au compte precedent et le selecteur reviendrait en arriere,
    // sans un mot. On le dit.
    logger.error('compte', 'choix de compte non memorisable')
    alert('Impossible de mémoriser le compte : votre navigateur bloque le stockage local.')
    return false
  }
  window.location.reload()
  return true
}

// ─── Garde-fou des pages NON DELEGABLES ──────────────────────────────────────
//
// ⚠ LE CONTRESENS QUE CE GARDE-FOU FERME. Masquer une entree de menu ne ferme
// pas la page : /settings, /connexions, /abonnement s'ouvraient par URL directe
// pendant qu'on travaillait sur un compte partage, et affichaient les donnees de
// L'APPELANT sans le dire. On lisait « vous agissez sur un compte partagé » dans
// la barre, et l'equipe ou les cles PMS de son propre compte dans la page.
//
// Ce n'est pas une fuite — chacun voit les siennes — mais c'est pire a l'usage :
// on croit modifier un compte et on en modifie un autre.
//
// ⚠ GARDE-FOU UNIQUE ET PARTAGE, jamais recopie page par page. Une copie
// diverge : c'est exactement ainsi qu'une page finit par etre oubliee.
//
// Charge le contexte lui-meme si besoin : plusieurs de ces pages n'appellent pas
// requireAuth, donc rien ne l'aurait fait pour elles.
export async function exigerCompteProprePage (options = {}) {
  const { nomPage = 'Cette page' } = options
  try {
    if (!contexte.charge) {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return true   // pas de session : la page gere sa redirection
      await chargerContexte(session.user.id)
    }
  } catch (e) {
    // ⚠ On n'echoue pas FERME ici : bloquer une page sur un incident reseau
    // empecherait un hote seul d'acceder a ses propres reglages. Le serveur
    // reste la garde reelle — cette barriere-ci evite un contresens, pas une
    // fuite.
    logger.error('compte', 'garde-fou de page : contexte indisponible, on laisse passer')
    return true
  }

  if (estTitulaire()) return true

  const actif = contexte.comptes.find(c => String(c.user_id) === String(contexte.compte))
  const sien  = contexte.comptes.find(c => String(c.user_id) === String(contexte.moi))
  afficherRefusDePage(nomPage, actif?.nom || 'un compte partagé', sien?.nom || 'votre compte')

  // ⚠ ARRET DEFINITIF DU SCRIPT, volontairement. Le contenu de la page vient
  // d'etre remplace : laisser la suite s'executer produirait une cascade de
  // `null` sur des elements disparus, et des erreurs de console qui masqueraient
  // le vrai message.
  //
  // Une promesse jamais resolue plutot qu'un `throw` : elle arrete le module
  // proprement, sans exception non capturee, et sans obliger 14 pages a
  // reindenter tout leur script dans un `if`.
  await new Promise(() => {})
}

function afficherRefusDePage (nomPage, nomActif, nomSien) {
  const html = `
    <div style="max-width:460px;margin:80px auto;padding:28px;text-align:center;
                font-family:system-ui,-apple-system,sans-serif;line-height:1.6">
      <div style="font-size:34px;margin-bottom:14px">⚠️</div>
      <h1 style="font-size:18px;font-weight:500;margin:0 0 10px">
        ${echapper(nomPage)} concerne votre propre compte</h1>
      <p style="font-size:14px;color:#6b7280;margin:0 0 20px">
        Vous travaillez actuellement sur <strong>${echapper(nomActif)}</strong>.
        Rebasculez sur <strong>${echapper(nomSien)}</strong> pour y accéder.</p>
      <button id="hs-rebasculer" style="background:#C97B5C;color:#fff;border:0;border-radius:8px;
              padding:11px 20px;font-size:14px;cursor:pointer;font-family:inherit">
        Revenir sur mon compte</button>
      <div style="margin-top:14px">
        <a href="/" style="font-size:13px;color:#6b7280">Retour à l’accueil</a>
      </div>
    </div>`
  document.body.innerHTML = html
  const b = document.getElementById('hs-rebasculer')
  if (b) b.onclick = () => basculerVers(contexte.moi)
}

function echapper (v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ─── Memoire ─────────────────────────────────────────────────────────────────
// localStorage : le choix survit aux onglets et aux rechargements. Toujours
// revalide au chargement (voir chargerContexte).

function lireMemoire () {
  try { return localStorage.getItem(CLE_MEMOIRE) } catch { return null }
}
function ecrireMemoire (v) {
  try { localStorage.setItem(CLE_MEMOIRE, v); return true } catch { return false }
}
function oublierMemoire () {
  try { localStorage.removeItem(CLE_MEMOIRE) } catch { /* idem */ }
}

/** Appele a la deconnexion : le compte choisi ne doit pas survivre a l'utilisateur. */
export function reinitialiser () {
  oublierMemoire()
  contexte = { moi: null, compte: null, comptes: [], permissions: null, charge: false }
}
