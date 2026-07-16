// components/airbnb-connect.js
// Assistant de connexion Airbnb (remplace l'iframe connexion+mapping).
// Orchestration A -> OAuth -> B -> C -> D :
//   A     : prerequis + bouton "Connecter mon Airbnb"
//   OAuth : iframe channel-connect (seul moment iframe) + polling channels 3s
//   B     : choix de l'annonce (list_listings)
//   C     : map (POST /mappings) puis activate, avec feedback + retry
//   D     : "Connectee" (le webhook channel-events fait le reste)
//
// Le mapping s'adresse par provider_property_id ; l'OAuth par UUID HoteSmart.
// L'appelant passe donc l'objet bien complet { id, name, provider_property_id }.
import { api } from '/shared/api-client.js'
import { logger } from '/shared/logger.js'

let injected = false
let S = null   // etat de la session d'ouverture

const POLL_MS = 3000
const OAUTH_TIMEOUT_MS = 3 * 60 * 1000

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function ensureModal() {
  if (injected) return
  injected = true

  const style = document.createElement('style')
  style.textContent = `
    .ab-modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:none; align-items:center; justify-content:center; z-index:1000; padding:20px; }
    .ab-modal.show { display:flex; }
    .ab-modal-box { background:var(--bg); border-radius:var(--radius-lg); width:100%; max-width:560px; max-height:90vh; display:flex; flex-direction:column; overflow:hidden; }
    .ab-modal-box.wide { max-width:1000px; height:90vh; }
    .ab-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:0.5px solid var(--border); flex-shrink:0; }
    .ab-head .title { font-size:14px; font-weight:500; }
    .ab-steps { display:flex; align-items:center; gap:6px; padding:12px 18px; border-bottom:0.5px solid var(--border); flex-shrink:0; overflow-x:auto; }
    .ab-step { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text2); white-space:nowrap; }
    .ab-step .num { width:18px; height:18px; border-radius:50%; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:10px; flex-shrink:0; }
    .ab-step.active { color:var(--text); font-weight:500; }
    .ab-step.active .num, .ab-step.done .num { background:var(--green); color:#fff; border-color:var(--green); }
    .ab-step-sep { flex:1; height:1px; background:var(--border); min-width:10px; }
    .ab-body { padding:20px; overflow:auto; flex:1; }
    .ab-body.frame { padding:0; display:flex; flex-direction:column; }
    .ab-body.frame iframe { flex:1; border:none; width:100%; }
    .ab-h { font-size:16px; font-weight:500; margin-bottom:6px; }
    .ab-sub { font-size:13px; color:var(--text2); margin-bottom:18px; line-height:1.5; }
    .ab-prereq { list-style:none; padding:0; margin:0 0 20px; }
    .ab-prereq li { display:flex; gap:10px; align-items:flex-start; font-size:13px; padding:8px 0; border-bottom:0.5px solid var(--border); }
    .ab-prereq li span.ic { flex-shrink:0; }
    .ab-list { display:flex; flex-direction:column; gap:8px; margin-bottom:18px; max-height:340px; overflow:auto; }
    .ab-opt { display:flex; align-items:center; gap:10px; padding:11px 13px; border:0.5px solid var(--border); border-radius:var(--radius); cursor:pointer; font-size:13px; }
    .ab-opt:hover { border-color:var(--green); }
    .ab-opt input { cursor:pointer; flex-shrink:0; }
    .ab-thumb { width:44px; height:44px; border-radius:6px; object-fit:cover; flex-shrink:0; }
    .ab-opt-txt { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .ab-opt-sub { font-size:11px; color:var(--text2); word-break:break-all; }
    .ab-opt-disabled { opacity:0.55; cursor:not-allowed; }
    .ab-opt-disabled:hover { border-color:var(--border); }
    .ab-status { display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text2); padding:14px 0; }
    .ab-spin { width:16px; height:16px; border:2px solid var(--border); border-top-color:var(--green); border-radius:50%; animation:ab-rot 0.8s linear infinite; flex-shrink:0; }
    @keyframes ab-rot { to { transform:rotate(360deg); } }
    .ab-err { font-size:13px; color:#C5221F; background:#FCE8E6; border-radius:var(--radius); padding:10px 12px; margin-bottom:16px; line-height:1.5; }
    .ab-ok { font-size:15px; font-weight:500; color:#137333; text-align:center; padding:14px 0; }
    .ab-actions { display:flex; gap:8px; flex-wrap:wrap; }
    @media (max-width:768px){ .ab-modal { padding:0 } .ab-modal-box, .ab-modal-box.wide { height:100vh; max-height:none; border-radius:0; max-width:none } }
  `
  document.head.appendChild(style)

  const modal = document.createElement('div')
  modal.className = 'ab-modal'
  modal.id = 'ab-modal'
  modal.innerHTML = `
    <div class="ab-modal-box" id="ab-box">
      <div class="ab-head">
        <div class="title" id="ab-title">Connexion Airbnb</div>
        <button class="btn" id="ab-close">✕</button>
      </div>
      <div class="ab-steps" id="ab-steps">
        <div class="ab-step" data-step="1"><span class="num">1</span><span>Connexion</span></div>
        <div class="ab-step-sep"></div>
        <div class="ab-step" data-step="2"><span class="num">2</span><span>Votre annonce</span></div>
        <div class="ab-step-sep"></div>
        <div class="ab-step" data-step="3"><span class="num">3</span><span>Liaison</span></div>
        <div class="ab-step-sep"></div>
        <div class="ab-step" data-step="4"><span class="num">4</span><span>Terminé</span></div>
      </div>
      <div class="ab-body" id="ab-body"></div>
    </div>
  `
  document.body.appendChild(modal)
  document.getElementById('ab-close').addEventListener('click', close)
  modal.addEventListener('click', (e) => { if (e.target === modal) close() })
}

