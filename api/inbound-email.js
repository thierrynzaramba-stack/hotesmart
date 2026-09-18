// api/inbound-email.js
// DOC : docs/kb/guestflow.md (modif = MEME COMMIT)
// Chantier « inbound e-mail » — etapes 4 et 5.
//
// LES REPONSES DES VOYAGEURS ENTRENT DANS LE CŒUR.
//
// Brevo POSTe ici quand un e-mail arrive sur `*@reply.hotesmart.fr`.
//
// ⚠ CE WEBHOOK N'EST PAS AUTHENTIFIABLE, DONC ON NE LE CROIT PAS.
// Channex accepte un en-tete personnalise (`X-Channel-Webhook-Secret`) ; Brevo
// n'en propose aucun, et un secret glisse dans l'URL fuirait dans les journaux.
// La reponse n'est pas de filtrer mieux : c'est de ne rien tirer du corps recu.
//
// Le POST ne sert que de DECLENCHEUR. Le contenu, on va le relire chez Brevo
// avec NOTRE cle (`GET /inbound/events/<uuid>`). Un faux POST ne peut donc rien
// injecter : au pire il nous fait relire un e-mail qui existe, ou aucun.
// C'est la regle 11 prise au mot — la ressource se construit cote serveur.
//
// ⚠ ET LE COMPTE NE VIENT JAMAIS DU MESSAGE. Il vient du jeton signe de
// l'adresse de reponse, resolu en base. Un expediteur choisit ce qu'il ecrit,
// pas a qui il l'ecrit.

const { createClient } = require('@supabase/supabase-js')
const { bookingDepuisAdresse, estAdresseDeReponse, compacter } = require('../lib/jeton-reponse')
const { recordMessage } = require('../lib/record-message')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const CLE_BREVO = process.env.ALERT_BREVO_API_KEY

// ─── Ce qui ne doit JAMAIS reveiller l'agent ────────────────────────────────
// ⚠ UNE REPONSE AUTOMATIQUE QUI DECLENCHE UNE REPONSE AUTOMATIQUE EST UNE
// BOUCLE, et elle tourne aussi vite que les deux serveurs le permettent.
// L'agent IA lit `messages` : tout ce qu'on ecrit la peut le faire parler. Un
// « je suis en vacances » de la boite du voyageur n'attend pas de reponse.
//
// Les en-tetes qui le disent sont normalises (RFC 3834 pour `Auto-Submitted`,
// usage etabli pour les autres) : on s'y fie plutot qu'a une heuristique sur le
// sujet, qui varierait avec la langue.
const ENTETES_AUTOMATIQUES = [
  ['auto-submitted', v => v && v.toLowerCase() !== 'no'],
  ['x-autoreply', () => true],
  ['x-autorespond', () => true],
  ['x-auto-response-suppress', () => true],
  ['precedence', v => /bulk|junk|list|auto_reply/i.test(v)],
  ['list-id', () => true],
  ['list-unsubscribe', () => true],
  ['x-loop', () => true]
]
const SCORE_SPAM_MAX = 5

function entetes (evenement) {
  // Brevo rend `Headers` tantot objet, tantot tableau de paires : on aplatit en
  // minuscules, et une cle vue plusieurs fois garde toutes ses valeurs.
  const out = {}
  const poser = (k, v) => {
    const cle = String(k || '').toLowerCase()
    if (!cle) return
    out[cle] = out[cle] ? `${out[cle]} ${v}` : String(v == null ? '' : v)
  }
  const h = evenement?.Headers || evenement?.headers
  if (Array.isArray(h)) for (const e of h) poser(e?.Name ?? e?.name ?? e?.[0], e?.Value ?? e?.value ?? e?.[1])
  else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) poser(k, v)
  return out
}

function motifAutomatique (evenement) {
  const h = entetes(evenement)
  for (const [cle, test] of ENTETES_AUTOMATIQUES) {
    if (h[cle] !== undefined && test(h[cle])) return `en-tete ${cle}`
  }
  const score = Number(evenement?.Spam?.Score ?? evenement?.spam?.score)
  if (Number.isFinite(score) && score >= SCORE_SPAM_MAX) return `score de spam ${score}`
  return null
}

