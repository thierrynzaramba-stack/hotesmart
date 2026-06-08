import { getUser, signOut, supabase } from '../shared/supabase.js'
import CONFIG from '../shared/config.js'

export async function renderSidebar(activePage = '') {
  const user = await getUser()
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  const apiStatus = await getApiStatus(user)

  // Lien Calendrier : pointe vers le calendrier du premier bien ;
  // sans bien, mène à la liste pour en créer un.
  const calendrierHref = apiStatus.firstPropertyId
    ? `/biens/${apiStatus.firstPropertyId}/calendrier`
    : '/biens'

  sidebar.innerHTML = `
    <div class="nav">

      <a class="nav-item ${activePage === 'accueil' ? 'active' : ''}" href="/">
        <span class="nav-icon">⌂</span>
        <span class="nav-label">Accueil</span>
      </a>

      <a class="nav-item ${activePage === 'biens' || activePage === 'biens-detail' || activePage === 'biens-nouveau' ? 'active' : ''}" href="/biens">
        <span class="nav-icon">🏠</span>
        <span class="nav-label">Mes biens</span>
      </a>

      <a class="nav-item ${activePage === 'agent-ai-messagerie' ? 'active' : ''}" href="/apps/agent-ai/messagerie">
        <span class="nav-icon">💬</span>
        <span class="nav-label">Messages</span>
      </a>

      <a class="nav-item ${activePage === 'biens-calendrier' ? 'active' : ''}" href="${calendrierHref}">
        <span class="nav-icon">📅</span>
        <span class="nav-label">Calendrier</span>
      </a>

      <div class="nav-section-label">Apps</div>
      ${renderApps(activePage)}

      <div class="nav-section-label">Configuration</div>
      <a class="nav-item ${activePage === 'api' ? 'active' : ''}" href="/connexions">
        <span class="nav-icon">⚡</span>
        <span class="nav-label">Connexions</span>
      </a>
      ${renderApiItem('Beds24',           apiStatus.beds24, null)}
      ${renderApiItem('Booking & Airbnb', apiStatus.ota,    '/connexions')}
      ${renderApiItem('Seam Serrures',    apiStatus.seam,   '/apps/serrures')}
      ${renderApiItem('Brevo SMS',        apiStatus.brevo,  null)}
      ${renderApiItem('Stripe',           apiStatus.stripe, null)}

      <div class="nav-section-label">Compte</div>
      <a class="nav-item ${activePage === 'compte' ? 'active' : ''}" href="/pages/compte.html">
        <span class="nav-icon">👤</span>
        <span class="nav-label">Mon compte</span>
      </a>
      <a class="nav-item ${activePage === 'abonnement' ? 'active' : ''}" href="/abonnement">
        <span class="nav-icon">◈</span>
        <span class="nav-label">Abonnement</span>
      </a>
      <a class="nav-item ${activePage === 'guide' ? 'active' : ''}" href="/guide">
        <span class="nav-icon">📖</span>
        <span class="nav-label">Guide</span>
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
        <div class="user-plan">${apiStatus.plan || ''}</div>
      </div>
    </div>
  `

  initMobileSidebar(sidebar)
}

function initMobileSidebar(sidebar) {
  if (document.getElementById('sidebar-toggle')) return

  const toggle = document.createElement('button')
  toggle.id = 'sidebar-toggle'
  toggle.innerHTML = '☰'
  toggle.style.cssText = `
    display: none;
    position: fixed;
    top: 14px;
    left: 14px;
    z-index: 1000;
    background: var(--bg);
    border: 0.5px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 12px;
    font-size: 18px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  `
  document.body.appendChild(toggle)

  const overlay = document.createElement('div')
  overlay.id = 'sidebar-overlay'
  overlay.style.cssText = `
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.3);
    z-index: 99;
  `
  document.body.appendChild(overlay)

  const style = document.createElement('style')
  style.textContent = `
    @media (max-width: 768px) {
      #sidebar-toggle { display: block !important; }
      .sidebar {
        position: fixed !important;
        left: -260px !important;
        top: 0 !important;
        height: 100vh !important;
        z-index: 100 !important;
        transition: left 0.25s ease !important;
        box-shadow: none !important;
      }
      .sidebar.open {
        left: 0 !important;
        box-shadow: 4px 0 20px rgba(0,0,0,0.15) !important;
      }
      .sidebar:hover { left: -260px !important; }
      .sidebar.open:hover { left: 0 !important; }
      #sidebar-overlay.open { display: block !important; }
      .main { margin-left: 0 !important; }
      .layout { grid-template-columns: 1fr !important; }
    }
  `
  document.head.appendChild(style)

  toggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.contains('open')
    sidebar.classList.toggle('open', !isOpen)
    overlay.classList.toggle('open', !isOpen)
    toggle.innerHTML = isOpen ? '☰' : '✕'
  })

  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open')
    overlay.classList.remove('open')
    toggle.innerHTML = '☰'
  })

  sidebar.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        sidebar.classList.remove('open')
        overlay.classList.remove('open')
        toggle.innerHTML = '☰'
      }
    })
  })
}

