// core/avis/questions-prestataire.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// ACTION `avis.questions_prestataire` — l'ecran de questions de la prestataire,
// dans sa PWA, juste apres « Menage fait » (spec §8.6, lot 5).
//
//   hsBus.ouvrir('avis.questions_prestataire',
//                { property_id, booking_id, departure_date },
//                { identite: { jeton } })
//
// ⚠ C'EST LA MEME FENETRE QUE CELLE DE L'HOTE, avec un autre transport. La
// prestataire n'a pas de session : ses appels partent PAR SON JETON vers les
// actions `pwa-*` de api/avis.js, qui le valident et appliquent les memes
// gardes que la session. Recopier la fenetre aurait fait deux ecrans qui
// divergent ; on traduit donc ses appels, rien d'autre.
//
// ⚠ ELLE SE TAIT QUAND IL N'Y A RIEN A FAIRE. Non autorisee par l'hote, sejour
// non evaluable (Booking, reservation directe), menage pas a elle : la fenetre
// se referme sans rien afficher. Une prestataire ne doit pas lire un refus
// apres chaque menage — elle n'a rien demande.

import { ouvrir as ouvrirFenetre } from './fenetre-evaluation.js'

// Les refus qui veulent dire « rien a faire ici », pas « quelque chose a casse ».
const SILENCIEUX = new Set(['prestataire_non_autorisee', 'non_evaluable', 'menage_pas_a_elle', 'menage_pas_fait', 'bien_ambigu'])

// Un appel par jeton : pas d'en-tete de session, le jeton et le menage dans la
// requete. Forme d'erreur identique a core/avis/appel.js.
function creerAppelJeton ({ jeton, menage, requete }) {
  return async function appelJeton (action, { methode = 'GET', corps = null } = {}) {
    const ident = { token: jeton, ...menage }
    let url = '/api/avis?action=' + action
    const options = { method: methode, headers: { 'Content-Type': 'application/json' } }
    if (methode === 'GET') {
      url += '&' + new URLSearchParams(ident).toString()
    } else {
      options.body = JSON.stringify({ ...(corps || {}), action, ...ident })
    }
    const reponse = await requete(url, options)
    let data = {}
    try { data = await reponse.json() } catch { data = {} }
    if (!reponse.ok) {
      const err = new Error(data.error || `Erreur serveur (${reponse.status})`)
      err.statut = reponse.status
      err.motif = data.motif || null
      err.corps = data
      throw err
    }
    return data
  }
}

/**
 * Traduit les appels de la fenetre de l'hote vers les actions par jeton.
 * Seules trois existent : lire, repondre, publier. Rediger et abandonner sont
 * des gestes de l'hote — la fenetre ne les propose pas a une prestataire, et
 * on refuse s'ils arrivaient quand meme.
 */
export function traduire (appelJeton, premiereLecture = null) {
  let lecture = premiereLecture
  return async function appel (chemin, options = {}) {
    if (/^avis\?action=evaluation(&|$)/.test(chemin)) {
      if (lecture) { const d = lecture; lecture = null; return d }
      return appelJeton('pwa-evaluation')
    }
    const action = (/action=([a-z-]+)/.exec(chemin) || [])[1]
    if (action === 'eval-reponses') return appelJeton('pwa-reponses', { methode: 'POST', corps: { reponses: options.corps && options.corps.reponses } })
    if (action === 'eval-publier') return appelJeton('pwa-publier', { methode: 'POST', corps: {} })
    const err = new Error('Action réservée à l’hôte')
    err.statut = 403
    throw err
  }
}

export async function ouvrir (ctx = {}) {
  const { conteneur, params = {}, identite = null, fermer = () => {} } = ctx
  const jeton = identite && identite.jeton
  if (!jeton) throw new Error('[avis] questions prestataire : jeton absent')
  const menage = {
    property_id: String(params.property_id || ''),
    booking_id: String(params.booking_id || ''),
    departure_date: String(params.departure_date || ''),
  }
  const requete = (ctx.deps && ctx.deps.fetch) || (typeof fetch !== 'undefined' ? fetch : null)
  const appelJeton = creerAppelJeton({ jeton, menage, requete })

  // ⚠ D'ABORD SAVOIR S'IL Y A QUELQUE CHOSE A FAIRE. La premiere lecture fait
  // aussi naitre l'evaluation (decision D2) ; elle est reutilisee par la
  // fenetre, pas refaite.
  let premiere
  try {
    premiere = await appelJeton('pwa-evaluation')
  } catch (err) {
    if (err && SILENCIEUX.has(err.motif)) { fermer(); return { charge: false, motif: err.motif } }
    throw err   // une vraie panne : le bus ferme et dit « indisponible »
  }
  if (!premiere || !Array.isArray(premiere.criteres) || !premiere.criteres.length) {
    // Rien a lui demander sur cette grille : on ne montre pas un formulaire vide.
    fermer()
    return { charge: false, motif: 'aucune_question' }
  }

  return ouvrirFenetre({
    ...ctx,
    // `booking_uid` n'est jamais envoye : le serveur trouve le sejour par le
    // menage. Vide, il ne designe rien — ni dans une URL, ni dans l'evenement
    // `avis.evaluation_publiee` (aucune app n'a de conversation a cette cle).
    params: { booking_uid: '' },
    deps: { ...(ctx.deps || {}), appel: traduire(appelJeton, premiere) },
  })
}