function close() {
  if (S?.pollTimer) clearInterval(S.pollTimer)
  if (S?.onMessage) { window.removeEventListener('message', S.onMessage); S.onMessage = null }
  const modal = document.getElementById('ab-modal')
  if (modal) modal.classList.remove('show')
  const box = document.getElementById('ab-box')
  if (box) box.classList.remove('wide')
  const body = document.getElementById('ab-body')
  if (body) { body.classList.remove('frame'); body.innerHTML = '' }
  S = null
}

function setBody(html, { frame = false, wide = false } = {}) {
  const body = document.getElementById('ab-body')
  body.classList.toggle('frame', frame)
  document.getElementById('ab-box').classList.toggle('wide', wide)
  body.innerHTML = html
}

// Fil d'Ariane : 1 Connexion (A+OAuth) · 2 Votre annonce (B) · 3 Liaison (C) · 4 Terminé (D).
// Les etapes < active = "done", l'active = "active". Les ecrans d'erreur conservent l'etape.
function setStep(active) {
  document.querySelectorAll('#ab-steps .ab-step').forEach(el => {
    const n = Number(el.dataset.step)
    el.classList.toggle('done', n < active)
    el.classList.toggle('active', n === active)
  })
}

// ---------- A : prerequis ----------
function screenA() {
  setStep(1)
  document.getElementById('ab-title').textContent = `Connexion Airbnb — ${S.property.name || ''}`.trim()
  setBody(`
    <div class="ab-h">Avant de commencer</div>
    <div class="ab-sub">Pour une connexion réussie, vérifiez ces trois points sur votre compte Airbnb :</div>
    <ul class="ab-prereq">
      <li><span class="ic">📋</span><span>Votre annonce Airbnb est <b>complète et publiée</b> (photos, prix, règlement) — HôteSmart en récupère les détails.</span></li>
      <li><span class="ic">🔌</span><span><b>Aucun autre logiciel de synchronisation</b> n'est déjà relié à cette annonce (cela créerait un conflit).</span></li>
      <li><span class="ic">👤</span><span>Vous vous connecterez au <b>bon compte Airbnb</b> (celui qui possède l'annonce).</span></li>
    </ul>
    <div class="ab-actions">
      <button class="btn btn-primary" id="ab-start">Connecter mon Airbnb</button>
    </div>
  `)
  document.getElementById('ab-start').addEventListener('click', () => startOAuth())
}

