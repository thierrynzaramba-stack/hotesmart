// core/avis/appel.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// L'APPEL AUTHENTIFIE DU DOMAINE AVIS, EN UN SEUL ENDROIT.
//
// Les modules du coeur (fenetre d'evaluation, statut, reglages) parlent tous au
// meme endpoint. Le jeton de session et l'en-tete de compte delegue sont la
// meme mecanique partout : la dupliquer dans chaque module, c'est se garantir
// qu'un jour l'un des trois oubliera l'en-tete de compte, et qu'un membre
// delegue verra les donnees de son propre compte vide au lieu de celles du
// compte sur lequel il travaille.
//
// ⚠ LES DEPENDANCES SONT INJECTABLES. Sans cela, ces modules ne se testent
// qu'avec un navigateur, un serveur et une session — autant dire jamais.

/**
 * Fabrique un appelant. `deps` sert aux tests ; en production tout vient de la
 * page (window._supabase, window.enteteCompte, fetch).
 */
export function creerAppel (deps = {}) {
  const fenetreGlobale = deps.global || (typeof window !== 'undefined' ? window : {})
  const requete = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null)

  return async function appel (chemin, { methode = 'GET', corps = null } = {}) {
    if (!requete) throw new Error('[avis] aucun moyen d appeler le serveur')

    // ⚠ LE JETON SE RELIT A CHAQUE APPEL. Une fenetre d'evaluation peut rester
    // ouverte longtemps ; un jeton capture a l'ouverture aurait expire au
    // moment de publier — exactement l'appel qu'on ne veut pas voir echouer.
    let jeton = null
    try {
      const { data } = await fenetreGlobale._supabase.auth.getSession()
      if (data && data.session) jeton = data.session.access_token
    } catch { /* pas de session : le serveur repondra 401, et c'est sa reponse */ }

    const entetes = { 'Content-Type': 'application/json' }
    if (jeton) entetes.Authorization = `Bearer ${jeton}`
    // ⚠ L'EN-TETE DE COMPTE DELEGUE. Un membre travaille sur le compte de
    // l'hote : sans elle, le serveur resoudrait le compte de l'appelant.
    if (typeof fenetreGlobale.enteteCompte === 'function') Object.assign(entetes, fenetreGlobale.enteteCompte() || {})

    const options = { method: methode, headers: entetes }
    if (corps) options.body = JSON.stringify(corps)

    const reponse = await requete('/api/' + chemin, options)
    let data = {}
    try { data = await reponse.json() } catch { data = {} }

    // ⚠ UN ECHEC PORTE SON STATUT ET SON MOTIF. L'appelant doit pouvoir
    // distinguer « ce bien n'est pas dans votre perimetre » (403) d'une panne,
    // et lire le `motif` nomme que l'endpoint rend sur un refus de publication.
    if (!reponse.ok) {
      const err = new Error(data.error || `Erreur serveur (${reponse.status})`)
      err.statut = reponse.status
      err.motif = data.motif || null
      err.detail = data.detail || null
      err.corps = data
      throw err
    }
    return data
  }
}

export const appel = creerAppel()
