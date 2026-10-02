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

// Le client de session partage, charge a la demande (un import statique
// casserait les tests sous Node, ou /shared n'est pas un chemin).
async function clientParDefaut () {
  const m = await import('/shared/supabase.js')
  return m.supabase
}

// Le compte courant (membre delegue), meme repli que shared/api-client.js :
// une page qui ne publie pas `window.enteteCompte` envoie quand meme X-Compte.
async function compteCourantParDefaut () {
  const m = await import('/shared/compte-courant.js')
  return m.compteCourant()
}

/**
 * Fabrique un appelant. `deps` sert aux tests. En production, la session et le
 * compte viennent de la page si elle les publie (window._supabase,
 * window.enteteCompte), sinon des modules partages /shared/supabase.js et
 * /shared/compte-courant.js.
 */
export function creerAppel (deps = {}) {
  const fenetreGlobale = deps.global || (typeof window !== 'undefined' ? window : {})
  const requete = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null)

  return async function appel (chemin, { methode = 'GET', corps = null } = {}) {
    if (!requete) throw new Error('[avis] aucun moyen d appeler le serveur')

    // ⚠ LE JETON SE RELIT A CHAQUE APPEL. Une fenetre d'evaluation peut rester
    // ouverte longtemps ; un jeton capture a l'ouverture aurait expire au
    // moment de publier — exactement l'appel qu'on ne veut pas voir echouer.
    //
    // ⚠ ET IL NE DEPEND PAS DE LA PAGE. Recette du 2 octobre 2026 : la fiche
    // prestataire et les deux calendriers ne publient pas `window._supabase` —
    // chaque appel partait SANS jeton, le serveur repondait « Non autorise », et
    // la case « Elle remplit les questions » ne s'enregistrait jamais. Le client
    // de session est un module partage : on le prend la, la page n'a rien a faire.
    let jeton = null
    let moi = null
    try {
      const client = fenetreGlobale._supabase || (deps.supabase !== undefined ? deps.supabase : await clientParDefaut())
      const { data } = await client.auth.getSession()
      if (data && data.session) { jeton = data.session.access_token; moi = data.session.user && data.session.user.id }
    } catch { /* pas de session : le serveur repondra 401, et c'est sa reponse */ }

    const entetes = { 'Content-Type': 'application/json' }
    if (jeton) entetes.Authorization = `Bearer ${jeton}`
    // ⚠ L'EN-TETE DE COMPTE DELEGUE. Un membre travaille sur le compte de
    // l'hote : sans elle, le serveur resoudrait le compte de l'appelant.
    if (typeof fenetreGlobale.enteteCompte === 'function') Object.assign(entetes, fenetreGlobale.enteteCompte() || {})
    else {
      // Sans en-tete publie par la page : le compte courant, envoye seulement
      // s'il differe de l'appelant (un hote seul n'emet jamais X-Compte).
      let compte = null
      try { compte = deps.compteCourant !== undefined ? deps.compteCourant : await compteCourantParDefaut() } catch { compte = null }
      if (compte && moi && compte !== moi) entetes['X-Compte'] = compte
    }

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
