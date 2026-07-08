// components/channel-modal.js
// Modal iframe marque blanche pour connecter / mapper les annonces OTA d'un bien.
// Ouvre la page /channels du gestionnaire de canaux (redirect_to=/channels), qui
// gere a la fois la connexion des canaux ET le mapping listing <-> room/rate plan.
// Reutilise l'endpoint channel-connect (aucune cle ni token expose cote front).
//
// Classes prefixees `cx-` pour ne pas collisionner avec la modal `.ota-modal`
// de pages/connexions.html (flux existant laisse intact).
import { api } from '/shared/api-client.js'
import { logger } from '/shared/logger.js'

let injected = false

// Injecte le CSS + le markup de la modal une seule fois dans le document.
function ensureModal() {
  if (injected) return
  injected = true

  const style = document.createElement('style')
  style.textContent = `
    .cx-modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:none; align-items:center; justify-content:center; z-index:1000; padding:20px; }
    .cx-modal.show { display:flex; }
    .cx-modal-box { background:var(--bg); border-radius:var(--radius-lg); width:100%; max-width:1100px; height:90vh; display:flex; flex-direction:column; overflow:hidden; }
    .cx-modal-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:0.5px solid var(--border); }
    .cx-modal-head .title { font-size:14px; font-weight:500; }
    .cx-modal-box iframe { flex:1; border:none; width:100%; }
    @media (max-width:768px){ .cx-modal { padding:0 } .cx-modal-box { height:100vh; border-radius:0; max-width:none } }
  `
  document.head.appendChild(style)

  const modal = document.createElement('div')
  modal.className = 'cx-modal'
  modal.id = 'cx-modal'
  modal.innerHTML = `
    <div class="cx-modal-box">
      <div class="cx-modal-head">
        <div class="title" id="cx-modal-title">Mes plateformes</div>
        <button class="btn" id="cx-modal-close">✕ Terminé</button>
      </div>
      <iframe id="cx-modal-iframe" src="about:blank" title="Connexion et mapping des plateformes" allow="clipboard-read; clipboard-write"></iframe>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => {
    modal.classList.remove('show')
    document.getElementById('cx-modal-iframe').src = 'about:blank'
  }
  document.getElementById('cx-modal-close').addEventListener('click', close)
  modal.addEventListener('click', (e) => { if (e.target === modal) close() })
}

// Ouvre la modal iframe (connexion + mapping) pour le bien donne.
// propertyId   : UUID HoteSmart du bien (l'endpoint verifie l'ownership).
// propertyName : libelle affiche dans l'en-tete (optionnel).
// btn          : bouton declencheur, desactive pendant la preparation (optionnel).
export async function openChannelModal(propertyId, propertyName = '', btn = null) {
  ensureModal()
  let old
  if (btn) { btn.disabled = true; old = btn.textContent; btn.textContent = '⏳ Préparation…' }
  try {
    const data = await api.channel.connect(propertyId)
    if (!data || !data.iframe_url) throw new Error((data && data.error) || 'Erreur de connexion')

    document.getElementById('cx-modal-title').textContent = `Mes plateformes — ${propertyName}`.trim()
    document.getElementById('cx-modal-iframe').src = data.iframe_url
    document.getElementById('cx-modal').classList.add('show')
    logger.info('channel-modal', 'Iframe ouverte', { propertyId })
  } catch (e) {
    logger.error('channel-modal', e.message, { propertyId })
    alert("Impossible d'ouvrir la connexion des plateformes : " + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old }
  }
}
