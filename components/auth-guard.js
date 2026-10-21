import { supabase, getSession } from '/shared/supabase.js'
import { chargerContexte, reinitialiser } from '/shared/compte-courant.js'

const CACHE_KEY = 'hs_onboarding_completed'
const GF_CACHE_KEY = 'hs_guestflow_active'
const SESSION_USER_KEY = 'hs_auth_user_id'

/**
 * BETA : verifie uniquement l'AUTHENTIFICATION. Ni l'onboarding ni l'abonnement ne
 * bloquent l'acces a l'app. Retourne la session, ou redirige vers login si absente.
 */
export async function requireAuth() {
  // ⚠ REQUIREAUTH NE REJETTE JAMAIS. Les appelants font tous
  // `const session = await requireAuth()` sans `catch` : un rejet les laisse
  // sur leur ecran de chargement, sans message et sans renvoi vers /login.
  // Chaque chose qui peut lever est donc gardee, ici comme plus bas.
  let session = null
  try {
    session = await getSession()
  } catch (e) {
    // Pas de session PROUVABLE : on traite comme une absence. /login affiche
    // son formulaire sans dependre du stockage, donc sans boucler.
    console.error('[auth-guard] lecture de session impossible:', e)
  }
  if (!session) {
    window.location.replace('/pages/login.html')
    return null
  }

  const userId = session.user.id

  // ⚠ LE STOCKAGE DE SESSION PEUT LEVER, ET C'EST ICI QU'ON ARRIVE QUAND IL
  // LEVE. `sessionStorage` est inaccessible dans exactement les memes
  // configurations que `localStorage` — donnees de site bloquees, iframe sans
  // allow-same-origin, certaines webviews — c'est-a-dire la liste que cite la
  // sonde de index.html pour sortir le retour d'authentification de son `try`.
  // Depuis le lot du 20 octobre 2026, un hote dans cette configuration qui
  // confirme son inscription est AIGUILLE SUR CETTE PAGE. Hors garde, ces
  // quatre acces faisaient rejeter `requireAuth`. Le cache memorise est un
  // confort : s'en passer coute une revalidation, pas l'acces a l'app.
  try {
    // Invalider le cache si user a change (logout/login autre compte)
    const cachedUserId = sessionStorage.getItem(SESSION_USER_KEY)
    if (cachedUserId && cachedUserId !== userId) {
      sessionStorage.removeItem(CACHE_KEY)
      sessionStorage.removeItem(GF_CACHE_KEY)
      // Autre utilisateur sur ce navigateur : son compte memorise n'a rien a faire
      // ici. `chargerContexte` le revaliderait de toute facon, mais le nettoyer
      // tout de suite evite une bascule visible sur un compte etranger.
      reinitialiser()
    }
    sessionStorage.setItem(SESSION_USER_KEY, userId)
  } catch (e) {
    console.error('[auth-guard] stockage de session indisponible:', e)
  }

  // ⚠ LES DEUX LECTURES PARTENT ENSEMBLE, LA DECISION ATTEND LES DEUX.
  // Le contexte de compte et l'etat d'onboarding ne dependent pas l'un de
  // l'autre : les enchainer coutait un aller-retour pour rien. Ce qui doit
  // rester ordonne, c'est la DECISION de redirection ci-dessous — elle ne se
  // prend qu'une fois les deux resultats connus. La regle qui suit est donc
  // intacte.
  //
  // ⚠ LE CONTEXTE DE COMPTE SE CHARGE AVANT LA REDIRECTION D'ONBOARDING.
  // Un invite qui n'a jamais eu de compte a lui est exactement dans l'etat que
  // le forcage vise (`!completed && current_step === 0`) : il partait donc dans
  // l'assistant « connectez votre logement » sur son propre compte vide, sans
  // jamais atteindre le selecteur qui lui donne acces au compte ou il est invite.
  //
  // Tolerant a la panne : sur echec, `chargerContexte` retombe sur le compte
  // propre — un incident ne doit pas empecher un hote seul d'utiliser son app.
  // Chacune porte son propre echec : un rejet ne doit pas emporter l'autre
  // lecture, et surtout pas laisser une promesse non traitee derriere lui.
  //
  // ⚠ LA CONSTRUCTION EST DANS L'ENVELOPPE, PAS SEULEMENT L'ATTENTE. Fabriquer
  // la requete peut LEVER de facon synchrone (client en mauvais etat, URL ou
  // schema mal configures). Hors enveloppe, ce throw sortait de `requireAuth`
  // lui-meme : aucun des appelants ne l'attrape, la page restait sur son ecran
  // de chargement, et personne n'etait renvoye vers /login.
  //
  // ⚠ ET L'ECHEC SE LIT PAR LA PRESENCE DE LA CLE, PAS PAR SA VERACITE. Une
  // raison de rejet peut etre falsy (`Promise.reject()`, `throw undefined`) :
  // `if (r.e)` prenait alors le chemin du succes avec des donnees `undefined`,
  // ce que le try/catch qu'on remplace ne pouvait pas faire.
  const capturer = (fabrique) => {
    try { return Promise.resolve(fabrique()).then(v => ({ v }), e => ({ e })) }
    catch (e) { return Promise.resolve({ e }) }
  }
  const pContexte = capturer(() => chargerContexte(userId))
  const pOnboarding = capturer(() => supabase
    .from('onboarding_state')
    .select('current_step, completed')
    .eq('user_id', userId)
    .maybeSingle())

  const [rContexte, rOnboarding] = await Promise.all([pContexte, pOnboarding])

  let membreAilleurs = false
  if ('e' in rContexte) {
    console.error('[auth-guard] contexte de compte indisponible:', rContexte.e)
  } else {
    const ctx = rContexte.v
    membreAilleurs = (ctx?.comptes || []).some(c => String(c.user_id) !== String(userId))
  }

  // BETA : l'onboarding ET l'abonnement ne BLOQUENT PLUS l'acces a l'app.
  // requireAuth ne fait qu'authentifier. L'incitation a finaliser l'onboarding passe par
  // le bandeau persistant (renderOnboardingBanner) ; l'acces aux features payantes par le
  // parcours Stripe reel (coupon beta). On garantit seulement l'existence de la ligne
  // onboarding_state au 1er login, pour le suivi d'avancement et le bandeau.
  //
  // ⚠ ET UN ETAT INCONNU NE VAUT PAS « JAMAIS COMMENCE ». Le forcage plus bas
  // se declenche sur `!completed && current_step === 0` : si la lecture ECHOUE,
  // ces deux valeurs restent a leur defaut et un hote qui a fini son onboarding
  // il y a des mois — sur un appareil neuf, donc sans la garde localStorage —
  // etait jete dans l'assistant par une panne passagere. `etatConnu` dit si on
  // SAIT ; dans le doute, on ne force rien.
  let step = 0
  let completed = false
  let etatConnu = false
  try {
    if ('e' in rOnboarding) throw rOnboarding.e
    // ⚠ L'ERREUR D'UNE LECTURE POSTGREST N'EST PAS UN REJET. Sans
    // `.throwOnError()`, le builder RESOUT toujours : un 503, un refus RLS ou
    // un navigateur hors ligne rendent `{ data: null, error, status: 0 }`. Lire
    // `data` seul rendait la panne indistinguable de « pas de ligne », donc un
    // INSERT aveugle puis `step = 0` — et un hote qui a fini son onboarding il y
    // a des mois, sur un appareil neuf, renvoye dans l'assistant.
    if (rOnboarding.v && rOnboarding.v.error) throw rOnboarding.v.error
    const onboarding = rOnboarding.v && rOnboarding.v.data
    if (!onboarding) {
      // La lecture a REUSSI et dit qu'il n'y a pas de ligne : l'etat est connu.
      etatConnu = true
      await supabase.from('onboarding_state').insert({ user_id: userId, current_step: 0, completed: false })
    } else {
      step = onboarding.current_step
      completed = onboarding.completed === true
      etatConnu = true
    }
  } catch (e) {
    console.error('[auth-guard] ensure onboarding_state failed:', e)
  }

  // 1er login : forcer l'onboarding UNE fois. Un hote qui a deja avance (current_step > 0)
  // ou termine n'est jamais reforce -> le bandeau persistant prend le relais. La garde
  // localStorage (par utilisateur) evite de repiéger a chaque page un hote reste a l'etape 0.
  try {
    const onOnboarding = window.location.pathname.indexOf('onboarding') !== -1
    const neverStarted = (step == null || step === 0)
    const forcedKey = 'hs_ob_forced_' + userId
    // Membre d'un autre compte : l'onboarding « connectez votre logement » n'a
    // aucun sens pour lui, il vient travailler sur le compte de quelqu'un.
    if (etatConnu && !completed && neverStarted && !onOnboarding && !membreAilleurs
        && !localStorage.getItem(forcedKey)) {
      localStorage.setItem(forcedKey, '1')
      window.location.replace('/pages/onboarding.html')
      return null
    }
  } catch (e) {
    // localStorage indisponible : on n'empeche pas l'acces (redirection best-effort).
    console.error('[auth-guard] onboarding redirect skipped:', e)
  }

  return session
}

/**
 * À appeler depuis onboarding.html étape 7 quand l'onboarding est marqué completed,
 * pour que les pages chargées ensuite ne refassent pas une requête Supabase inutile.
 */
export function markOnboardingCompleted() {
  sessionStorage.setItem(CACHE_KEY, 'true')
}

export function markGuestflowActive() {
  sessionStorage.setItem(GF_CACHE_KEY, 'true')
}

export function invalidateGuestflowCache() {
  sessionStorage.removeItem(GF_CACHE_KEY)
}