// ---------- OAuth : lien direct Airbnb (popup) + retour postMessage ----------
// Airbnb OAuth est une navigation de 1er niveau : on l'ouvre dans une POPUP. Au retour,
// pages/airbnb-retour.html fait postMessage vers cet onglet -> on valide (anti-forge) et
// on reprend a l'ecran B. Repli PLEINE PAGE si la popup est bloquee. Polling channels =
// filet si le postMessage n'arrive pas (popup fermee a la main).
// reuseChannelId : flux de re-connexion (ajoute le bien a un canal Airbnb existant).
async function startOAuth(reuseChannelId = '') {
  setBody(`<div class="ab-status"><div class="ab-spin"></div> Préparation de la connexion…</div>`)
  let data
  try {
    data = await api.channel.airbnbConnect(S.property.id, reuseChannelId ? { channelId: reuseChannelId } : {})
    if (!data?.oauth_url) throw new Error(data?.error || 'oauth_url absent')
  } catch (e) {
    logger.error('airbnb-connect', 'airbnbConnect echec', { e: e.message })
    return showOAuthError('La connexion à Airbnb n\'a pas pu démarrer.')
  }

  attachReturnListener()
  const popup = window.open(data.oauth_url, 'airbnb_oauth', 'width=520,height=760')
  const blocked = !popup || popup.closed || typeof popup.closed === 'undefined'

  if (blocked) {
    // Repli PLEINE PAGE : le retour reviendra sur biens.html?airbnb_return=1.
    setBody(`
      <div class="ab-status"><div class="ab-spin"></div> Redirection vers Airbnb…</div>
      <div class="ab-sub">Si rien ne se passe, <a href="${escHtml(data.oauth_url)}">cliquez ici pour continuer sur Airbnb</a>.</div>
    `)
    window.location.href = data.oauth_url
    return
  }

  setBody(`
    <div class="ab-h">Autorisez HôteSmart sur Airbnb</div>
    <div class="ab-sub">Une fenêtre Airbnb s'est ouverte. Connectez-vous et autorisez l'accès. Cette page se mettra à jour automatiquement au retour.</div>
    <div class="ab-status"><div class="ab-spin"></div> En attente de votre autorisation…</div>
    <div class="ab-actions">
      <button class="btn" id="ab-reopen">Rouvrir la fenêtre Airbnb</button>
    </div>
  `)
  document.getElementById('ab-reopen').addEventListener('click', () => window.open(data.oauth_url, 'airbnb_oauth'))

  // Filet : si le postMessage n'arrive pas, on detecte le canal par polling.
  S.pollDeadline = Date.now() + OAUTH_TIMEOUT_MS
  S.pollTimer = setInterval(() => checkChannels(false), POLL_MS)
}

// Ecoute le retour de pages/airbnb-retour.html (postMessage meme origine).
function attachReturnListener() {
  if (S.onMessage) return
  S.onMessage = async (ev) => {
    if (ev.origin !== window.location.origin) return
    const d = ev.data
    if (!d || d.source !== 'hotesmart-airbnb-return') return
    window.removeEventListener('message', S.onMessage)
    S.onMessage = null
    if (S.pollTimer) clearInterval(S.pollTimer)
    if (!d.ok || !d.token) {
      return showOAuthError('La connexion Airbnb a échoué ou a été refusée.')
    }
    try {
      const v = await api.channel.airbnbValidate(d.token, d.channelId)
      S.channelId = v.channel_id
      S.channelActive = v.channel_is_active === true
      logger.info('airbnb-connect', 'retour Airbnb valide', { channelId: S.channelId })
      screenB()
    } catch (e) {
      logger.error('airbnb-connect', 'validate retour echec', { e: e.message })
      showOAuthError('Le retour d\'Airbnb n\'a pas pu être validé. Réessayez.')
    }
  }
  window.addEventListener('message', S.onMessage)
}

async function checkChannels(manual) {
  try {
    const r = await api.channel.mapping.channels(S.property.provider_property_id)
    if ((r?.channel_count || 0) > 0) {
      if (S.pollTimer) clearInterval(S.pollTimer)
      S.channelId = r.channels[0].id
      S.channelActive = r.channels[0].is_active === true
      logger.info('airbnb-connect', 'canal detecte', { channelId: S.channelId })
      return screenB()
    }
  } catch (e) {
    logger.error('airbnb-connect', 'poll channels echec', { e: e.message })
  }
  if (manual) {
    // Clic "j'ai terminé" sans canal detecte : indice, on continue le polling.
    const s = document.querySelector('.ab-status')
    if (s) s.innerHTML = `<div class="ab-spin"></div> Connexion pas encore détectée — laissez la fenêtre ouverte quelques secondes.`
  }
  if (Date.now() > S.pollDeadline) {
    if (S.pollTimer) clearInterval(S.pollTimer)
    showOAuthError('Connexion non détectée après 3 minutes.')
  }
}

