import { getUser, signOut } from '../shared/supabase.js'
import CONFIG from '../shared/config.js'

export async function renderSidebar(activePage = '') {
  const user = await getUser()

  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  sidebar.innerHTML = `
    <div class="toggle-btn" onclick="toggleSidebar()">☰</div>
    <div class="nav">
      <div class="nav-section-label">Principal</div>
      <a class="nav-item ${activePage === 'accueil' ? 'active' : ''}" href="/">
        <span class="nav-icon">⌂</span>
        <span class="nav-label">Accueil</span>
      </a>
      <a class="nav-item ${activePage === 'apps' ? 'active' : ''}" href="/apps">
        <span class="nav-icon">⊞</span>
        <span class="nav-label">Mes apps</span>
      </a>
      <a class="nav-item ${activePage === 'biens' ? 'active' : ''}" href="/biens">
        <span class="nav-icon">🏠</span>
        <span class="nav-label">Biens</span>
      </a>

      <div class="nav-section-label">Apps actives</div>
      ${await renderActiveApps(user, activePage)}

      <div class="nav-section-label">Mes API</div>
      <a class="nav-item ${activePage === 'api' ? 'active' : ''}" href="/pages/connexions">
        <span class="nav-icon">⚡</span>
        <span class="nav-label">Connexions</span>
        <span class="nav-badge" id="api-badge">...</span>
      </a>
      <div class="nav-sub connected">
        <div class="sub-dot green"></div>Beds24
        <span class="sub-check">✓</span>
      </div>
      <div class="nav-sub connected">
        <div class="sub-dot green"></div>Stripe
        <span class="sub-check">✓</span>
      </div>
      <div class="nav-sub">
        <div class="sub-dot gray"></div>Airbnb
        <span class="sub-soon">bientôt</span>
      </div>
      <div class="nav-sub">
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

async function renderActiveApps(user, activePage = '') {
  if (!user) return ''
  return CONFIG.apps.map(app => {
    const isAgentAI = app.id === 'agent-ai'
    const isMenages = app.id === 'menages'
    const isSms     = app.id === 'sms'
    const isActiveApp = activePage === app.id || activePage.startsWith(app.id)
    const subMenu = isMenages ? `
      <a class="nav-sub ${activePage === 'menages' ? 'connected' : ''}" href="/apps/menages">
        <div class="sub-dot ${activePage === 'menages' ? 'green' : 'gray'}"></div>Planning
      </a>
      <a class="nav-sub ${activePage === 'menages-prestataires' ? 'connected' : ''}" href="/apps/menages/prestataires">
        <div class="sub-dot ${activePage === 'menages-prestataires' ? 'green' : 'gray'}"></div>Prestataires
      </a>
    ` : isAgentAI ? `
      <a class="nav-sub ${activePage === 'agent-ai' ? 'connected' : ''}" href="/apps/agent-ai">
        <div class="sub-dot ${activePage === 'agent-ai' ? 'green' : 'gray'}"></div>Messages
      </a>
      <a class="nav-sub ${activePage === 'agent-ai-knowledge' ? 'connected' : ''}" href="/apps/agent-ai/knowledge">
        <div class="sub-dot ${activePage === 'agent-ai-knowledge' ? 'green' : 'gray'}"></div>Base de connaissance
      </a>
      <a class="nav-sub ${activePage === 'agent-ai-test' ? 'connected' : ''}" href="/apps/agent-ai/test">
        <div class="sub-dot ${activePage === 'agent-ai-test' ? 'green' : 'gray'}"></div>Mode test
      </a>
      <a class="nav-sub ${activePage === 'agent-ai-analyze' ? 'connected' : ''}" href="/apps/agent-ai/analyze">
        <div class="sub-dot ${activePage === 'agent-ai-analyze' ? 'green' : 'gray'}"></div>Analyse
      </a>
    ` : isSms ? `
      <a class="nav-sub ${activePage === 'sms' ? 'connected' : ''}" href="/apps/sms">
        <div class="sub-dot ${activePage === 'sms' ? 'green' : 'gray'}"></div>Envoi SMS
      </a>
    ` : ''
    return `
      <a class="nav-item ${isActiveApp ? 'active' : ''}" href="/apps/${app.id}">
        <span class="nav-icon" style="font-size:14px">${app.icon}</span>
        <span class="nav-label">${app.name}</span>
      </a>
      ${subMenu}
    `
  }).join('')
}

function getInitials(email = '') {
  return email.substring(0, 2).toUpperCase()
}

window.toggleSidebar = function() {
  document.getElementById('sidebar').classList.toggle('open')
}

window.handleSignOut = async function() {
  await signOut()
}