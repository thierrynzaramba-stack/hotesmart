// components/onboarding-banner.js
// Bandeau persistant d'incitation, injecte en haut de chaque page (appele par
// renderSidebar). Priorite : onboarding tant qu'il n'est pas fini, puis abonnement.
// Auto-suffisant (styles inline) : ne depend pas de style.css.
import { supabase, getUser } from '/shared/supabase.js'

const DISMISS_KEY = 'hs_ob_banner_dismissed'

export async function renderOnboardingBanner() {
  // Idempotent + ferme pour la session (sessionStorage -> revient a la prochaine visite)
  // + jamais sur les pages de finalisation elles-memes.
  if (document.getElementById('hs-ob-banner')) return
  try { if (sessionStorage.getItem(DISMISS_KEY) === '1') return } catch {}
  const here = (window.location.pathname || '').replace(/\.html$/, '')
  if (here.includes('/onboarding') || here.includes('/abonnement')) return

  let user
  try { user = await getUser() } catch { return }
  if (!user) return

  let banner = null
  try {
    // 1) Onboarding non termine -> priorite absolue.
    const { data: ob } = await supabase
      .from('onboarding_state')
      .select('completed, data')
      .eq('user_id', user.id)
      .maybeSingle()

    // Flag beta lu sur 'accounts' (non falsifiable client). Table possiblement absente.
    let isBeta = false
    try {
      const { data: acct } = await supabase
        .from('accounts')
        .select('is_beta')
        .eq('user_id', user.id)
        .maybeSingle()
      isBeta = acct?.is_beta === true
    } catch (e) { /* table absente : non-beta */ }

    if (ob && !ob.completed) {
      const step = (ob.data && ob.data.resume_label) ? ' — ' + ob.data.resume_label : ''
      banner = {
        text: 'Finalisez la configuration de votre compte' + step,
        cta: 'Reprendre', href: '/pages/onboarding.html'
      }
    } else if (ob && ob.completed && !isBeta) {
      // 2) Onboarding fini, hors beta, pas d'abonnement actif -> incitation abonnement.
      //    Beta : aucune incitation au paiement.
      const { data: gf } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user.id).eq('module', 'guestflow')
        .maybeSingle()
      const active = gf && (gf.status === 'trialing' || gf.status === 'active' || gf.status === 'past_due')
      if (!active) banner = {
        text: 'Activez votre abonnement pour débloquer toutes les fonctionnalités',
        cta: 'Voir les offres', href: '/pages/abonnement.html'
      }
    }
  } catch (e) {
    console.error('[onboarding-banner] read failed:', e)
    return
  }

  if (!banner) return

  const bar = document.createElement('div')
  bar.id = 'hs-ob-banner'
  bar.style.cssText = 'position:sticky;top:0;z-index:200;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;padding:10px 44px;font-size:14px;line-height:1.35;background:#1d1d1f;color:#fff;text-align:center;'
  const msg = document.createElement('span')
  msg.textContent = banner.text
  const link = document.createElement('a')
  link.href = banner.href
  link.textContent = banner.cta
  link.style.cssText = 'background:#007aff;color:#fff;text-decoration:none;padding:7px 14px;border-radius:8px;font-weight:600;white-space:nowrap;'
  const close = document.createElement('button')
  close.setAttribute('aria-label', 'Fermer')
  close.innerHTML = '&times;'
  close.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:#fff;font-size:22px;line-height:1;cursor:pointer;opacity:0.7;padding:0 6px;'
  close.addEventListener('click', () => { try { sessionStorage.setItem(DISMISS_KEY, '1') } catch {}; bar.remove() })
  bar.appendChild(msg); bar.appendChild(link); bar.appendChild(close)
  document.body.insertBefore(bar, document.body.firstChild)
}