function showOAuthError(msg) {
  setBody(`
    <div class="ab-err">${escHtml(msg)}</div>
    <div class="ab-sub">Vérifiez que vous avez bien autorisé HôteSmart dans la fenêtre Airbnb, puis réessayez.</div>
    <div class="ab-actions">
      <button class="btn btn-primary" id="ab-retry">Réessayer</button>
      <button class="btn" id="ab-cancel">Annuler</button>
    </div>
  `)
  document.getElementById('ab-retry').addEventListener('click', detectAndRoute)
  document.getElementById('ab-cancel').addEventListener('click', close)
}

// ---------- B : choix de l'annonce ----------
// Ville/adresse pour distinguer 2 annonces similaires (champs best-effort : la shape
// exacte de action/listings est confirmee au test, on tolere l'absence).
function pickCity(o) {
  if (!o || typeof o !== 'object') return ''
  const a = o.address || {}
  return o.city || o.town || a.city || a.town
    || [a.street, a.city].filter(Boolean).join(', ')
    || (typeof o.address === 'string' ? o.address : '')
    || (typeof o.location === 'string' ? o.location : '') || ''
}
function pickThumb(o) {
  if (!o || typeof o !== 'object') return ''
  const p = o.pictures || o.photos
  const first = Array.isArray(p) ? (p[0]?.url || p[0]?.thumbnail_url || p[0]) : ''
  return o.thumbnail || o.thumbnail_url || o.picture || o.photo || o.image || first || ''
}
function normListings(raw) {
  // Forme reelle action/listings : { values: [ {id,title,type,...} ] } -> on deballe.
  if (raw && !Array.isArray(raw) && Array.isArray(raw.values)) raw = raw.values
  const mk = (id, v) => {
    const o = (v && typeof v === 'object') ? v : {}
    const label = typeof v === 'string' ? v : (o.title || o.name || o.label || String(id))
    return {
      id: String(id), label: String(label),
      type: String(o.type || ''),
      city: String(pickCity(o) || ''), thumb: String(pickThumb(o) || '')
    }
  }
  if (Array.isArray(raw)) {
    return raw.map(x => {
      const id = x.id || x.listing_id || x.value
      return id ? mk(id, x) : null
    }).filter(Boolean)
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([id, v]) => mk(id, v))
  }
  return []
}

async function screenB() {
  setStep(2)
  setBody(`<div class="ab-status"><div class="ab-spin"></div> Récupération de vos annonces Airbnb…</div>`)
  let listings, mapped
  try {
    const r = await api.channel.mapping.actionListings(S.property.provider_property_id, S.channelId)
    listings = normListings(r?.listings)
    mapped = new Set((r?.mapped_listing_ids || []).map(String))
  } catch (e) {
    logger.error('airbnb-connect', 'list_listings echec', { e: e.message })
    return screenBError('Impossible de récupérer vos annonces Airbnb pour le moment. Réessayez dans un instant.')
  }
  if (!listings.length) {
    return screenBError('Aucune annonce trouvée sur ce compte Airbnb.')
  }
  // Multi-biens : les annonces deja reliees a un autre logement sont grisees (non
  // selectionnables) -> l'hote ne peut pas re-mapper listing1 par erreur.
  const selectable = listings.filter(l => !mapped.has(String(l.id)))
  if (!selectable.length) {
    return screenBError('Toutes les annonces de ce compte Airbnb sont déjà reliées à un logement.')
  }

  const opts = listings.map((l, i) => {
    const isMapped = mapped.has(String(l.id))
    return `
    <label class="ab-opt${isMapped ? ' ab-opt-disabled' : ''}">
      <input type="radio" name="ab-listing" value="${escHtml(l.id)}" data-idx="${i}"${isMapped ? ' disabled' : ''}>
      ${l.thumb ? `<img class="ab-thumb" src="${escHtml(l.thumb)}" alt="" onerror="this.remove()">` : ''}
      <span class="ab-opt-txt">
        <b>${escHtml(l.label)}</b>
        <span class="ab-opt-sub">#${escHtml(l.id)}${l.type ? ' · ' + escHtml(l.type) : ''}${l.city ? ' · ' + escHtml(l.city) : ''}${isMapped ? ' · déjà reliée' : ''}</span>
      </span>
    </label>`
  }).join('')

  setBody(`
    <div class="ab-h">Choisissez votre annonce</div>
    <div class="ab-sub">Sélectionnez l'annonce Airbnb à relier à votre logement. Vérifiez l'identifiant et la ville pour ne pas vous tromper d'annonce.</div>
    <div class="ab-list">${opts}</div>
    <div class="ab-actions">
      <button class="btn btn-primary" id="ab-continue" disabled>Continuer</button>
    </div>
  `)
  const cont = document.getElementById('ab-continue')
  document.querySelectorAll('input[name="ab-listing"]').forEach(r =>
    r.addEventListener('change', () => { S.listingId = r.value; cont.disabled = false }))
  cont.addEventListener('click', screenC)
}