// ─── Le corps utile ─────────────────────────────────────────────────────────
// ⚠ LE MESSAGE, PAS LA CONVERSATION ENTIERE. Brevo detache la signature et les
// citations (`ExtractedMarkdownMessage`) : sans ca, chaque reponse rapporterait
// tout le fil precedent, que l'agent IA relirait comme une nouvelle question.
function corpsUtile (e) {
  const candidats = [e?.ExtractedMarkdownMessage, e?.RawTextBody, e?.RawHtmlBody]
  for (const c of candidats) {
    const t = String(c || '').trim()
    if (t) return t.slice(0, 20000)
  }
  return ''
}

const premiereAdresse = v => {
  if (!v) return ''
  if (Array.isArray(v)) return String(v[0]?.Address || v[0]?.address || v[0] || '')
  if (typeof v === 'object') return String(v.Address || v.address || '')
  return String(v)
}

// ─── La relecture chez Brevo, seule source de verite ────────────────────────
async function relireChezBrevo (uuid) {
  if (!CLE_BREVO) return { ok: false, raison: 'cle_plateforme_absente' }
  const chemin = uuid
    ? `/inbound/events/${encodeURIComponent(uuid)}`
    : '/inbound/events?limit=5'
  try {
    const r = await fetch('https://api.brevo.com/v3' + chemin, { headers: { 'api-key': CLE_BREVO } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, raison: `brevo_${r.status}` }
    // Le detail rend l'evenement ; la liste rend `{ events: [...] }`.
    const e = Array.isArray(j?.events) ? j.events[0] : (j?.event || j)
    if (!e) return { ok: false, raison: 'evenement_introuvable' }
    return { ok: true, evenement: e }
  } catch (err) {
    return { ok: false, raison: `brevo_injoignable: ${err.message}` }
  }
}

// ─── La file des non-rattachables ───────────────────────────────────────────
// ⚠ UN E-MAIL QU'ON NE SAIT PAS RANGER NE SE JETTE PAS. Un voyageur qui repond
// depuis une autre adresse, ou dont le client mail a mange l'adresse de
// reponse, disparaitrait en silence — et l'hote ne saurait jamais qu'on lui a
// ecrit. Il atterrit donc dans la to-do, la ou l'hote regarde deja.
async function mettreEnAttente ({ userId, propertyId, de, sujet, corps, raison }) {
  try {
    const { error } = await supabase.from('agent_tasks').insert({
      user_id: userId || null,
      property_id: propertyId ? String(propertyId) : null,
      book_id: null,
      guest_name: de || 'Expéditeur inconnu',
      guest_message: corps ? corps.slice(0, 2000) : '',
      task_type: 'email_non_rattache',
      summary: `E-mail reçu sans réservation identifiable (${raison})`
        + (sujet ? ` — « ${String(sujet).slice(0, 80)} »` : ''),
      suggested_reply: null,
      status: 'pending_validation',
      sub_tasks: []
    })
    if (error) console.error('[inbound-email] mise en attente echec', error.message)
    return !error
  } catch (e) {
    console.error('[inbound-email] mise en attente exception', e.message)
    return false
  }
}

module.exports = async function handler (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })

  // ⚠ ON ACQUITTE TOUJOURS EN 200, MEME QUAND ON NE FAIT RIEN.
  // Un webhook qui rend 4xx/5xx fait rejouer Brevo, encore et encore, sur un
  // e-mail qu'on a deja decide d'ignorer. Ce qu'on ne traite pas se JOURNALISE
  // — ca ne se renvoie pas au facteur.
  const fini = (raison, extra = {}) => {
    if (raison !== 'ok') console.log('[inbound-email]', raison, JSON.stringify(extra).slice(0, 200))
    return res.status(200).json({ ok: true, reason: raison, ...extra })
  }

  try {
    // Du corps recu, on ne retient QU'UN INDICE : de quel e-mail Brevo parle.
    const brut = req.body || {}
    const item = Array.isArray(brut.items) ? brut.items[0] : brut
    const uuid = item?.Uuid || item?.uuid || item?.MessageId || item?.messageId || null

    const lu = await relireChezBrevo(uuid)
    if (!lu.ok) return fini('relecture_impossible', { raison: lu.raison })
    const e = lu.evenement

    // 1. Ce qui ne doit jamais reveiller l'agent.
    const auto = motifAutomatique(e)
    if (auto) return fini('automatique_ignore', { motif: auto })

    // 2. De quelle reservation s'agit-il ? Du JETON, jamais du message.
    const destinataires = []
    for (const champ of [e.To, e.to, e.Cc, e.cc]) {
      if (Array.isArray(champ)) champ.forEach(x => destinataires.push(premiereAdresse([x])))
      else if (champ) destinataires.push(premiereAdresse(champ))
    }
    const cible = destinataires.find(a => estAdresseDeReponse(a))
    const expediteur = premiereAdresse(e.From || e.from)
    const sujet = e.Subject || e.subject || ''
    const corps = corpsUtile(e)

    if (!cible) {
      await mettreEnAttente({ de: expediteur, sujet, corps, raison: 'aucune adresse de réponse' })
      return fini('sans_adresse_de_reponse')
    }
    const jeton = bookingDepuisAdresse(cible)
    if (!jeton.ok) {
      await mettreEnAttente({ de: expediteur, sujet, corps, raison: `jeton ${jeton.raison}` })
      return fini('jeton_refuse', { raison: jeton.raison })
    }

    // 3. La reservation, resolue EN BASE. C'est elle qui designe le compte et
    // le bien — jamais le message.
    //
    // ⚠ UNE REQUETE CIBLEE, PAS UN BALAYAGE. Le jeton porte l'identifiant
    // COMPACTE (sans tirets) ; la premiere version relisait 1000 lignes de
    // `bookings_snapshot` pour y chercher la bonne — couteux, faux au-dela de
    // 1000 (PostgREST tronque SANS ERREUR), et precisement la lecture que
    // `tests/bookings-snapshot-troncature.test.js` surveille.
    //
    // On reconstruit donc les formes possibles. Replacer les tirets « au bon
    // endroit » serait un pari si on le faisait a l'aveugle : on ne le fait QUE
    // sur 32 caracteres hexadecimaux, ou la forme canonique d'un UUID est sans
    // ambiguite. Un identifiant Beds24, numerique, passe tel quel.
    const candidats = [jeton.bookingCompact]
    if (/^[0-9a-f]{32}$/.test(jeton.bookingCompact)) {
      const c = jeton.bookingCompact
      candidats.push(`${c.slice(0, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}-${c.slice(16, 20)}-${c.slice(20)}`)
    }
    const { data: lignes, error: eLect } = await supabase
      .from('bookings_snapshot')
      .select('user_id, booking_id, property_id, snapshot')
      .in('booking_id', candidats)
      .limit(2)
    if (eLect) return fini('lecture_impossible', { raison: eLect.message })

    // ⚠ DEUX LIGNES = DEUX COMPTES POSSIBLES. `booking_id` n'est unique que par
    // compte : repondre au hasard ferait entrer le message d'un voyageur dans le
    // fil d'un autre hote. On refuse et on met en attente.
    if ((lignes || []).length > 1) {
      await mettreEnAttente({ de: expediteur, sujet, corps, raison: 'réservation ambiguë' })
      return fini('reservation_ambigue')
    }
    const resa = (lignes || [])[0]
    if (!resa) {
      await mettreEnAttente({ de: expediteur, sujet, corps, raison: 'réservation introuvable' })
      return fini('reservation_introuvable')
    }

    // 4. Le cœur : le fil de l'hote, et la table que l'agent IA lit.
    const s = resa.snapshot || {}
    const nom = [s.firstName, s.lastName].filter(Boolean).join(' ') || 'Voyageur'

    // Dedup : Brevo peut rejouer un webhook. Meme corps, meme reservation, deux
    // minutes — c'est le meme e-mail.
    const depuis = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const { data: dejaVu } = await supabase.from('messages')
      .select('id').eq('user_id', resa.user_id).eq('booking_id', resa.booking_id)
      .eq('direction', 'inbound').eq('body', corps)
      .gte('created_at', depuis).limit(1)
    if (dejaVu && dejaVu.length) return fini('duplique')

    await supabase.from('conversations').insert({
      user_id: resa.user_id,
      property_id: String(resa.property_id),
      guest_name: nom,
      guest_message: corps,
      agent_reply: null,
      book_id: String(resa.booking_id)
    })

    await recordMessage({
      userId: resa.user_id,
      provider: s.provider || 'channex',
      propertyId: resa.property_id,
      bookingId: resa.booking_id,
      direction: 'inbound',
      sender: 'guest',
      body: corps,
      providerMsgId: uuid || null,
      ota: s.source || null,
      sentAt: e.Date || e.date || null,
      kind: 'message',
      canal: 'email'
    })

    return fini('ok', { booking: String(resa.booking_id).slice(0, 8) })
  } catch (err) {
    console.error('[inbound-email] exception', err.message)
    return fini('exception', { message: err.message })
  }
}
