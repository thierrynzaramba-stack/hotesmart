// api/diagnostic.js
// Endpoint de diagnostic (page pages/diagnostic.html). LECTURE SEULE.
// ?check=channel        -> teste la connexion live au gestionnaire de canaux
// ?check=channel_detail -> canaux d'UN bien (mappings, is_active)
//
// ⚠ FUITE ENTRE COMPTES CORRIGEE (2 septembre 2026). Cet endpoint ne verifiait
// QUE la validite de la session, jamais l'appartenance des donnees demandees :
//
//  - `channel_detail` acceptait un property_id VENANT DU CLIENT sans verifier
//    a qui il appartient. Tout utilisateur connecte pouvait lire les canaux
//    OTA de n'importe quel bien de n'importe quel compte — identifiants de
//    listing, mappings, etat d'activation. Les secrets etaient masques, pas la
//    structure.
//  - `channel` renvoyait les property_ids des 5 premiers biens du compte
//    channel GLOBAL (marque blanche) : des biens d'autres clients HoteSmart.
//
// Les deux passent desormais par lib/require-permission.js.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

// ⚠ UN DIAGNOSTIC QUI PLANTE N'EST PAS UN DIAGNOSTIC.
// Vecu du 30 septembre 2026 : `CHANNEL_BASE_URL` venait d'etre reecrite sur le
// projet staging, `fetch` a leve — URL mal formee, ou hote injoignable — et
// comme rien n'attrapait, Vercel a rendu « FUNCTION_INVOCATION_FAILED » avec un
// corps vide. La seule page censee dire ce qui ne va pas ne disait RIEN, et
// c'etait precisement ce qu'on venait de changer.
//
// L'erreur est donc rendue, nommee, et sans jamais reveler la cle.
async function channelCall(method, path) {
  let res
  try {
    res = await fetch(`${CHANNEL_API}${path}`, {
      method,
      headers: {
        'user-api-key': CHANNEL_KEY,
        'Content-Type': 'application/json'
      }
    })
  } catch (e) {
    const cause = e?.cause?.code || e?.code || e?.name || 'inconnue'
    return { ok: false, status: 0, reseau: { cause, message: String(e.message || '').slice(0, 200) }, json: null }
  }
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Ce qu'on peut dire de `CHANNEL_BASE_URL` sans en reveler le contenu utile :
// sa FORME. C'est ce qui se trompe le plus souvent — un schema manquant, un
// espace colle par un copier-coller, un `/api/v1` en trop ou en moins.
function formeDeLUrl (brut) {
  if (!brut) return { present: false }
  const forme = {
    present: true,
    longueur: brut.length,
    espaces_ou_sauts: /\s/.test(brut),
    guillemets: /["']/.test(brut),
    barre_finale: /\/$/.test(brut),
  }
  try {
    const u = new URL(brut.trim())
    forme.schema = u.protocol.replace(':', '')
    forme.hote = u.host
    forme.chemin = u.pathname
    forme.termine_par_api_v1 = /\/api\/v1\/?$/.test(u.pathname)
    forme.analysable = true
  } catch (e) {
    forme.analysable = false
    forme.pourquoi = String(e.message || '').slice(0, 120)
  }
  return forme
}

module.exports = async function handler(req, res) {
  try {
    return await router(req, res)
  } catch (e) {
    // ⚠ MEME FILET QUE api/avis.js ET api/menages.js. Sans lui, une exception
    // imprevue sortait en « FUNCTION_INVOCATION_FAILED », corps vide : le
    // diagnostic ne diagnostiquait plus rien, et c'est arrive le jour ou on en
    // avait le plus besoin.
    console.error('[diagnostic] exception:', e && e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'Erreur serveur', detail: String(e && e.message || '').slice(0, 200) })
  }
}

async function router(req, res) {
  const check = req.query.check || 'channel'

  // ?check=channel_detail&property_id=<providerPropertyId>
  // LECTURE SEULE : liste les canaux d'un bien puis, pour CHAQUE canal, recupere
  // l'objet complet (mappings room/rate, is_active, tous attributs). Les valeurs
  // sensibles (tokens/secrets OTA eventuels) sont masquees avant renvoi.
  if (check === 'channel_detail') {
    if (!CHANNEL_API || !CHANNEL_KEY) {
      return res.status(503).json({
        error: 'Gestionnaire de canaux non configure (CHANNEL_BASE_URL / CHANNEL_API_KEY absents)'
      })
    }
    // Le property_id vient du CLIENT : il est revalide serveur contre le
    // perimetre de l'appelant. Un bien d'un autre compte donne 404, un bien hors
    // perimetre 403 — dans les deux cas, aucun appel au gestionnaire de canaux
    // n'est emis.
    const garde = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'read',
      bien: (req.query.property_id || '').trim(), bienRequis: true
    })
    if (!garde.ok) return
    const propId = garde.bien.provider_property_id

    // Masque recursif : on ne veut voir QUE la structure, jamais un secret.
    const SENSITIVE = /token|secret|password|api[_-]?key|access|refresh|credential|client_id|signature/i
    const redact = (v) => {
      if (Array.isArray(v)) return v.map(redact)
      if (v && typeof v === 'object') {
        const out = {}
        for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? '***REDACTED***' : redact(val)
        return out
      }
      return v
    }

    const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(propId)}`)
    const rows = Array.isArray(list.json?.data) ? list.json.data : []
    const channels = []
    for (const row of rows) {
      const one = await channelCall('GET', `/channels/${row.id}`)
      channels.push(one.ok ? redact(one.json?.data ?? one.json) : { id: row.id, http: one.status, body: redact(one.json) })
    }
    return res.status(list.ok ? 200 : 502).json({
      ok: list.ok,
      channel_status: list.status,
      channel_count: rows.length,
      channels
    })
  }

  if (check === 'channel') {
    // Test de connectivite au compte channel GLOBAL (marque blanche).
    //
    // ⚠ La protection ici n'est PAS une garde de droits : aucune ressource d'un
    // compte client n'est designee, donc tout utilisateur authentifie est
    // titulaire du compte cible (le sien) et passerait. La protection consiste a
    // NE PAS RENVOYER les donnees d'autrui — les property_ids du compte global,
    // qui designaient des biens d'autres clients, ont ete retires ci-dessous.
    // Seule subsiste une session valide, verifiee par le helper.
    const garde = await requirePermission(req, res, { domaine: 'titulaire' })
    if (!garde.ok) return

    if (!CHANNEL_API || !CHANNEL_KEY) {
      return res.status(503).json({
        error: 'Gestionnaire de canaux non configure (CHANNEL_BASE_URL / CHANNEL_API_KEY absents)'
      })
    }
    const r = await channelCall('GET', '/properties?pagination[page]=1&pagination[limit]=5')
    const ids = Array.isArray(r.json?.data) ? r.json.data : []
    // ⚠ property_ids ET TITRES VOLONTAIREMENT RETIRES : le compte channel est
    // GLOBAL (marque blanche), il porte les biens de TOUS les clients. Le
    // compteur suffit a diagnostiquer la connectivite.
    //
    // ⚠ `property_total` EST UN AGREGAT, et c'est la seule facon de savoir A QUEL
    // COMPTE la cle appartient sans reveler le bien de personne : un compte de
    // test en porte une poignee, le compte de production des dizaines. La
    // question s'est posee le 30 septembre 2026, en verifiant que staging ne
    // parlait pas au Channex de production.
    const total = r.json?.meta?.total ?? null
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      channel_status: r.status,
      // La FORME de l'URL, jamais la cle. C'est ce qui se trompe le plus souvent.
      base_url: formeDeLUrl(CHANNEL_API),
      base_url_host: formeDeLUrl(CHANNEL_API).hote || null,
      cle_presente: Boolean(CHANNEL_KEY),
      cle_longueur: CHANNEL_KEY ? String(CHANNEL_KEY).length : 0,
      property_count: ids.length,
      property_total: total,
      // ⚠ Une erreur RESEAU se distingue d'un refus du provider : la premiere dit
      // que l'URL ou l'hote est en cause, la seconde que la cle l'est.
      reseau: r.reseau || undefined,
      error: r.ok ? undefined : (r.json?.errors || r.json || undefined)
    })
  }

  return res.status(400).json({ error: 'check inconnu' })
}