function screenBError(msg) {
  setBody(`
    <div class="ab-err">${escHtml(msg)}</div>
    <div class="ab-actions">
      <button class="btn btn-primary" id="ab-b-retry">Réessayer</button>
      <button class="btn" id="ab-cancel">Annuler</button>
    </div>
  `)
  document.getElementById('ab-b-retry').addEventListener('click', screenB)
  document.getElementById('ab-cancel').addEventListener('click', close)
}

// ---------- C : mapping + activation ----------
async function screenC() {
  setStep(3)
  const pid = S.property.provider_property_id
  setBody(`<div class="ab-status"><div class="ab-spin"></div> Liaison de votre annonce…</div>`)
  try {
    // Re-connexion sur un canal DEJA actif (2e bien meme compte) : le mapping additif est
    // legitime -> force=1 pour outrepasser le garde-fou "canal actif".
    const m = await api.channel.mapping.map(pid, S.channelId, S.listingId, { dryRun: false, force: S.channelActive === true })
    if (!m?.rate_plans_populated) {
      throw new Error('rate_plans vide apres map (mapping non pris)')   // signal interne (logs)
    }
    setBody(`<div class="ab-status"><div class="ab-spin"></div> Finalisation de la connexion…</div>`)
    // activate est idempotent cote serveur (no-op si deja actif) -> sur d'appeler.
    await api.channel.mapping.activate(pid, S.channelId, { dryRun: false })
    // Post-mapping : tire les resas de CE listing (indispensable quand le listing rejoint un
    // canal deja actif : le webhook activate_channel ne refire pas). Best-effort.
    try { await api.channel.mapping.loadReservations(pid, S.channelId, S.listingId) }
    catch (e) { logger.error('airbnb-connect', 'load_future_reservations echec', { e: e.message }) }
    logger.info('airbnb-connect', 'mapping + activation OK', { channelId: S.channelId, listingId: S.listingId })
    screenD()
  } catch (e) {
    logger.error('airbnb-connect', 'map/activate echec', { e: e.message })
    setBody(`
      <div class="ab-err">Votre annonce n'a pas pu être reliée. Vérifiez qu'elle est complète et publiée sur Airbnb, puis réessayez.</div>
      <div class="ab-sub">Vous pouvez réessayer, ou choisir une autre annonce.</div>
      <div class="ab-actions">
        <button class="btn btn-primary" id="ab-c-retry">Réessayer</button>
        <button class="btn" id="ab-c-back">Choisir une autre annonce</button>
      </div>
    `)
    document.getElementById('ab-c-retry').addEventListener('click', screenC)
    document.getElementById('ab-c-back').addEventListener('click', screenB)
  }
}

// ---------- D : connectee ----------
function screenD() {
  setStep(4)
  setBody(`
    <div class="ab-ok">✓ Votre annonce est connectée</div>
    <div class="ab-sub" style="text-align:center">
      HôteSmart récupère maintenant vos réservations et messages en arrière-plan.
      Vous pouvez fermer cette fenêtre.
    </div>
    <div class="ab-actions" style="justify-content:center">
      <button class="btn btn-primary" id="ab-finish">Terminé</button>
    </div>
  `)
  document.getElementById('ab-finish').addEventListener('click', close)
}

