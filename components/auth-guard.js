import { supabase, getSession } from '/shared/supabase.js'

const CACHE_KEY = 'hs_onboarding_completed'
const SESSION_USER_KEY = 'hs_auth_user_id'

// Pages où on autorise l'accès même si onboarding incomplet.
// Le check est fait sur le pathname normalisé (sans .html, sans trailing slash).
const ONBOARDING_EXEMPT_PATHS = [
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
  return session
}

/**
 * À appeler depuis onboarding.html étape 7 quand l'onboarding est marqué completed,
 * pour que les pages chargées ensuite ne refassent pas une requête Supabase inutile.
 */
export function markOnboardingCompleted() {
  sessionStorage.setItem(CACHE_KEY, 'true')
}
