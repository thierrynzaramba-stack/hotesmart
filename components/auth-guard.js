import { supabase, getSession } from '/shared/supabase.js'

const CACHE_KEY = 'hs_onboarding_completed'
const GF_CACHE_KEY = 'hs_guestflow_active'
const SESSION_USER_KEY = 'hs_auth_user_id'

// Pages où on autorise l'accès même si onboarding incomplet.
// Le check est fait sur le pathname normalisé (sans .html, sans trailing slash).
const ONBOARDING_EXEMPT_PATHS = [
  '/pages/onboarding',
  '/pages/compte',
  '/pages/abonnement'
]

// Pages où on autorise l'accès même sans GuestFlow actif (trialing/active).
// L'user doit pouvoir aller sur abonnement.html pour activer GuestFlow,
// et sur compte.html pour gérer son compte (changer mot de passe, supprimer compte).
// onboarding.html reste accessible pendant la transition onboarding -> abonnement.
const SUBSCRIPTION_EXEMPT_PATHS = [
  '/pages/onboarding',
  '/pages/compte',
  '/pages/abonnement'
]

function normalizePath(p) {
  return (p || '/').replace(/\.html$/, '').replace(/\/+$/, '') || '/'
}

function isExemptFromOnboarding() {
  const here = normalizePath(window.location.pathname)
  return ONBOARDING_EXEMPT_PATHS.some(p => here === p)
}

function isExemptFromSubscription() {
  const here = normalizePath(window.location.pathname)
  return SUBSCRIPTION_EXEMPT_PATHS.some(p => here === p)
}

/**
 * Vérifie auth + onboarding. Retourne la session si tout est OK.
 * Sinon redirige (login ou onboarding) et retourne null.
 */
export async function requireAuth() {
  const session = await getSession()
  if (!session) {
    window.location.replace('/pages/login.html')
    return null
  }

  const userId = session.user.id

  // Invalider le cache si user a changé (logout/login autre compte)
  const cachedUserId = sessionStorage.getItem(SESSION_USER_KEY)
  if (cachedUserId && cachedUserId !== userId) {
    sessionStorage.removeItem(CACHE_KEY)
    sessionStorage.removeItem(GF_CACHE_KEY)
  }
  sessionStorage.setItem(SESSION_USER_KEY, userId)

  // Si on est sur une page exemptée, on ne check pas l'onboarding
  if (isExemptFromOnboarding()) return session

  // Cache hit : onboarding déjà fini cette session
  if (sessionStorage.getItem(CACHE_KEY) === 'true') return session

  // Sinon, requête Supabase
  const { data: onboarding, error } = await supabase
    .from('onboarding_state')
    .select('completed')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[auth-guard] onboarding check failed:', error)
    // Fail-open : on ne bloque pas un user existant si la requête échoue
    return session
  }

  if (!onboarding) {
    // Premier login : créer la ligne et rediriger
    await supabase.from('onboarding_state').insert({
      user_id: userId,
      current_step: 0,
      completed: false
    })
    window.location.replace('/pages/onboarding.html')
    return null
  }

  if (!onboarding.completed) {
    window.location.replace('/pages/onboarding.html')
    return null
  }

  // Onboarding fini → cache pour le reste de la session
  sessionStorage.setItem(CACHE_KEY, 'true')

  // ── Check GuestFlow subscription active ─────────────────────────────────
  // Si on est sur une page exemptée, on ne check pas l'abonnement
  if (isExemptFromSubscription()) return session

  // Cache hit GuestFlow ?
  if (sessionStorage.getItem(GF_CACHE_KEY) === 'true') return session

  const { data: gfSub, error: gfErr } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('user_id', userId)
    .eq('module', 'guestflow')
    .maybeSingle()

  if (gfErr) {
    console.error('[auth-guard] guestflow check failed:', gfErr)
    return session
  }

  const gfActive = gfSub && (gfSub.status === 'trialing' || gfSub.status === 'active' || gfSub.status === 'past_due')
  if (!gfActive) {
    window.location.replace('/pages/abonnement.html')
    return null
  }

  sessionStorage.setItem(GF_CACHE_KEY, 'true')
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