// ---------- Deja connectee (bien avec un canal actif : protege Colomiers) ----------
function screenAlreadyConnected() {
  setStep(4)
  setBody(`
    <div class="ab-ok">✓ Votre annonce est déjà connectée</div>
    <div class="ab-sub" style="text-align:center">
      Ce logement est relié à Airbnb. Vos réservations et messages se synchronisent automatiquement.
    </div>
    <div class="ab-actions" style="justify-content:center">
      <button class="btn btn-primary" id="ab-finish">Fermer</button>
      <button class="btn" id="ab-disconnect">Déconnecter cette annonce</button>
    </div>
  `)
  document.getElementById('ab-finish').addEventListener('click', close)
  document.getElementById('ab-disconnect').addEventListener('click', screenDisconnectConfirm)
}

// ---------- Deconnexion : confirmation -> action -> succes/erreur ----------
function screenDisconnectConfirm() {
  setBody(`
    <div class="ab-h">Déconnecter cette annonce ?</div>
    <div class="ab-sub">Votre annonce restera en ligne sur Airbnb, mais HôteSmart ne mettra plus à jour ses prix ni son calendrier automatiquement. Vos réservations déjà reçues sont conservées. Vous pourrez la reconnecter plus tard — Airbnb vous redemandera alors votre autorisation.</div>
    <div class="ab-actions">
      <button class="btn btn-primary" id="ab-disc-yes">Déconnecter</button>
      <button class="btn" id="ab-disc-no">Annuler</button>
    </div>
  `)
  document.getElementById('ab-disc-yes').addEventListener('click', doDisconnect)
  document.getElementById('ab-disc-no').addEventListener('click', screenAlreadyConnected)
}

async function doDisconnect() {
  setBody(`<div class="ab-status"><div class="ab-spin"></div> Déconnexion en cours…</div>`)
  try {
    const r = await api.channel.mapping.disconnect(S.property.provider_property_id, S.channelId)
    // Succes REEL uniquement : au moins un mapping retire, ou canal supprime. Sinon -> erreur
    // (protege contre un 2xx sans effet).
    const realSuccess = (r?.unmapped > 0) || r?.channel_deleted === true
    if (!realSuccess) throw new Error(r?.error || 'Déconnexion sans effet')
    logger.info('airbnb-connect', 'deconnexion OK', { channelId: S.channelId, unmapped: r.unmapped, channelDeleted: r.channel_deleted })
    setBody(`
      <div class="ab-ok">✓ Annonce déconnectée</div>
      <div class="ab-sub" style="text-align:center">C'est fait. Cette annonce n'est plus synchronisée par HôteSmart et reste en ligne sur Airbnb. Vous pouvez maintenant supprimer ce logement si vous le souhaitez.</div>
      <div class="ab-actions" style="justify-content:center">
        <button class="btn btn-primary" id="ab-finish">Fermer</button>
      </div>
    `)
    document.getElementById('ab-finish').addEventListener('click', close)
  } catch (e) {
    logger.error('airbnb-connect', 'deconnexion echec', { e: e.message })
    setBody(`
      <div class="ab-err">La déconnexion n'a pas pu aboutir. Réessayez dans un instant ; si le problème persiste, contactez le support.</div>
      <div class="ab-actions">
        <button class="btn btn-primary" id="ab-disc-retry">Réessayer</button>
        <button class="btn" id="ab-disc-close">Fermer</button>
      </div>
    `)
    document.getElementById('ab-disc-retry').addEventListener('click', doDisconnect)
    document.getElementById('ab-disc-close').addEventListener('click', close)
  }
}

// Detecte l'etat du bien : canal actif -> deja connecte ; canal present mais inactif ->
// reprise directe au choix de l'annonce (OAuth deja fait) ; aucun canal sur CE bien mais un
// canal Airbnb existe sur le compte (autre bien) -> choix reutiliser/nouveau ; sinon flux complet.
async function detectAndRoute() {
  setBody(`<div class="ab-status"><div class="ab-spin"></div> Vérification de la connexion…</div>`)
  try {
    const r = await api.channel.mapping.channels(S.property.provider_property_id)
    const chans = r?.channels || []
    const active = chans.find(c => c.is_active)
    if (active) { S.channelId = active.id; S.channelActive = true; return screenAlreadyConnected() }
    if (chans.length) { S.channelId = chans[0].id; S.channelActive = false; return screenB() }   // OAuth fait, mapping a finir
    // Aucun canal sur ce bien : le compte a-t-il deja une connexion Airbnb (autre bien) ?
    try {
      const acc = await api.channel.airbnbAccountStatus(S.property.id)
      const existing = acc?.existing_channels || []
      if (existing.length) return screenChooseConnection(existing)
    } catch (e) {
      logger.error('airbnb-connect', 'account_status echec', { e: e.message })
      // detection compte KO : on retombe sur le flux complet, sans rien casser.
    }
  } catch (e) {
    logger.error('airbnb-connect', 'detect status echec', { e: e.message })
    // En cas d'echec de detection : on retombe sur le flux complet (screenA), sans rien casser.
  }
  screenA()
}

