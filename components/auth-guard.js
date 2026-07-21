import { supabase, getSession } from '/shared/supabase.js'

const CACHE_KEY = 'hs_onboarding_completed'
const GF_CACHE_KEY = 'hs_guestflow_active'
const SESSION_USER_KEY = 'hs_auth_user_id'

/**
 * BETA : verifie uniquement l'AUTHENTIFICATION. Ni l'onboarding ni l'abonnement ne
 * bloquent l'acces a l'app. Retourne la session, ou redirige vers login si absente.
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

  // BETA : l'onboarding ET l'abonnement ne BLOQUENT PLUS l'acces a l'app.
  // requireAuth ne fait qu'authentifier. L'incitation a finaliser l'onboarding passe par
  // le bandeau persistant (renderOnboardingBanner) ; l'acces aux features payantes par le
  // parcours Stripe reel (coupon beta). On garantit seulement l'existence de la ligne
  // onboarding_state au 1er login, pour le suivi d'avancement et le bandeau.
  try {
    const { data: onboarding } = await supabase
      .from('onboarding_state')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle()
    if (!onboarding) {
      await supabase.from('onboarding_state').insert({ user_id: userId, current_step: 0, completed: false })
    }
  } catch (e) {
    console.error('[auth-guard] ensure onboarding_state failed:', e)
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