function renderApps(activePage) {
  return CONFIG.apps.map(app => {
    const isActive    = app.active !== false
    const isActiveApp = activePage === app.id || activePage.startsWith(app.id + '-')

    // Apps non disponibles : masquées (réactivables via shared/config.js à leur sortie)
    if (!isActive) return ''

    let subMenu = ''

    if (app.id === 'agent-ai') {
      // La Messagerie est dans le menu principal ("Messages"). La to-do (ex
      // "Signature Humaine") et le Simulateur sont désormais intégrés DANS la
      // page Messages — ils ne figurent plus dans ce sous-menu.
      subMenu = `
        <a class="nav-sub ${activePage === 'agent-ai-knowledge' ? 'connected' : ''}" href="/apps/agent-ai/knowledge">
          <div class="sub-dot ${activePage === 'agent-ai-knowledge' ? 'green' : 'gray'}"></div>Base de connaissance
        </a>
        <a class="nav-sub ${activePage === 'agent-ai-messages' ? 'connected' : ''}" href="/apps/agent-ai/messages">
          <div class="sub-dot ${activePage === 'agent-ai-messages' ? 'green' : 'gray'}"></div>Envoi programmé
        </a>
        <a class="nav-sub ${activePage === 'agent-ai-config' ? 'connected' : ''}" href="/apps/agent-ai/config">
          <div class="sub-dot ${activePage === 'agent-ai-config' ? 'green' : 'gray'}"></div>Configuration
        </a>`
    } else if (app.id === 'menages') {
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
        <span class="nav-label">${app.name}</span>
      </a>
      ${subMenu}`
  }).join('')
}

function renderApiItem(label, active, href) {
  if (active) {
    const tag = href ? 'a' : 'div'
    const hrefAttr = href ? `href="${href}"` : ''
    return `
      <${tag} class="nav-sub connected" ${hrefAttr} style="text-decoration:none;color:inherit">
        <div class="sub-dot green"></div>${label}
        <span class="sub-check">✓</span>
      </${tag}>`
  }
  if (href) {
    return `
      <a class="nav-sub" href="${href}" style="opacity:0.55;text-decoration:none;color:inherit">
        <div class="sub-dot gray"></div>${label}
        <span class="sub-soon">à connecter</span>
      </a>`
  }
  return `
    <div class="nav-sub" style="opacity:0.4">
      <div class="sub-dot gray"></div>${label}
      <span class="sub-soon">inactif</span>
    </div>`
}

async function getApiStatus(user) {
  if (!user) return { beds24: false, ota: false, seam: false, brevo: false, stripe: false, plan: null, firstPropertyId: null }
  try {
    const { data } = await supabase
      .from('api_keys')
      .select('api_key, seam_api_key, seam_enabled')
      .eq('user_id', user.id)
      .maybeSingle()

    // Biens géré par le channel manager : statut OTA + premier bien (lien Calendrier)
    let otaActive = false
    let firstPropertyId = null
    try {
      const { data: chProps } = await supabase
        .from('properties')
        .select('id')
        .eq('user_id', user.id)
        .in('provider', ['channex', 'channel'])
        .order('created_at', { ascending: true })
        .limit(1)
      if (chProps && chProps.length) {
        otaActive = true
        firstPropertyId = chProps[0].id
      }
    } catch { /* no-op */ }

    let stripeActive = false
    let plan = null
    try {
      const { data: gf } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user.id)
        .eq('module', 'guestflow')
        .maybeSingle()
      if (gf) {
        if (gf.status === 'trialing') { stripeActive = true; plan = 'Essai gratuit' }
        else if (gf.status === 'active') { stripeActive = true; plan = 'Abonné' }
        else if (gf.status === 'past_due') { stripeActive = true; plan = 'Paiement en attente' }
        else { plan = 'Aucun abonnement' }
      } else {
        plan = 'Aucun abonnement'
      }
    } catch { plan = null }

    return {
      beds24: !!data?.api_key,
      ota:    otaActive,
      seam:   !!(data?.seam_api_key && data?.seam_enabled !== false),
      brevo:  true,
      stripe: stripeActive,
      plan:   plan,
      firstPropertyId
    }
  } catch {
    return { beds24: false, ota: false, seam: false, brevo: false, stripe: false, plan: null, firstPropertyId: null }
  }
}

function getInitials(email = '') {
  return email.substring(0, 2).toUpperCase()
}

window.handleSignOut = async function() {
  await signOut()
}
