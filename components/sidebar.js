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
      ${await renderActiveApps(user)}

      <div class="nav-section-label">Mes API</div>
      <a class="nav-item ${activePage === 'api' ? 'active' : ''}" href="/api">
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

async function renderActiveApps(user) {
  if (!user) return ''
  return CONFIG.apps.map(app => `
    <a class="nav-item" href="/apps/${app.id}">
      <span class="nav-icon" style="font-size:14px">${app.icon}</span>
      <span class="nav-label">${app.name}</span>
    </a>
  `).join('')
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