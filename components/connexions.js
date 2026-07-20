// components/connexions.js
// Ecran "Connexions" PAR BIEN (modale). Liste les canaux de distribution d'un logement
// et route vers l'assistant du canal clique. NE PAS confondre avec la page globale
// /connexions (pages/connexions.html = "Connexions API" de la sidebar) : ici c'est une
// modale ouverte depuis la carte d'un bien, titree "Connexions de {bien}".
//
// Detection d'etat : UN SEUL appel (api.channel.mapping.channels) renvoie tous les
// canaux du bien -> on classe par ota (Airbnb / BookingCom). airbnb-connect.js et
// booking-connect.js gardent leur propre modale ; ce fichier ne fait que router.
import { api } from '/shared/api-client.js'
import { logger } from '/shared/logger.js'
import { openAirbnbConnect } from '/components/airbnb-connect.js'
import { openBookingConnect } from '/components/booking-connect.js'

let injected = false
let S = null

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function ensureModal() {
  if (injected) return
  injected = true

  const style = document.createElement('style')
  style.textContent = `
    .cx-modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:none; align-items:center; justify-content:center; z-index:1000; padding:20px; }
    .cx-modal.show { display:flex; }
    .cx-modal-box { background:var(--bg); border-radius:var(--radius-lg); width:100%; max-width:520px; max-height:90vh; display:flex; flex-direction:column; overflow:hidden; }
    .cx-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:0.5px solid var(--border); flex-shrink:0; }
    .cx-head .title { font-size:14px; font-weight:500; }
    .cx-body { padding:18px; overflow:auto; flex:1; }
    .cx-status { display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text2); padding:14px 0; }
    .cx-spin { width:16px; height:16px; border:2px solid var(--border); border-top-color:var(--green); border-radius:50%; animation:cx-rot 0.8s linear infinite; flex-shrink:0; }
    @keyframes cx-rot { to { transform:rotate(360deg); } }
    .cx-err { font-size:13px; color:#C5221F; background:#FCE8E6; border-radius:var(--radius); padding:10px 12px; line-height:1.5; }
    .cx-list { display:flex; flex-direction:column; gap:10px; }
    .cx-row { display:flex; align-items:center; gap:12px; padding:13px 14px; border:0.5px solid var(--border); border-radius:var(--radius); }
    .cx-logo { width:34px; height:34px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0; background:var(--bg2, #f5f5f5); }
    .cx-info { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
    .cx-name { font-size:14px; font-weight:500; }
    .cx-state { font-size:12px; color:var(--text2); display:flex; align-items:center; gap:6px; }
    .cx-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
    .cx-dot.on { background:var(--green); }
    .cx-dot.off { background:var(--border); border:1px solid var(--text2); box-sizing:border-box; }
    .cx-row .btn { flex-shrink:0; }
    .cx-rule { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:10px 14px; margin-top:-8px; border:0.5px solid var(--border); border-top:none; border-radius:0 0 var(--radius) var(--radius); background:var(--bg2,#fafafa); font-size:13px; }
    .cx-rule-f { display:flex; align-items:center; gap:6px; }
    .cx-rule input { width:66px; padding:6px 8px; border:0.5px solid var(--border); border-radius:6px; font-size:13px; background:var(--bg); color:var(--text); }
    .cx-rule .btn { padding:6px 12px; }
    .cx-rule-msg { font-size:12px; }
    .cx-rule-msg.ok { color:#137333; }
    .cx-rule-msg.err { color:#C5221F; }
    @media (max-width:768px){ .cx-modal { padding:0 } .cx-modal-box { height:100vh; max-height:none; border-radius:0; max-width:none } }
  `
  document.head.appendChild(style)

  const modal = document.createElement('div')
  modal.className = 'cx-modal'
  modal.id = 'cx-modal'
  modal.innerHTML = `
    <div class="cx-modal-box">
      <div class="cx-head">
        <div class="title" id="cx-title">Connexions</div>
        <button class="btn" id="cx-close">✕</button>
      </div>
      <div class="cx-body" id="cx-body"></div>
    </div>
  `
  document.body.appendChild(modal)
  document.getElementById('cx-close').addEventListener('click', close)
  modal.addEventListener('click', (e) => { if (e.target === modal) close() })
}

function close() {
  const modal = document.getElementById('cx-modal')
  if (modal) modal.classList.remove('show')
  const body = document.getElementById('cx-body')
  if (body) body.innerHTML = ''
  S = null
}

function setBody(html) {
  document.getElementById('cx-body').innerHTML = html
}

async function render() {
  setBody(`<div class="cx-status"><div class="cx-spin"></div> Chargement de vos canaux…</div>`)

  const pid = S.property.provider_property_id
  if (!pid) {
    // Bien pas encore provisionne cote canal : Airbnb reste le point d'entree (OAuth cree le canal).
    return renderRows({ airbnb: null, booking: null })
  }

  let channels = []
  let rules = {}
  try {
    const [rc, rr] = await Promise.all([
      api.channel.mapping.channels(pid),
      api.channel.rateplan.rules(pid).catch(() => ({ rules: {} }))
    ])
    channels = Array.isArray(rc?.channels) ? rc.channels : []
    rules = rr?.rules || {}
  } catch (e) {
    logger.error('connexions', 'channels echec', { e: e.message })
    setBody(`<div class="cx-err">Impossible de charger l'état de vos canaux pour le moment. Réessayez dans un instant.</div>`)
    return
  }

  const airbnb = channels.find(c => /airbnb/i.test(c.ota || '')) || null
  const booking = channels.find(c => /booking/i.test(c.ota || '')) || null
  renderRows({ airbnb, booking, rules })
}

