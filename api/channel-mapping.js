// api/channel-mapping.js
// Proxy serveur pour le parcours de connexion Airbnb maison (Option B).
// PHASE 1 = LECTURE SEULE : lever les 3 reserves sur un compte Airbnb reel
// (Colomiers) avant de coder les ecritures (map/activate). La cle Channex reste
// cote serveur ; ownership verifiee (user_id + provider_property_id).
//
// Actions (GET ?action=...&property_id=<provider_property_id>) :
//   groups          -> GET /groups                       (+ group_id du bien) [reserve group_id]
//   channels        -> GET /channels?filter[property_id] (etat des canaux)    [reserve 1]
//   mapping_details -> POST /channels/mapping_details     (rooms/rates Airbnb) [reserve 2 + codes entiers]
//
// mapping_details est un POST cote Channex mais SANS effet de bord (il lit les
// rooms/rates de l'OTA) -> sans danger sur Colomiers en prod.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, requirePermissionPourCanal } = require('../lib/require-permission')
const { jugerPrixDuCoeur } = require('../lib/garde-activation')
const { proprieteChezLeProvider } = require('../lib/rate-sync')
const { trouverBienParIdProvider } = require('../lib/bien-du-provider')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Masque recursif : on ne veut voir QUE la structure, jamais un secret OTA.
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

// ⚠ LE TARIF DE BASE FAIT PARTIE DES TARIFS DU BIEN, et l'oublier serait le
// bug d'origine INVERSE. `action=map` mappe le tarif de BASE
// (`provider_rate_plan_id`) : tout bien connecte par l'ecran lui-meme se
// reconnait par lui. Sans cette ligne, chaque bien ainsi connecte rendrait
// `mappe_pour_ce_bien: false` et repartirait dans le parcours de connexion.
// Releve en review : la mutation « supprimer cette ligne » laissait les tests
// verts tant que le `Set` etait construit dans le handler.
function tarifsDuBienDe (prop, liens) {
  const s = new Set()
  if (prop && prop.provider_rate_plan_id) s.add(String(prop.provider_rate_plan_id))
  for (const l of liens || []) if (l && l.provider_rate_plan_id) s.add(String(l.provider_rate_plan_id))
  return s
}

// ─── RESUME DES CANAUX D'UN BIEN ──────────────────────────────────────────
// Pure et exportee : c'est elle qui repond « ce bien est-il connecte ? », et la
// reponse decide du parcours entier de l'ecran Airbnb.
//
// ⚠ `is_active` EST UNE PROPRIETE DU CANAL, PAS DU BIEN. Defaut d'onboarding
// trouve le 11 septembre 2026 sur un logement neuf. Un canal Airbnb porte
// PLUSIEURS biens ; il est `is_active: true` des qu'UN seul y est mappe, et
// `filter[property_id]` le rend pour TOUT bien rattache, mappe ou non.
// L'ecran concluait donc « Airbnb est deja connecte » sur un logement sans
// AUCUN mapping, et proposait de le DECONNECTER au lieu de le connecter.
// Mesure sur « Ofuro Futari » : canal actif, bien rattache, zero mapping.
//
// La question juste est « ce canal porte-t-il un mapping vers un tarif DE CE
// BIEN ? ». On y repond avec NOS liens, la meme source que celle qui cree les
// mappings.
//
// ⚠ `liensLisibles = false` -> `mappe_pour_ce_bien: null`, jamais `false`.
// Une lecture en echec qui se lirait « pas mappe » renverrait un bien deja
// connecte dans le parcours de connexion, et lui ferait creer un SECOND
// mapping. L'ecran ne doit conclure que sur un `true` franc.
function resumerCanaux (rows, tarifsDuBien, liensLisibles) {
  return (rows || []).map(c => {
    const mappings = Array.isArray(c.attributes?.rate_plans) ? c.attributes.rate_plans : []
    const pourCeBien = mappings.filter(m => tarifsDuBien.has(String(m.rate_plan_id)))
    return {
      id: c.id,
      title: c.attributes?.title,
      ota: c.attributes?.channel || c.attributes?.ota_name,
      is_active: c.attributes?.is_active,
      // Le champ que l'ecran doit lire pour decider s'il est connecte.
      mappe_pour_ce_bien: liensLisibles ? pourCeBien.length > 0 : null,
      mappings_pour_ce_bien: pourCeBien.length,
      mappings_total: mappings.length
    }
  })
}