// ---------- Choix : reutiliser un compte Airbnb existant OU en connecter un autre ----------
function screenChooseConnection(channels) {
  setStep(1)
  const opts = channels.map((c, i) => `
    <label class="ab-opt">
      <input type="radio" name="ab-conn" value="${escHtml(c.id)}" data-idx="${i}" data-active="${c.is_active ? '1' : '0'}">
      <span class="ab-opt-txt">
        <b>${escHtml(c.title)}</b>
        <span class="ab-opt-sub">Connexion Airbnb existante${c.via_property ? ' · ' + escHtml(c.via_property) : ''}${c.is_active ? ' · active' : ''}</span>
      </span>
    </label>
  `).join('')

  setBody(`
    <div class="ab-h">Vous avez déjà un compte Airbnb connecté</div>
    <div class="ab-sub">Réutilisez cette connexion pour y ajouter ce logement, ou connectez un autre compte Airbnb.</div>
    <div class="ab-list">${opts}</div>
    <div class="ab-actions">
      <button class="btn btn-primary" id="ab-reuse" disabled>Réutiliser cette connexion</button>
      <button class="btn" id="ab-newconn">Connecter un autre compte</button>
    </div>
  `)
  const reuse = document.getElementById('ab-reuse')
  document.querySelectorAll('input[name="ab-conn"]').forEach(r =>
    r.addEventListener('change', () => {
      S.reuseChannelId = r.value
      S.channelActive = r.dataset.active === '1'
      reuse.disabled = false
    }))
  reuse.addEventListener('click', () => startOAuth(S.reuseChannelId))
  document.getElementById('ab-newconn').addEventListener('click', () => { S.channelActive = false; startOAuth() })
}

// Point d'entree. property = { id (UUID HoteSmart), name, provider_property_id }.
export async function openAirbnbConnect(property, btn = null) {
  if (!property?.id || !property?.provider_property_id) {
    alert('Ce logement n\'est pas encore prêt pour la connexion Airbnb.')
    return
  }
  ensureModal()
  S = { property, channelId: null, listingId: null, pollTimer: null, pollDeadline: 0, onMessage: null, channelActive: false, reuseChannelId: null }
  document.getElementById('ab-title').textContent = `Connexion Airbnb — ${property.name || ''}`.trim()
  document.getElementById('ab-modal').classList.add('show')
  detectAndRoute()
}

// Repli PLEINE PAGE : appele au chargement de biens.html. Si on revient d'Airbnb
// (?airbnb_return=1 + sessionStorage), on resout le bien VIA LE TOKEN (validate,
// resolution serveur par token — pas la session) et on rouvre l'assistant a l'ecran B.
export async function bootstrapAirbnbReturn() {
  const url = new URL(window.location.href)
  if (url.searchParams.get('airbnb_return') !== '1') return

  let ret = null
  try { ret = JSON.parse(sessionStorage.getItem('airbnb_return') || 'null') } catch (e) {}
  sessionStorage.removeItem('airbnb_return')
  url.searchParams.delete('airbnb_return')
  window.history.replaceState({}, '', url.pathname + url.search)

  if (!ret || !ret.ok || !ret.token) return   // echec/refus : l'hote reprend manuellement

  try {
    const v = await api.channel.airbnbValidate(ret.token, ret.channelId)
    const property = { id: v.property_id, name: v.name, provider_property_id: v.provider_property_id }
    ensureModal()
    S = { property, channelId: v.channel_id, listingId: null, pollTimer: null, pollDeadline: 0, onMessage: null, channelActive: v.channel_is_active === true, reuseChannelId: null }
    document.getElementById('ab-title').textContent = `Connexion Airbnb — ${property.name || ''}`.trim()
    document.getElementById('ab-modal').classList.add('show')
    screenB()
  } catch (e) {
    logger.error('airbnb-connect', 'bootstrap retour echec', { e: e.message })
  }
}