// Formulaire de regle par canal (coef prix + min stay). rule = { percent, min_stay } | undefined.
function ruleForm(channel, rule) {
  if (!rule) return ''
  const pct = rule.percent ?? 0
  const ms = rule.min_stay ?? ''
  return `
    <div class="cx-rule" data-ch="${channel}">
      <div class="cx-rule-f"><label>Prix : base +</label><input class="cx-pct" type="number" step="1" value="${escHtml(pct)}"> %</div>
      <div class="cx-rule-f"><label>Séjour min.</label><input class="cx-ms" type="number" min="1" value="${escHtml(ms)}" placeholder="hérité"> nuits</div>
      <button class="btn btn-primary cx-save">Enregistrer</button>
      <span class="cx-rule-msg"></span>
    </div>`
}

async function saveRule(channel, formEl, pid) {
  const pct = formEl.querySelector('.cx-pct').value
  const ms = formEl.querySelector('.cx-ms').value
  const msg = formEl.querySelector('.cx-rule-msg')
  const btn = formEl.querySelector('.cx-save')
  btn.disabled = true
  msg.className = 'cx-rule-msg'
  msg.textContent = 'Enregistrement…'
  try {
    await api.channel.rateplan.setRule(pid, channel, { percent: pct === '' ? 0 : Number(pct), minStay: ms, dryRun: false })
    // PREUVE : relire la regle appliquee (jamais de faux succes).
    const rr = await api.channel.rateplan.rules(pid)
    const applied = rr?.rules?.[channel]
    if (applied) {
      formEl.querySelector('.cx-pct').value = applied.percent ?? 0
      formEl.querySelector('.cx-ms').value = applied.min_stay ?? ''
    }
    msg.className = 'cx-rule-msg ok'
    msg.textContent = '✓ Enregistré'
  } catch (e) {
    logger.error('connexions', 'setRule echec', { e: e.message })
    msg.className = 'cx-rule-msg err'
    msg.textContent = '✗ Échec — non enregistré'
  } finally {
    btn.disabled = false
  }
}

function renderRows({ airbnb, booking, rules = {} }) {
  const airbnbConnected = !!airbnb
  const bookingConnected = !!(booking && booking.is_active === true)
  const bookingMappedInactive = !!(booking && booking.is_active !== true)

  setBody(`
    <div class="cx-list">
      <div class="cx-row">
        <div class="cx-logo">🅰️</div>
        <div class="cx-info">
          <div class="cx-name">Airbnb</div>
          <div class="cx-state">
            <span class="cx-dot ${airbnbConnected ? 'on' : 'off'}"></span>
            ${airbnbConnected
              ? `Connecté${airbnb.title ? ' — ' + escHtml(airbnb.title) : ''}`
              : 'Non connecté'}
          </div>
        </div>
        <button class="btn ${airbnbConnected ? '' : 'btn-primary'}" id="cx-airbnb">${airbnbConnected ? 'Gérer' : 'Connecter'}</button>
      </div>
      ${airbnbConnected ? ruleForm('airbnb', rules.airbnb) : ''}
      <div class="cx-row">
        <div class="cx-logo">🅱️</div>
        <div class="cx-info">
          <div class="cx-name">Booking.com</div>
          <div class="cx-state">
            <span class="cx-dot ${bookingConnected ? 'on' : 'off'}"></span>
            ${bookingConnected ? 'Connecté'
              : bookingMappedInactive ? 'Connexion en cours' : 'Non connecté'}
          </div>
        </div>
        <button class="btn ${bookingConnected || bookingMappedInactive ? '' : 'btn-primary'}" id="cx-booking">${bookingConnected || bookingMappedInactive ? 'Gérer' : 'Connecter'}</button>
      </div>
      ${(bookingConnected || bookingMappedInactive) ? ruleForm('booking', rules.booking) : ''}
    </div>
  `)

  // IMPORTANT : capturer property AVANT close() -> close() fait S=null, donc lire
  // S.property apres fermeture planterait (TypeError: null is not an object).
  const property = S.property
  const pid = property.provider_property_id
  document.getElementById('cx-airbnb').addEventListener('click', () => {
    close()
    openAirbnbConnect(property, null)
  })
  document.getElementById('cx-booking').addEventListener('click', () => {
    const existingChannel = booking ? { id: booking.id, is_active: booking.is_active } : null
    close()
    openBookingConnect(property, null, { existingChannel })
  })
  // Boutons Enregistrer des regles (un par formulaire present).
  document.querySelectorAll('.cx-rule').forEach(formEl => {
    formEl.querySelector('.cx-save').addEventListener('click', () => saveRule(formEl.dataset.ch, formEl, pid))
  })
}

// property = { id, name, provider_property_id }
export function openConnexions(property, _anchorEl) {
  ensureModal()
  S = { property }
  document.getElementById('cx-title').textContent = `Connexions de ${property.name || 'ce logement'}`
  document.getElementById('cx-modal').classList.add('show')
  render()
}
