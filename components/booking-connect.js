// components/booking-connect.js
// Assistant de connexion Booking.com (SANS OAuth : l'hote autorise Channex dans son
// extranet Booking, puis on cree + active le canal cote Channex).
// Orchestration A -> B -> C -> D :
//   A : prerequis (autoriser Channex dans l'extranet) + saisie hotel_id
//   B : verification (test_connection + mapping_details + connection_details)
//   C : liaison (create is_active:false) + activation
//   D : "Connecte"
//
// Reutilise les endpoints channel-bcom*.js via api.channel.bcom.*. Le mapping s'adresse
// par provider_property_id ; room_type_code/rate_plan_code viennent de l'ecran B.
// airbnb-connect.js n'est PAS touche : modale autonome, prefixe bk-.
import { api } from '/shared/api-client.js'
import { logger } from '/shared/logger.js'

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
    .bk-modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:none; align-items:center; justify-content:center; z-index:1000; padding:20px; }
    .bk-modal.show { display:flex; }
    .bk-modal-box { background:var(--bg); border-radius:var(--radius-lg); width:100%; max-width:560px; max-height:90vh; display:flex; flex-direction:column; overflow:hidden; }
    .bk-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:0.5px solid var(--border); flex-shrink:0; }
    .bk-head .title { font-size:14px; font-weight:500; }
    .bk-steps { display:flex; align-items:center; gap:6px; padding:12px 18px; border-bottom:0.5px solid var(--border); flex-shrink:0; overflow-x:auto; }
    .bk-step { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text2); white-space:nowrap; }
    .bk-step .num { width:18px; height:18px; border-radius:50%; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:10px; flex-shrink:0; }
    .bk-step.active { color:var(--text); font-weight:500; }
    .bk-step.active .num, .bk-step.done .num { background:var(--green); color:#fff; border-color:var(--green); }
    .bk-step-sep { flex:1; height:1px; background:var(--border); min-width:10px; }
    .bk-body { padding:20px; overflow:auto; flex:1; }
    .bk-h { font-size:16px; font-weight:500; margin-bottom:6px; }
    .bk-sub { font-size:13px; color:var(--text2); margin-bottom:18px; line-height:1.5; }
    .bk-prereq { list-style:none; padding:0; margin:0 0 18px; }
    .bk-prereq li { display:flex; gap:10px; align-items:flex-start; font-size:13px; padding:8px 0; border-bottom:0.5px solid var(--border); }
    .bk-prereq li span.ic { flex-shrink:0; }
    .bk-warn { font-size:13px; color:#8a5a00; background:#FEF7E0; border-radius:var(--radius); padding:10px 12px; margin-bottom:16px; line-height:1.5; }
    .bk-field { display:flex; flex-direction:column; gap:6px; margin-bottom:18px; }
    .bk-field label { font-size:13px; color:var(--text2); }
    .bk-field input { padding:10px 12px; border:0.5px solid var(--border); border-radius:var(--radius); font-size:14px; background:var(--bg); color:var(--text); }
    .bk-recap { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
    .bk-recap .row { display:flex; justify-content:space-between; gap:12px; font-size:13px; padding:9px 12px; border:0.5px solid var(--border); border-radius:var(--radius); }
    .bk-recap .row .k { color:var(--text2); }
    .bk-recap .row .v { font-weight:500; text-align:right; }
    .bk-recap .row .v .hint { display:block; font-weight:400; color:var(--text2); font-size:11px; margin-top:2px; }
    .bk-note { font-size:12px; color:var(--text2); margin-bottom:16px; line-height:1.5; }
    .bk-status { display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text2); padding:14px 0; }
    .bk-spin { width:16px; height:16px; border:2px solid var(--border); border-top-color:var(--green); border-radius:50%; animation:bk-rot 0.8s linear infinite; flex-shrink:0; }
    @keyframes bk-rot { to { transform:rotate(360deg); } }
    .bk-err { font-size:13px; color:#C5221F; background:#FCE8E6; border-radius:var(--radius); padding:10px 12px; margin-bottom:16px; line-height:1.5; }
    .bk-ok { font-size:15px; font-weight:500; color:#137333; text-align:center; padding:14px 0; }
    .bk-actions { display:flex; gap:8px; flex-wrap:wrap; }
    @media (max-width:768px){ .bk-modal { padding:0 } .bk-modal-box { height:100vh; max-height:none; border-radius:0; max-width:none } }
  `
  document.head.appendChild(style)

  const modal = document.createElement('div')
  modal.className = 'bk-modal'
  modal.id = 'bk-modal'
  modal.innerHTML = `
    <div class="bk-modal-box">
      <div class="bk-head">
        <div class="title" id="bk-title">Connexion Booking.com</div>
        <button class="btn" id="bk-close">✕</button>
      </div>
      <div class="bk-steps" id="bk-steps">
        <div class="bk-step" data-step="1"><span class="num">1</span><span>Établissement</span></div>
        <div class="bk-step-sep"></div>
        <div class="bk-step" data-step="2"><span class="num">2</span><span>Vérification</span></div>
        <div class="bk-step-sep"></div>
        <div class="bk-step" data-step="3"><span class="num">3</span><span>Liaison</span></div>
        <div class="bk-step-sep"></div>
        <div class="bk-step" data-step="4"><span class="num">4</span><span>Terminé</span></div>
      </div>
      <div class="bk-body" id="bk-body"></div>
    </div>
  `
  document.body.appendChild(modal)
  document.getElementById('bk-close').addEventListener('click', close)
  modal.addEventListener('click', (e) => { if (e.target === modal) close() })
}

function close() {
  const modal = document.getElementById('bk-modal')
  if (modal) modal.classList.remove('show')
  const body = document.getElementById('bk-body')
  if (body) body.innerHTML = ''
  S = null
}

function setBody(html) {
  document.getElementById('bk-body').innerHTML = html
}

function setStep(active) {
  document.querySelectorAll('#bk-steps .bk-step').forEach(el => {
    const n = Number(el.dataset.step)
    el.classList.toggle('done', n < active)
    el.classList.toggle('active', n === active)
  })
}

// ---------- A : prerequis + hotel_id ----------
function screenA() {
  setStep(1)
  document.getElementById('bk-title').textContent = `Connexion Booking.com — ${S.property.name || ''}`.trim()
  setBody(`
    <div class="bk-h">Avant de commencer</div>
    <div class="bk-sub">Pour connecter votre établissement Booking.com, trois points à préparer :</div>
    <ul class="bk-prereq">
      <li><span class="ic">📋</span><span>Autorisez la connexion dans votre extranet Booking.com. Rubrique <b>Compte → Fournisseur de connectivité</b>, recherchez <b>Channex</b> — c'est notre partenaire technique de connexion aux plateformes — et acceptez la demande.</span></li>
      <li><span class="ic">🔌</span><span><b>Aucun autre gestionnaire de canaux</b> n'est déjà relié à cet établissement (Booking n'autorise qu'une seule connexion à la fois).</span></li>
      <li><span class="ic">🔢</span><span>Munissez-vous de votre <b>ID d'établissement Booking</b> (un numéro à 7-8 chiffres, visible en haut de votre extranet, sous le nom de l'établissement).</span></li>
    </ul>
    <div class="bk-warn">⚠️ <b>Important.</b> Dès le lancement de la connexion, Booking.com <b>ferme temporairement vos dates à la réservation</b>, le temps que la liaison s'établisse. C'est normal et prévu : HôteSmart <b>rouvre vos dates automatiquement</b> dès l'activation, en respectant vos réservations en cours. Choisissez un moment calme pour connecter.</div>
    <div class="bk-field">
      <label for="bk-hotelid">Votre ID d'établissement Booking</label>
      <input id="bk-hotelid" type="text" inputmode="numeric" placeholder="Numéro à 7-8 chiffres" value="${escHtml(S.hotelId || '')}">
    </div>
    <div class="bk-actions">
      <button class="btn btn-primary" id="bk-continue">Continuer</button>
    </div>
  `)
  const input = document.getElementById('bk-hotelid')
  const cont = document.getElementById('bk-continue')
  const go = () => {
    const v = (input.value || '').trim()
    if (!/^\d{6,}$/.test(v)) { input.focus(); return }
    S.hotelId = v
    screenB()
  }
  cont.addEventListener('click', go)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
}

// ---------- B : verification (test_connection + mapping_details + connection_details) ----------
async function screenB() {
  setStep(2)
  setBody(`<div class="bk-status"><div class="bk-spin"></div> Nous vérifions votre établissement sur Booking.com…</div>`)

  let test, mapping, connection
  try {
    [test, mapping, connection] = await Promise.all([
      api.channel.bcom.testConnection(S.hotelId),
      api.channel.bcom.mappingDetails(S.hotelId),
      api.channel.bcom.connectionDetails(S.hotelId)
    ])
  } catch (e) {
    logger.error('booking-connect', 'verif echec', { e: e.message })
    return screenBError("Nous n'avons pas pu joindre votre établissement. Vérifiez que Channex est bien autorisé dans votre extranet Booking, puis réessayez.")
  }

  if (test?.success !== true) {
    return screenBError("Établissement non joignable. Vérifiez que Channex est autorisé dans votre extranet Booking (Compte → Fournisseur de connectivité) et que l'ID est correct, puis réessayez.")
  }

  const rooms = Array.isArray(mapping?.rooms) ? mapping.rooms : []
  const room = rooms[0]
  const rate = room && Array.isArray(room.rates) ? room.rates[0] : null
  if (!room || !rate) {
    return screenBError("Aucune chambre ou tarif exploitable trouvé sur cet établissement Booking. Vérifiez votre configuration Booking, puis réessayez.")
  }

  // RLO -> Standard (occupancies vide = prix unique). OBP conserve, sinon Standard.
  S.roomTypeCode = room.room_type_code
  S.ratePlanCode = rate.rate_plan_code
  S.pricingType = (mapping.pricing_type === 'OBP') ? 'OBP' : 'Standard'
  S.currency = connection?.currency || null

  const roomCount = mapping.room_count || rooms.length
  const rateCount = mapping.rate_count || rooms.reduce((n, r) => n + (r.rates ? r.rates.length : 0), 0)
  const multi = (roomCount > 1 || rateCount > 1)

  setBody(`
    <div class="bk-h">✓ Établissement trouvé</div>
    <div class="bk-sub">Voici ce que HôteSmart va synchroniser avec votre établissement Booking.com :</div>
    <div class="bk-recap">
      <div class="row"><span class="k">Chambre</span><span class="v">${escHtml(room.title || S.roomTypeCode)}<br><span class="hint">type de logement tel que défini sur Booking.com</span></span></div>
      <div class="row"><span class="k">Tarif</span><span class="v">${escHtml(rate.title || S.ratePlanCode)}</span></div>
      ${S.currency ? `<div class="row"><span class="k">Devise</span><span class="v">${escHtml(S.currency)}</span></div>` : ''}
    </div>
    ${multi ? `<div class="bk-note">Votre établissement compte <b>${roomCount} chambre(s)</b> et <b>${rateCount} tarif(s)</b>. HôteSmart relie pour l'instant <b>la première chambre et le premier tarif</b> ci-dessus. Les autres restent gérés dans votre extranet Booking.</div>` : ''}
    <div class="bk-actions">
      <button class="btn btn-primary" id="bk-map">Connecter cet établissement</button>
      <button class="btn" id="bk-back">Retour</button>
    </div>
  `)
  document.getElementById('bk-map').addEventListener('click', screenC)
  document.getElementById('bk-back').addEventListener('click', screenA)
}

function screenBError(msg) {
  setStep(2)
  setBody(`
    <div class="bk-err">${escHtml(msg)}</div>
    <div class="bk-actions">
      <button class="btn btn-primary" id="bk-b-retry">Réessayer</button>
      <button class="btn" id="bk-b-back">Modifier l'ID</button>
    </div>
  `)
  document.getElementById('bk-b-retry').addEventListener('click', screenB)
  document.getElementById('bk-b-back').addEventListener('click', screenA)
}

// ---------- C : liaison (create is_active:false) + activation ----------
async function screenC() {
  setStep(3)
  setBody(`<div class="bk-status"><div class="bk-spin"></div> Liaison de votre établissement…</div>`)

  const pid = S.property.provider_property_id
  try {
    const created = await api.channel.bcom.create(pid, {
      hotelId: S.hotelId,
      roomTypeCode: S.roomTypeCode,
      ratePlanCode: S.ratePlanCode,
      pricingType: S.pricingType,
      dryRun: false
    })
    S.channelId = created?.channel_id
    if (!S.channelId) throw new Error('channel_id manquant apres create')

    setBody(`<div class="bk-status"><div class="bk-spin"></div> Activation et réouverture de vos dates…</div>`)
    const act = await api.channel.bcom.activate(S.channelId, { dryRun: false })
    if (act?.is_active_after !== true) throw new Error('activation non confirmee')

    logger.info('booking-connect', 'create + activate OK', { channelId: S.channelId })
    screenD()
  } catch (e) {
    logger.error('booking-connect', 'liaison echec', { e: e.message })
    setBody(`
      <div class="bk-err">La connexion n'a pas pu être finalisée. Vos tarifs Booking n'ont pas été modifiés. Vous pouvez réessayer.</div>
      <div class="bk-actions">
        <button class="btn btn-primary" id="bk-c-retry">Réessayer</button>
        <button class="btn" id="bk-c-back">Revenir</button>
      </div>
    `)
    document.getElementById('bk-c-retry').addEventListener('click', screenC)
    document.getElementById('bk-c-back').addEventListener('click', screenB)
  }
}

// ---------- D : connecte ----------
function screenD() {
  setStep(4)
  setBody(`
    <div class="bk-ok">✓ Votre établissement Booking.com est connecté</div>
    <div class="bk-sub" style="text-align:center">
      HôteSmart récupère maintenant vos réservations et vos messages, et synchronise votre calendrier avec vos autres canaux. Vos dates ont été rouvertes.
    </div>
    <div class="bk-actions" style="justify-content:center">
      <button class="btn btn-primary" id="bk-finish">Terminé</button>
    </div>
  `)
  document.getElementById('bk-finish').addEventListener('click', close)
}

// ---------- Deja connecte ----------
function screenAlreadyConnected() {
  setStep(4)
  document.getElementById('bk-title').textContent = `Connexion Booking.com — ${S.property.name || ''}`.trim()
  setBody(`
    <div class="bk-ok">✓ Booking.com est déjà connecté</div>
    <div class="bk-sub" style="text-align:center">
      Ce logement est relié à Booking.com. Vos réservations et messages se synchronisent automatiquement.
    </div>
    <div class="bk-actions" style="justify-content:center">
      <button class="btn btn-primary" id="bk-finish">Fermer</button>
      <button class="btn" id="bk-disconnect">Déconnecter</button>
    </div>
  `)
  document.getElementById('bk-finish').addEventListener('click', close)
  document.getElementById('bk-disconnect').addEventListener('click', screenDisconnectConfirm)
}

function screenDisconnectConfirm() {
  setBody(`
    <div class="bk-h">Déconnecter Booking.com ?</div>
    <div class="bk-sub">Votre établissement restera en ligne sur Booking.com, mais HôteSmart ne mettra plus à jour son calendrier automatiquement. Vos réservations déjà reçues sont conservées.</div>
    <div class="bk-actions">
      <button class="btn btn-danger" id="bk-d-yes">Déconnecter</button>
      <button class="btn" id="bk-d-no">Annuler</button>
    </div>
  `)
  document.getElementById('bk-d-no').addEventListener('click', screenAlreadyConnected)
  document.getElementById('bk-d-yes').addEventListener('click', async () => {
    setBody(`<div class="bk-status"><div class="bk-spin"></div> Déconnexion en cours…</div>`)
    try {
      await api.channel.bcom.deactivate(S.channelId, { dryRun: false })
      await api.channel.bcom.remove(S.channelId, { dryRun: false })
      setBody(`
        <div class="bk-ok">✓ Booking.com déconnecté</div>
        <div class="bk-actions" style="justify-content:center">
          <button class="btn btn-primary" id="bk-finish">Fermer</button>
        </div>
      `)
      document.getElementById('bk-finish').addEventListener('click', close)
    } catch (e) {
      logger.error('booking-connect', 'disconnect echec', { e: e.message })
      setBody(`
        <div class="bk-err">La déconnexion n'a pas pu aboutir. Réessayez dans un instant.</div>
        <div class="bk-actions" style="justify-content:center">
          <button class="btn" id="bk-d-back">Retour</button>
        </div>
      `)
      document.getElementById('bk-d-back').addEventListener('click', screenAlreadyConnected)
    }
  })
}

// property = { id, name, provider_property_id }
// opts.existingChannel = { id, is_active } (transmis par le routeur connexions.js si connu)
export function openBookingConnect(property, _anchorEl, { existingChannel = null } = {}) {
  ensureModal()
  S = {
    property,
    hotelId: '',
    channelId: existingChannel?.id || '',
    roomTypeCode: null, ratePlanCode: null, pricingType: 'Standard', currency: null
  }
  document.getElementById('bk-modal').classList.add('show')
  if (existingChannel && existingChannel.is_active === true) screenAlreadyConnected()
  else screenA()
}
