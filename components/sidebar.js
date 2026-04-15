import { getUser, signOut } from '../shared/supabase.js'
import CONFIG from '../shared/config.js'

export async function renderSidebar(activePage = '') {
  const user = await getUser()

  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  // Vérifier les API actives
  const apiStatus = await getApiStatus(user)

  sidebar.innerHTML = `
    <div class="nav">

      <a class="nav-item ${activePage === 'accueil' ? 'active' : ''}" href="/">
        <span class="nav-icon">⌂</span>
        <span class="nav-label">Accueil</span>
      </a>

      <div class="nav-section-label">Apps</div>
      ${await renderActiveApps(user, activePage)}

      <div class="nav-section-label">API connectées</div>
      <a class="nav-item ${activePage === 'api' ? 'active' : ''}" href="/pages/connexions">
        <span class="nav-icon">⚡</span>
        <span class="nav-label">Connexions</span>
      </a>

      ${apiStatus.beds24 ? `
      <div class="nav-sub connected">
        <div class="sub-dot green"></div>Beds24
        <span class="sub-check">✓</span>
      </div>` : `
      <div class="nav-sub" style="opacity:0.45">
        <div class="sub-dot gray"></div>Beds24
        <span class="sub-soon">inactif</span>
      </div>`}

      ${apiStatus.seam ? `
      <a class="nav-sub connected ${activePage === 'serrures' ? 'active' : ''}" href="/apps/serrures" style="text-decoration:none;color:inherit">
        <div class="sub-dot green"></div>Seam Serrures
        <span class="sub-check">✓</span>
      </a>` : `
      <a class="nav-sub" href="/apps/serrures" style="text-decoration:none;color:inherit;opacity:0.45">
        <div class="sub-dot gray"></div>Seam Serrures
        <span class="sub-soon">inactif</span>
      </a>`}

      ${apiStatus.brevo ? `
      <div class="nav-sub connected">
        <div class="sub-dot green"></div>Brevo SMS
        <span class="sub-check">✓</span>
      </div>` : `
      <div class="nav-sub" style="opacity:0.45">
        <div class="sub-dot gray"></div>Brevo SMS
        <span class="sub-soon">inactif</span>
      </div>`}

      ${apiStatus.stripe ? `
      <div class="nav-sub connected">
        <div class="sub-dot green"></div>Stripe
        <span class="sub-check">✓</span>
      </div>` : `
      <div class="nav-sub" style="opacity:0.45">
        <div class="sub-dot gray"></div>Stripe
        <span class="sub-soon">inactif</span>
      </div>`}

      <div class="nav-sub" style="opacity:0.45">
        <div class="sub-dot gray"></div>Airbnb
        <span class="sub-soon">bientôt</span>
      </div>
      <div class="nav-sub" style="opacity:0.45">
        <div class="sub-dot gray"></div>Booking.com
        <span class="sub-soon">bientôt</span>
      </div>

      <div class="nav-section-label">Compte</div>
      <a class="nav-item ${activePage === 'abonnement' ? 'active' : ''}" href="/abonnement">
        <span class="nav-icon">◈</span>
        <span class="nav-label">Abonnement</span>
      </a>
      <a class="nav-item ${activePage === 'settings' ? 'active' : ''}" href="/settings">
        <span class="nav-icon">⚙</span>
        <span class="nav-label">Paramètres</span>
      </a>
      <div class="nav-item" onclick="handleSignOut()" style="cursor:pointer">
        <span class="nav-icon">↩</span>
        <span class="nav-label">Déconnexion</span>
      </div>

    </div>

    <div class="user-block">
      <div class="avatar">${getInitials(user?.email)}</div>
      <div class="user-info">
        <div class="user-name">${user?.user_metadata?.full_name || user?.email || ''}</div>
        <div class="user-plan" id="user-plan">Plan Pro</div>
      </div>
    </div>
  `
}

async function getApiStatus(user) {
  if (!user) return {}
  try {
    const { createClient } = await import('../shared/supabase.js')
    const { data } = await (await import('../shared/supabase.js')).supabase
      .from('api_keys')
      .select('api_key, seam_api_key, seam_enabled')
      .eq('user_id', user.id)
      .maybeSingle()
    return {
      beds24: !!data?.api_key,
      seam:   !!(data?.seam_api_key && data?.seam_enabled),
      brevo:  !!process?.env?.BREVO_API_KEY || true, // toujours actif côté serveur
      stripe: false // à implémenter
    }
  } catch {
    return { beds24: false, seam: false, brevo: false, stripe: false }
  }
}

async function renderActiveApps(user, activePage = '') {
  if (!user) return ''

  return CONFIG.apps.map(app => {
    const isAgentAI = app.id === 'agent-ai'
    const isMenages = app.id === 'menages'
    const isSerrures = app.id === 'serrures'
    const isActiveApp = activePage === app.id || activePage.startsWith(app.id)

    // Nom affiché
    const displayName = isAgentAI ? 'GuestFlow AI' : app.name

    let subMenu = ''

    if (isAgentAI) {
      subMenu = `
        <a class="nav-sub ${activePage === 'agent-ai' ? 'connected' : ''}" href="/apps/agent-ai">
          <div class="sub-dot ${activePage === 'agent-ai' ? 'green' : 'gray'}"></div>Signature Humaine
        </a>
        <a class="nav-sub ${activePage === 'agent-ai-knowledge' ? 'connected' : ''}" href="/apps/agent-ai/knowledge">
          <div class="sub-dot ${activePage === 'agent-ai-knowledge' ? 'green' : 'gray'}"></div>Base de connaissance
        </a>
        <a class="nav-sub ${activePage === 'agent-ai-messages' ? 'connected' : ''}" href="/apps/agent-ai/messages">
          <div class="sub-dot ${activePage === 'agent-ai-messages' ? 'green' : 'gray'}"></div>Envoi programmé
        </a>
        <a class="nav-sub ${activePage === 'agent-ai-config' ? 'connected' : ''}" href="/apps/agent-ai/config">
          <div class="sub-dot ${activePage === 'agent-ai-config' ? 'green' : 'gray'}"></div>Configuration
        </a>
        <a class="nav-sub ${activePage === 'agent-ai-test' ? 'connected' : ''}" href="/apps/agent-ai/test">
          <div class="sub-dot ${activePage === 'agent-ai-test' ? 'green' : 'gray'}"></div>Mode test
        </a>`
    } else if (isMenages) {
      subMenu = `
        <a class="nav-sub ${activePage === 'menages' ? 'connected' : ''}" href="/apps/menages">
          <div class="sub-dot ${activePage === 'menages' ? 'green' : 'gray'}"></div>Planning
        </a>
        <a class="nav-sub ${activePage === 'menages-prestataires' ? 'connected' : ''}" href="/apps/menages/prestataires">
          <div class="sub-dot ${activePage === 'menages-prestataires' ? 'green' : 'gray'}"></div>Prestataires
        </a>`
    }

    return `
      <a class="nav-item ${isActiveApp ? 'active' : ''}" href="/apps/${app.id}">
        <span class="nav-icon" style="font-size:14px">${app.icon}</span>
        <span class="nav-label">${displayName}</span>
      </a>
      ${subMenu}`
  }).join('')
}

function getInitials(email = '') {
  return email.substring(0, 2).toUpperCase()
}

window.handleSignOut = async function() {
  await signOut()
}