module.exports = async function handler(req, res) {
  if (!CHANNEL_API || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  // ===== AUTH =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  // La session est verifiee par requirePermission (auth.getUser y est appele) :
  // un second appel ici serait un aller-retour Supabase de plus par requete.

  const action = req.query.action || ''

  // ⚠ FUITE CORRIGEE. La garde plus bas valide le `property_id`, mais plusieurs
  // actions prennent AUSSI un `channel_id` en query et l'envoient tel quel au
  // gestionnaire de canaux — sans jamais verifier que ce canal appartient au
  // bien annonce. Un membre legitime sur SON bien pouvait donc passer le
  // channel_id d'un AUTRE compte et agir dessus : activate, deactivate, delete,
  // load_reservations, jusqu'a la suppression du canal d'un tiers.
  // Le canal est desormais resolu vers son bien, et les droits verifies sur ce
  // bien-la — meme modele que channel-bcom-activate.js.
  const ACTIONS_A_CANAL = ['mapping_details', 'list_listings', 'action_listings', 'mappings',
                           'listings', 'map', 'activate', 'deactivate', 'delete', 'load_reservations']
  const canalDemande = (req.query.channel_id || '').trim()
  const providerPropertyId = (req.query.property_id || '').trim()
  // Le bien vient du client : resolu en base et confronte au perimetre AVANT
  // tout appel au gestionnaire de canaux. Les filtres user_id qui suivent
  // portent sur le compte PROPRIETAIRE (delegation possible), pas sur l'appelant.
  const garde = await requirePermission(req, res, {
    domaine: 'reglages', niveau: 'write', bien: providerPropertyId, bienRequis: true
  })
  if (!garde.ok) return
  const compteBien = garde.accountUserId

  // (Le cas « property_id absent » est deja traite par la garde ci-dessus,
  // bienRequis:true -> 400. Ce bloc reste comme filet, sans etre atteignable.)
  if (!providerPropertyId) {
    return res.status(400).json({ error: 'property_id (provider_property_id) requis' })
  }

  // ===== Ownership : le bien doit appartenir au user (par provider_property_id) =====
  // ⚠ SUR LES DEUX IDENTIFIANTS, comme la garde juste au-dessus. Un appelant qui
  // designe le bien par sa propriete cible franchissait la garde puis recevait un
  // 404 : deux resolutions qui divergent finissent toujours par se payer.
  // `base_price` est LU PAR LE CRAN D'ARRET (lib/garde-activation.js) — une garde
  // qui juge sur une colonne non selectionnee est une garde ouverte.
  let prop
  try {
    prop = await trouverBienParIdProvider(supabase, providerPropertyId, {
      userId: compteBien,
      colonnes: 'id, provider, base_price, provider_property_id, migration_target_property_id, '
        + 'provider_rate_plan_id, provider_room_type_id, name, inventory_units, user_id'
    })
  } catch (e) {
    console.error('[channel-mapping] SELECT error', e.message)
    return res.status(500).json({ error: 'Erreur lecture' })
  }
  if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })
  if (prop.ambigu) return res.status(409).json({ error: 'Identifiant de bien ambigu' })

  // ⚠ L'ADRESSE CHEZ LE PROVIDER N'EST PAS LA CLE D'OWNERSHIP.
  // `providerPropertyId` identifie le bien DANS HoteSmart (et sert aux gardes) ;
  // `idChezLeProvider` est l'endroit ou parler chez le provider. Pour un bien en
  // cours de migration, ce sont DEUX identifiants differents : la cle source
  // (Beds24) et la propriete cible (Channex). Les confondre adressait Channex
  // avec « 209413 » — HTTP 422, et toute la phase 1 du plan de bascule
  // inexecutable. Point unique : `proprieteChezLeProvider` (lib/rate-sync.js).
  const idChezLeProvider = proprieteChezLeProvider(prop)

  if (canalDemande && ACTIONS_A_CANAL.includes(action)) {
    // ⚠ ON NOMME LE BIEN, la garde ne le devine plus. Elle prenait
    // `properties[0]` — le PREMIER bien du canal — ce qui refusait toute action
    // sur un canal partage entre plusieurs logements des qu'on visait un autre
    // que le premier. Les DEUX identifiants, parce qu'un bien en migration
    // porte la cle de sa propriete cible cote canal et celle de sa source cote
    // front.
    const gardeCanal = await requirePermissionPourCanal(req, res, {
      channelId: canalDemande,
      channelCall,
      biensAttendus: [prop.provider_property_id, prop.migration_target_property_id]
    })
    // ⚠ LE CONTROLE « ce canal releve-t-il bien de ce logement ? » EST DANS LA
    // GARDE, pas ici. Il y etait en double, et la version d'ici comparait au
    // seul `properties[0]` du canal : sur un canal partage entre plusieurs
    // logements, elle refusait tout ce qui ne visait pas le premier. La garde
    // cherche desormais le bien annonce PARMI ceux du canal, et verifie les
    // droits sur celui-la — plus juste, et plus strict qu'avant.
    if (!gardeCanal.ok) return
  }

  if (!idChezLeProvider) {
    return res.status(409).json({
      error: 'pas_de_propriete_chez_le_provider',
      message: 'Ce logement n\'existe pas chez le canal de distribution : rien a y mapper. '
        + 'Creer d\'abord sa propriete (assistant de migration, etape « Logement cree chez le nouveau provider »).'
    })
  }

  try {
    // --- groups : resout le group_id proprietaire du bien (requis au create channel) ---
    if (action === 'groups') {
      const r = await channelCall('GET', '/groups')
      const groups = Array.isArray(r.json?.data) ? r.json.data : []
      const match = groups.find(g => {
        const rel = g.relationships?.properties?.data
        return Array.isArray(rel) && rel.some(p => String(p.id) === String(idChezLeProvider))
      })
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        group_id: match?.id || null,
        groups: groups.map(g => ({
          id: g.id,
          title: g.attributes?.title,
          properties: g.relationships?.properties?.data?.map(p => p.id) || []
        }))
      })
    }

    // --- channels : etat des canaux du bien (reserve 1 : OAuth cree-t-il un canal nu ?) ---
    if (action === 'channels') {
      const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
      const rows = Array.isArray(r.json?.data) ? r.json.data : []

      // ⚠ `is_active` EST UNE PROPRIETE DU CANAL, PAS DU BIEN. ET C'EST LE
      // DEFAUT D'ONBOARDING TROUVE LE 11 SEPTEMBRE 2026 SUR UN BIEN NEUF.
      //
      // Un canal Airbnb porte PLUSIEURS biens : celui de Thierry en portait
      // trois. Des qu'un seul y est mappe, le canal est `is_active: true` — et
      // `filter[property_id]` le rend pour TOUT bien rattache, mappe ou non.
      // L'ecran Airbnb concluait donc « Airbnb est deja connecte » sur un
      // logement qui n'avait AUCUN mapping, et proposait de le deconnecter au
      // lieu de le connecter. Mesure sur « Ofuro Futari » : canal actif, bien
      // rattache, ZERO mapping.
      //
      // La question juste n'est pas « ce canal est-il actif ? » mais « ce canal
      // porte-t-il un mapping vers un tarif DE CE BIEN ? ». On repond avec NOS
      // liens (`property_channel_rate_plans` + le tarif de base), pas avec ceux
      // du provider : c'est la meme source que celle qui cree les mappings.
      const { data: liensRp, error: eRp } = await supabase
        .from('property_channel_rate_plans')
        .select('provider_rate_plan_id')
        .eq('property_id', prop.id)
      // ⚠ UNE LECTURE EN ECHEC NE DOIT PAS SE LIRE « PAS MAPPE » : ce serait
      // renvoyer un bien deja connecte dans le parcours de connexion, et lui
      // faire creer un second mapping. On le DIT, et on s'abstient de conclure.
      const liensLisibles = !eRp
      if (eRp) console.error('[channel-mapping] lecture des tarifs du bien', eRp.message)
      const tarifsDuBien = tarifsDuBienDe(prop, liensRp)

      const summary = resumerCanaux(rows, tarifsDuBien, liensLisibles)
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_count: rows.length,
        channels: summary,
        raw: redact(rows)
      })
    }

    // --- mapping_details : rooms/rates Airbnb + codes entiers (reserve 2 + point 4) ---
    if (action === 'mapping_details') {
      let channelId = (req.query.channel_id || '').trim()
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal sur ce bien', channel_count: rows.length })
      }

      // Lit le canal pour reinjecter son code OTA + settings dans mapping_details.
      const ch = await channelCall('GET', `/channels/${channelId}`)
      const attrs = ch.json?.data?.attributes || {}
      const channelCode = attrs.channel || attrs.ota_name
      const settings = attrs.settings || {}

      const md = await channelCall('POST', '/channels/mapping_details', { channel: channelCode, settings })
      return res.status(md.ok ? 200 : 502).json({
        ok: md.ok,
        http: md.status,
        channel_id: channelId,
        channel: channelCode,
        settings_used: redact(settings),
        mapping_details: redact(md.json?.data ?? md.json)
      })
    }

    // --- list_listings : le listing_id_dictionary Airbnb (ecran de choix d'annonce) ---
    if (action === 'list_listings') {
      let channelId = (req.query.channel_id || '').trim()
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien', channel_count: rows.length })

      const ch = await channelCall('GET', `/channels/${channelId}`)
      const attrs = ch.json?.data?.attributes || {}
      const md = await channelCall('POST', '/channels/mapping_details', {
        channel: attrs.channel || attrs.ota_name,
        settings: attrs.settings || {}
      })
      const data = md.json?.data ?? md.json ?? {}
      return res.status(md.ok ? 200 : 502).json({
        ok: md.ok,
        http: md.status,
        channel_id: channelId,
        listings: redact(data.listing_id_dictionary ?? data.listings ?? data),
        full: redact(data)
      })
    }

    // --- action_listings : annonces Airbnb via GET /channels/:id/action/listings ---
    // Endpoint officiel du parcours lien-direct (doc Evan). Meme structure
    // listing_id_dictionary que list_listings (mapping_details), mais en GET sur le
    // canal auto-cree par l'OAuth. list_listings reste pour le diagnostic (non touche).
    if (action === 'action_listings') {
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const r = await channelCall('GET', `/channels/${channelId}/action/listings`)
      const data = r.json?.data ?? r.json ?? {}
      // Forme reelle (doc) : data.listing_id_dictionary.values[] = [{id,title,type,...}].
      const dict = data.listing_id_dictionary
      const values = Array.isArray(dict?.values) ? dict.values
                   : Array.isArray(dict) ? dict
                   : Array.isArray(data.listings) ? data.listings
                   : (dict ?? data)

      // Annonces DEJA mappees sur ce canal (multi-biens : eviter de re-mapper listing1).
      //
      // ⚠ `GET /channels/:id/mappings` REND 404 SUR CETTE VERSION DE L'API —
      // mesure du 11 septembre 2026, et c'est deja note dans docs/CHANNEL_TECH.md.
      // La liste des annonces prises revenait donc VIDE, en silence : aucune
      // annonce n'etait grisee, et l'ecran « toutes vos annonces sont deja
      // reliees » ne pouvait jamais s'afficher. Un hote pouvait relier son
      // logement neuf a l'annonce d'un logement DEJA connecte.
      //
      // Le canal lui-meme porte ses mappings (`attributes.rate_plans[]`), et
      // c'est la source utilisee partout ailleurs dans le depot. On la prend en
      // repli — et on le DIT dans la reponse, pour qu'un ecran ne prenne pas un
      // silence pour une absence.
      const mp = await channelCall('GET', `/channels/${channelId}/mappings`)
      const mrows = Array.isArray(mp.json?.data) ? mp.json.data : []
      let mappedListingIds = mrows
        .map(m => m.attributes?.listing_id)
        .filter(v => v != null)
        .map(String)
      let sourceMappings = 'mappings'
      if (!mappedListingIds.length) {
        const chMap = await channelCall('GET', `/channels/${channelId}`)
        const rp = chMap.json?.data?.attributes?.rate_plans
        if (Array.isArray(rp)) {
          mappedListingIds = rp.map(m => m.settings?.listing_id).filter(v => v != null).map(String)
          sourceMappings = 'channel.rate_plans'
        }
      }

      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_id: channelId,
        listings: redact(values),
        mapped_listing_ids: mappedListingIds,
        // D'ou vient la liste des annonces prises : `mappings` (endpoint dedie)
        // ou `channel.rate_plans` (repli). Un ecran qui grise des annonces doit
        // pouvoir dire sur quoi il se fonde.
        mapped_source: sourceMappings,
        full: redact(data)
      })
    }

    // --- mappings : lignes de mapping listing<->rate_plan d'un canal (LECTURE PURE) ---
    // Valide sur l'API reelle la sous-ressource /channels/:id/mappings decouverte via
    // channex-mcp : structure (id, listing_id, room_type_id, rate_plan_id, is_mapped).
    if (action === 'mappings') {
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const r = await channelCall('GET', `/channels/${channelId}/mappings`)
      const rows = Array.isArray(r.json?.data) ? r.json.data : []
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_id: channelId,
        mapping_count: rows.length,
        mappings: rows.map(m => ({
          id:           m.id,
          listing_id:   m.attributes?.listing_id,
          room_type_id: m.attributes?.room_type_id,
          rate_plan_id: m.attributes?.rate_plan_id,
          is_mapped:    m.attributes?.is_mapped
        })),
        raw: redact(r.json?.data ?? r.json)
      })
    }

    // --- listings : annonces Airbnb du canal (GET /channels/:id/listings, LECTURE PURE) ---
    if (action === 'listings') {
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const r = await channelCall('GET', `/channels/${channelId}/listings`)
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_id: channelId,
        listings: redact(r.json?.data ?? r.json)
      })
    }

    // --- map : lie notre rate plan au listing Airbnb choisi par l'hote (read-modify-write) ---
    // listing_id OBLIGATOIRE (choix hote). Payload MINIMAL confirme par capture reseau
    // de l'iframe : POST /channels/:id/mappings { mapping: { rate_plan_id, settings:
    // { listing_id, primary_occ:true } } }. Channex tire le reste de l'annonce Airbnb.
    // Le PUT /channels/:id ne posait PAS le mapping (rate_plans:[] restait vide) -> abandonne.
    // dry_run=true par defaut ; ecriture refusee sur un canal deja actif sauf force=1.
    if (action === 'map') {
      const listingId = (req.query.listing_id || '').trim()
      if (!listingId) {
        return res.status(400).json({ error: 'listing_id requis (choix de l\'hote)' })
      }
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'
      let channelId = (req.query.channel_id || '').trim()

      const ratePlanId = prop.provider_rate_plan_id
      if (!ratePlanId) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (provisioning incomplet)' })
      }

      // Canal du bien courant = le canal cree par l'OAuth. Si absent, l'hote doit d'abord
      // connecter son compte (OAuth) -> on ne cree pas de canal from scratch ici.
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id || ''
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal sur ce bien : l\'hote doit d\'abord connecter son compte via OAuth' })
      }

      // Etat actuel du canal (garde-fou canal actif).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      const targetIsActive = ch.json?.data?.attributes?.is_active

      const method = 'POST'
      const path = `/channels/${channelId}/mappings`
      const payload = { mapping: {
        rate_plan_id: ratePlanId,
        settings: { listing_id: listingId, primary_occ: true }
      }}

      // DRY-RUN (defaut) : on montre ce qui SERAIT envoye, rien n'est ecrit.
      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method, path, payload },
          channel_id: channelId,
          target_is_active: targetIsActive
        })
      }

      // GARDE-FOU : ecriture reelle sur un canal DEJA ACTIF refusee sans force (protege Colomiers).
      if (targetIsActive === true && !force) {
        return res.status(409).json({
          error: 'Canal deja actif : ecriture bloquee (protege Colomiers). force=1 pour outrepasser (a eviter en prod).',
          channel_id: channelId
        })
      }

      const w = await channelCall(method, path, payload)

      // PREUVE : on relit le canal, rate_plans[] doit desormais etre PEUPLE (mapping pris).
      const after = await channelCall('GET', `/channels/${channelId}`)
      const ratePlansAfter = after.json?.data?.attributes?.rate_plans || []

      return res.status(w.ok ? 200 : 502).json({
        dry_run: false,
        method, path,
        http: w.status,
        result: redact(w.json),
        rate_plans_count: ratePlansAfter.length,
        rate_plans_populated: ratePlansAfter.length > 0,
        rate_plans_after: redact(ratePlansAfter)
      })
    }

    // --- activate : passe le canal live. dry_run=true par defaut ; no-op si deja actif ---
    if (action === 'activate') {
      const dryRun = req.query.dry_run !== 'false'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      // ⚠ LE CRAN D'ARRET VIT ICI AUSSI, ET C'EST LE CHEMIN QUI COMPTE.
      // Constat de review : la garde n'existait que dans channel-bcom-activate,
      // qu'AUCUNE page n'appelle. `HS.api.channel.activate` (shared/api-client)
      // vise cet endpoint-ci, avec `dryRun = false` par defaut. Une garde posee
      // sur le chemin que personne n'emprunte ne garde rien.
      const juge = await jugerPrixDuCoeur(supabase, prop)

      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method: 'POST', path: `/channels/${channelId}/activate`, body: {} },
          pret_a_activer: juge.pret,
          blocage: juge.pret ? null : { raison: juge.raison, message: juge.message },
          prix_detenus: juge.prix_detenus
        })
      }

      if (!juge.pret) {
        return res.status(409).json({
          error: 'activation_refusee', raison: juge.raison, message: juge.message
        })
      }

      // Idempotent : canal deja actif -> no-op succes (cas multi-biens : on ajoute un
      // listing a un canal deja live, inutile et risque de re-activer).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true) {
        return res.status(200).json({ dry_run: false, already_active: true, http: 200, channel_id: channelId })
      }
      const w = await channelCall('POST', `/channels/${channelId}/activate`, {})
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    // --- load_reservations : tire les resas d'un listing rejoignant un canal ---
    // POST /channels/:id/action/load_future_reservations { listing_id }. Recommande par la
    // doc quand un NOUVEAU listing rejoint un canal existant (le webhook activate_channel ne
    // refire pas sur un canal deja actif -> post-mapping non declenche sans ceci).
    if (action === 'load_reservations') {
      const listingId = (req.query.listing_id || '').trim()
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id || ''
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const body = listingId ? { listing_id: listingId } : {}
      const w = await channelCall('POST', `/channels/${channelId}/action/load_future_reservations`, body)
      return res.status(w.ok ? 200 : 502).json({ ok: w.ok, http: w.status, channel_id: channelId, result: redact(w.json) })
    }

    // --- deactivate : met le canal en pause. dry_run=true par defaut. (cycle throwaway) ---
    if (action === 'deactivate') {
      const dryRun = req.query.dry_run !== 'false'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'POST', path: `/channels/${channelId}/deactivate`, body: {} } })
      }
      const w = await channelCall('POST', `/channels/${channelId}/deactivate`, {})
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    // --- delete : supprime le canal (exige inactif). dry_run=true par defaut. (cycle throwaway) ---
    if (action === 'delete') {
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'DELETE', path: `/channels/${channelId}` } })
      }
      // Garde-fou : DELETE exige un canal inactif ; refus si actif sans force (protege Colomiers).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true && !force) {
        return res.status(409).json({ error: 'Canal actif : deactivate d\'abord (DELETE exige inactif). force=1 pour outrepasser.', channel_id: channelId })
      }
      const w = await channelCall('DELETE', `/channels/${channelId}`)
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    // --- disconnect : deconnecte CE bien de son annonce OTA (langage hote). ---
    // SECURITE canal partage : on demappe UNIQUEMENT le mapping de CE bien (rate_plan_id ==
    // provider_rate_plan_id) ; on ne supprime le canal QUE s'il ne reste plus aucun mapping
    // (bien seul). Sinon on laisse le canal actif pour les autres biens du meme compte.
    // dry_run=true par defaut (montre ce qui serait fait) ; l'assistant passe dry_run=false.
    if (action === 'disconnect') {
      const dryRun = req.query.dry_run !== 'false'
      let channelId = (req.query.channel_id || '').trim()
      const ratePlanId = prop.provider_rate_plan_id
      if (!ratePlanId) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (rien a deconnecter)' })
      }

      // ⚠ ON NE DEVINE PLUS LE CANAL. `rows[0]` prenait le PREMIER canal du
      // bien, quel que soit l'OTA : sur un bien connecte a Booking ET Airbnb,
      // deconnecter l'un pouvait supprimer l'autre. C'est arrive le
      // 10 septembre 2026 sur La bulle — son canal Booking a disparu, et la
      // date rouverte le 31 octobre est restee fermee chez Booking faute de
      // canal pour la porter.
      // Cet endpoint est celui du mapping AIRBNB (`list_listings`,
      // `action_listings`, `mappings`) : il ne doit toucher qu'un canal Airbnb.
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(idChezLeProvider)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        const abnb = rows.filter(c => /airbnb/i.test(String(c.attributes?.channel || c.attributes?.ota_name || '')))
        if (abnb.length > 1) {
          return res.status(409).json({
            error: 'Plusieurs canaux Airbnb sur ce logement : precisez channel_id.',
            channel_count: abnb.length
          })
        }
        channelId = abnb[0]?.id || ''
      }
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal Airbnb sur ce bien (deja deconnecte)' })
      }

      // SOURCE CORRECTE du mapping_id : channel.attributes.rate_plans[].id (via GET /channels/:id),
      // PAS l'endpoint /mappings. Chaque entree = un channel_rate_plan : .id = mapping_id a DELETE ;
      // le rate_plan_id sous-jacent (notre provisioning) sert a identifier LE mapping de CE bien.
      const rpUnderlying = (rp) =>
        rp?.rate_plan_id ?? rp?.attributes?.rate_plan_id ?? rp?.settings?.rate_plan_id
        ?? rp?.relationships?.rate_plan?.data?.id ?? null

      const chBefore = await channelCall('GET', `/channels/${channelId}`)
      // ⚠ ET ON VERIFIE QUE LE CANAL DESIGNE EST BIEN UN CANAL AIRBNB.
      // Un `channel_id` peut venir de l'appelant : le filtre ci-dessus ne
      // protege que le cas ou il est absent. C'est par la que le canal Booking
      // de La bulle a ete supprime — l'ecran Airbnb lui avait passe l'id du
      // canal Booking, faute de filtrer sur l'OTA de son cote.
      const otaCanal = String(chBefore.json?.data?.attributes?.channel
        || chBefore.json?.data?.attributes?.ota_name || '')
      if (chBefore.json?.data && !/airbnb/i.test(otaCanal)) {
        return res.status(409).json({
          error: `Ce canal n'est pas un canal Airbnb (${otaCanal}) : deconnexion refusee.`,
          channel_id: channelId, ota: otaCanal
        })
      }
      const rpsBefore = Array.isArray(chBefore.json?.data?.attributes?.rate_plans)
        ? chBefore.json.data.attributes.rate_plans : []

      // ⚠ ON CHERCHE AUSSI LE TARIF DERIVE, ET C'EST DEVENU LE CAS NORMAL.
      // `provider_rate_plan_id` est le tarif de BASE. Depuis que tous les
      // mappings pointent le tarif DERIVE du canal (correctif du 10 septembre
      // 2026 : mapper la base envoyait le prix non derive a l'OTA), ce match
      // n'aboutit PLUS JAMAIS — et le repli `sole_entry` etait donc devenu le
      // seul chemin. Un repli concu comme l'exception ne doit pas devenir la
      // regle : il supprime un mapping que la fonction n'a PAS identifie comme
      // le sien.
      const { data: lienAbnb } = await supabase
        .from('property_channel_rate_plans')
        .select('provider_rate_plan_id')
        .eq('property_id', prop.id).eq('channel', 'airbnb').eq('role', 'derived')
        .neq('is_active', false)
        .maybeSingle()
      const cibles = [ratePlanId, lienAbnb?.provider_rate_plan_id].filter(Boolean).map(String)

      let mine = rpsBefore.filter(rp => rpUnderlying(rp) != null && cibles.includes(String(rpUnderlying(rp))))
      let matchedBy = 'rate_plan_id'
      if (mine.length === 0 && rpsBefore.length === 1) { mine = rpsBefore; matchedBy = 'sole_entry' }
      const ambiguous = mine.length === 0 && rpsBefore.length > 1
      const mappingIds = mine.map(rp => rp?.id).filter(Boolean)

      if (dryRun) {
        return res.status(200).json({
          dry_run: true, channel_id: channelId,
          rate_plans_before: rpsBefore.length, would_unmap: mappingIds, matched_by: matchedBy, ambiguous
        })
      }

      // ECHEC EXPLICITE (jamais de faux succes) : ambigu ou rien a retirer.
      if (ambiguous) {
        return res.status(409).json({
          error: 'Plusieurs annonces reliees a ce canal : impossible d\'identifier celle de ce logement sans risque.',
          channel_id: channelId, rate_plans_before: rpsBefore.length
        })
      }
      if (!mappingIds.length) {
        return res.status(404).json({ error: 'Aucune annonce reliee trouvee pour ce logement (rien a deconnecter).', channel_id: channelId })
      }

      // 1. DELETE chaque mapping (verif reponse).
      const delResults = []
      for (const mid of mappingIds) {
        const d = await channelCall('DELETE', `/channels/${channelId}/mappings/${mid}`)
        delResults.push({ mapping_id: mid, ok: d.ok, http: d.status })
      }

      // 2. PREUVE : re-GET le canal ; nos mapping_id ne doivent PLUS etre dans rate_plans[].
      const chAfter = await channelCall('GET', `/channels/${channelId}`)
      const rpsAfter = Array.isArray(chAfter.json?.data?.attributes?.rate_plans)
        ? chAfter.json.data.attributes.rate_plans : []
      const stillThere = rpsAfter.some(rp => mappingIds.includes(rp?.id))
      if (stillThere) {
        return res.status(502).json({
          error: 'La deconnexion a echoue cote gestionnaire (le mapping est toujours present apres suppression).',
          channel_id: channelId, del_results: delResults, rate_plans_after: rpsAfter.length
        })
      }

      // 3. Canal VIDE -> deactivate (verifier is_active:false) -> delete (verifier suppression).
      let channelDeactivated = null
      let channelDeleted = false
      let cleanupWarning = null
      if (rpsAfter.length === 0) {
        await channelCall('POST', `/channels/${channelId}/deactivate`, {})
        const chk = await channelCall('GET', `/channels/${channelId}`)
        channelDeactivated = chk.json?.data?.attributes?.is_active === false
        if (channelDeactivated) {
          const del = await channelCall('DELETE', `/channels/${channelId}`)
          if (del.ok) {
            const gone = await channelCall('GET', `/channels/${channelId}`)
            channelDeleted = gone.status === 404 || !gone.json?.data
          }
        }
        if (!channelDeleted) cleanupWarning = 'canal vide non supprime (a nettoyer)'
      }

      return res.status(200).json({
        dry_run: false,
        channel_id: channelId,
        unmapped: mappingIds.length,
        matched_by: matchedBy,
        rate_plans_after: rpsAfter.length,
        channel_deactivated: channelDeactivated,
        channel_deleted: channelDeleted,
        channel_kept: rpsAfter.length > 0,
        cleanup_warning: cleanupWarning
      })
    }

    return res.status(400).json({ error: 'action inconnue (groups | channels | mapping_details | list_listings | action_listings | mappings | listings | map | activate | load_reservations | disconnect | deactivate | delete)' })
  } catch (err) {
    console.error('[channel-mapping]', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}

// Export secondaire, sans toucher au defaut : la fonction que le test tient.
module.exports.resumerCanaux = resumerCanaux
module.exports.tarifsDuBienDe = tarifsDuBienDe
