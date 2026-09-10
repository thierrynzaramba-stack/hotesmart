// api/channel-bcom-write.js
// Booking.com — ECRITURE MINIMALE, Etape 1 : creer le canal de MAPPING seul, puis
// pouvoir l'annuler. RIEN d'autre. Separe de channel-bcom.js pour preserver la
// garantie read-only de ce dernier.
//
// GARDE-FOU DUR (structurel, pas une discipline) :
//   channelCall refuse AVANT tout appel reseau tout chemin qui pousserait de l'ARI
//   (availability / restrictions / load_and_save_ari / activate / action / sync).
//   Seuls sont autorises : GET /groups, GET /channels*, POST /channels, DELETE /channels/:id.
//   => Aucun tarif de l'hote ne peut partir depuis ce fichier, meme par erreur de code.
//
// Le canal est TOUJOURS cree is_active:false (force cote serveur, non pilotable par
// l'appelant). readonly:false est volontaire (Voie A : rouvrir les dates plus tard) :
// la SEULE protection des tarifs Booking de Jean-Eric a cette etape est qu'aucun push
// ne part. C'est ce que garantit l'allowlist ci-dessous.
//
// Actions (POST recommande, ?action=...) :
//   create  -> POST /channels   (mapping seul, is_active:false). dry_run=true par defaut.
//   delete  -> DELETE /channels/:id (annulation). dry_run=true par defaut ; refuse un
//              canal actif sans force=1.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, requirePermissionPourCanal } = require('../lib/require-permission')
const { proprieteChezLeProvider, canPushRates, RATE_PUSH_BLOCKED } = require('../lib/rate-sync')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

const OTA_CODE = 'BookingCom'

// Allowlist reseau : (methode, matcher). Tout le reste => throw avant fetch.
// Interdit de fait : /availability, /restrictions, /action/*, /activate, load_and_save_ari, sync.
const DELETE_CHANNEL_RE = /^\/channels\/[0-9a-f-]{36}$/i

// ⚠ POURQUOI CE TRADUCTEUR EXISTE. Un refus de Channex arrivait au front en
// « Erreur serveur » : `shared/api-client.js` compose son message avec
// `data.error`, et les branches d'ecriture rendaient 502 SANS ce champ — la
// raison reelle dormait dans `result`, que le front jette. Mesure du
// 10 septembre : la creation d'un second canal Booking sur un bien qui en a
// deja un se refusait ainsi en silence, et le bouton « Reessayer » de l'ecran
// de liaison rejouait indefiniment le meme refus.
//
// Channex n'a pas une seule forme d'erreur : `errors` peut etre une chaine, un
// tableau, un objet `{ code, title, details }`, ou `details` un objet
// { champ: [messages] }. On aplatit ce qu'on trouve, et on garde le libelle par
// defaut si rien n'est lisible — jamais de message vide.
function raisonChannex (corps, parDefaut) {
  const e = corps && corps.errors
  const bouts = []
  const pousser = (v) => {
    if (v == null) return
    if (typeof v === 'string') { if (v.trim()) bouts.push(v.trim()); return }
    if (Array.isArray(v)) { v.forEach(pousser); return }
    if (typeof v === 'object') {
      if (v.title) pousser(v.title)
      if (v.details) pousser(v.details)
      if (!v.title && !v.details) Object.values(v).forEach(pousser)
      return
    }
    pousser(String(v))
  }
  pousser(e)
  // Doublons frequents (`title` repete dans `details`).
  const uniques = [...new Set(bouts)]
  return uniques.length ? `${parDefaut} : ${uniques.join(' — ')}` : parDefaut
}

// ⚠ LA DECISION EST ICI, ET ELLE EST TESTABLE — C'EST LE POINT.
// Elle etait en ligne dans `action=map`, derriere la garde d'autorisation et
// deux allers-retours reseau : impossible a exercer sans tout simuler. Le test
// se rabattait donc sur la LECTURE DE LA SOURCE, et la review l'a mis en
// defaut — remplacer la cible par `propM.provider_rate_plan_id` laissait les
// CINQ assertions vertes, alors que la regle s'inversait. Une fonction pure et
// exportee rend l'inversion detectable.
//
// LA REGLE : le mapping pointe le tarif DERIVE du canal, jamais la base.
// Mapper la base envoie a l'OTA le prix non derive — commission et `min_stay`
// de `property_channel_rate_plans` perdus, en silence. On refuse plutot que de
// replier.
function choisirTarifDerive (liens) {
  const utiles = (liens || []).filter(l => l && l.provider_rate_plan_id)
  if (utiles.length > 1) {
    return {
      ok: false,
      http: 409,
      corps: {
        error: 'Plusieurs tarifs derives booking pour ce bien — impossible de choisir',
        message: 'Desactiver ou supprimer les liens en trop dans property_channel_rate_plans.',
        trouves: utiles.length
      }
    }
  }
  if (!utiles.length) {
    return {
      ok: false,
      http: 400,
      corps: {
        error: 'Aucun tarif derive booking pour ce bien',
        message: 'Le mapping doit pointer le tarif DERIVE du canal, jamais le tarif de base : '
          + 'sinon le prix non derive part chez l\'OTA. Creer le derive d\'abord '
          + '(channel-rateplan, action=create_derived).'
      }
    }
  }
  return { ok: true, ratePlanId: utiles[0].provider_rate_plan_id }
}
function assertAllowed(method, path) {
  const ok =
    (method === 'GET' && (path === '/groups' || path.startsWith('/channels'))) ||
    (method === 'POST' && path === '/channels') ||
    // Le mapping se pose APRES l'approbation dans l'extranet : les codes de
    // l'OTA n'existent pas avant. Sans ce PUT, un canal cree sans mapping
    // n'avait aucune sortie que DELETE + recreation — donc une NOUVELLE demande
    // d'approbation, la boucle meme que la phase 1 cherche a eviter.
    (method === 'PUT' && DELETE_CHANNEL_RE.test(path)) ||
    (method === 'DELETE' && DELETE_CHANNEL_RE.test(path))
  // Double barriere : meme si un chemin /channels... contenait un sous-verbe d'ecriture ARI.
  const forbidden = /availability|restrictions|load_and_save_ari|\/action\b|\/activate|\/deactivate|sync/i.test(path)
  if (!ok || forbidden) {
    throw new Error(`channel-bcom-write : ${method} ${path} refuse (mapping seul, aucun push ARI)`)
  }
}

async function channelCall(method, path, body) {
  assertAllowed(method, path)
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

// Masque recursif : jamais un secret dans la reponse renvoyee au client.
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

// Resout le group_id proprietaire du bien (requis par POST /channels).
async function resolveGroupId(providerPropertyId) {
  const r = await channelCall('GET', '/groups')
  const groups = Array.isArray(r.json?.data) ? r.json.data : []
  const match = groups.find(g => {
    const rel = g.relationships?.properties?.data
    return Array.isArray(rel) && rel.some(p => String(p.id) === String(providerPropertyId))
  })
  return { group_id: match?.id || null, http: r.status, ok: r.ok }
}

module.exports = async function handler(req, res) {
  if (!CHANNEL_API || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  // ===== AUTH (cle canal cote serveur) =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  // La session est verifiee par requirePermission (auth.getUser y est appele) :
  // un second appel ici serait un aller-retour Supabase de plus par requete.

  const action = (req.query.action || '').trim()

  try {
    // ================= CREATE : mapping seul, is_active:false =================
    if (action === 'create') {
      const providerPropertyId = (req.query.property_id || '').trim()
      const hotelId = (req.query.hotel_id || '').trim()
      // Le `hotel_id` de Booking est numerique : on le valide comme tel, parce
      // que la creation l'exige en NOMBRE (voir plus bas).
      // ⚠ BORNE, PARCE QUE `Number()` ARRONDIT EN SILENCE.
      // `/^\d+$/` laissait passer 17 chiffres : `Number()` en perd la fin, et
      // Channex recevait un identifiant DIFFERENT de celui saisi — avec un 201
      // en retour, donc un ecran qui annonce la reussite sur le mauvais hotel.
      // 15 chiffres restent tres au-dela des identifiants Booking reels (8).
      if (hotelId && !/^[1-9]\d{0,14}$/.test(hotelId)) {
        return res.status(400).json({ error: 'hotel_id invalide (nombre de 1 a 15 chiffres attendu)' })
      }
      const roomTypeCode = parseInt(req.query.room_type_code, 10)
      const ratePlanCode = parseInt(req.query.rate_plan_code, 10)
      if (!providerPropertyId) return res.status(400).json({ error: 'property_id (provider_property_id) requis' })
      if (!hotelId) return res.status(400).json({ error: 'hotel_id requis' })

      // ⚠ LES CODES SONT OPTIONNELS, ET C'EST LA SEQUENCE BOOKING QUI L'IMPOSE.
      // Mesure du 10 septembre 2026 sur les deux hotels de Bagneres :
      // `test_connection` rend `success: false` et `mapping_details` HTTP 422
      // TANT QUE la connexion n'est pas activee dans l'extranet Booking
      // (« Gestion des connexions »), et 200 des qu'elle l'est. Or c'est la
      // CREATION du canal qui fait apparaitre la demande cote Booking
      // (docs/specs/spec-migration-channex.md §3). Exiger les codes a la
      // creation demandait donc une information qui n'existe pas encore :
      // l'etape etait infaisable dans l'ordre reel.
      //
      // Sans codes : canal cree INACTIF et SANS mapping. Le mapping se pose
      // ensuite, une fois l'approbation obtenue et `mapping_details` lisible.
      // Les deux codes vont ensemble — en fournir un seul serait un mapping a
      // moitie, donc un refus.
      // ⚠ ON JUGE SUR LA PRESENCE DU PARAMETRE, PAS SUR `parseInt`.
      // Juger sur le resultat de `parseInt` transformait une valeur ILLISIBLE en
      // « pas de mapping demande » : `shared/api-client.js` interpole toujours
      // les deux parametres, donc un code `undefined` partait en
      // `room_type_code=undefined` -> NaN -> canal cree VIDE, puis active, et
      // l'ecran annoncait « votre etablissement est connecte » alors que rien
      // n'etait mappe. Avant ce diff, ce cas rendait 400 : il doit continuer.
      const demandeMapping = req.query.room_type_code !== undefined
        || req.query.rate_plan_code !== undefined
      if (demandeMapping && !(Number.isInteger(roomTypeCode) && Number.isInteger(ratePlanCode))) {
        return res.status(400).json({
          error: 'room_type_code ET rate_plan_code, entiers, ou aucun des deux',
          message: 'Un mapping a moitie — ou avec un code illisible — ne veut rien dire. Sans '
            + 'aucun des deux, le canal est cree sans mapping : c\'est le cas nominal avant '
            + 'l\'approbation dans l\'extranet.'
        })
      }
      const avecMapping = demandeMapping

      const dryRun = req.query.dry_run !== 'false'

      // Bien resolu et perimetre verifie avant tout appel au gestionnaire de
      // canaux. Le filtre user_id porte sur le compte PROPRIETAIRE.
      const garde = await requirePermission(req, res, {
        domaine: 'reglages', niveau: 'write', bien: providerPropertyId, bienRequis: true
      })
      if (!garde.ok) return
      const compteBien = garde.accountUserId

      // Ownership + rate_plan_id Channex du bien.
      const { data: prop, error: propErr } = await supabase
        .from('properties')
        // ⚠ `migration_target_property_id` : un bien en migration se cree un canal
        // sur sa propriete CIBLE, pas sur sa cle source (qui rend 422 chez Channex).
        .select('id, name, provider, provider_property_id, migration_target_property_id, '
          + 'provider_rate_plan_id, capacity')
        .eq('user_id', compteBien)
        // Sur les DEUX identifiants, comme la garde : sinon un appelant qui
        // designe le bien par sa propriete cible franchit la garde et recoit
        // un 404.
        .or(`provider_property_id.eq.${providerPropertyId},migration_target_property_id.eq.${providerPropertyId}`)
        .maybeSingle()
      if (propErr) {
        console.error('[channel-bcom-write] SELECT error', propErr.message)
        return res.status(500).json({ error: 'Erreur lecture' })
      }
      if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })
      if (!prop.provider_rate_plan_id) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (provisioning incomplet)' })
      }

      // ⚠ L'ADRESSE CHEZ LE PROVIDER, PAS LA CLE D'OWNERSHIP. Voir
      // `proprieteChezLeProvider` (lib/rate-sync.js) : pendant une migration, ce
      // sont deux identifiants differents.
      const idChezLeProvider = proprieteChezLeProvider(prop)
      if (!idChezLeProvider) {
        return res.status(409).json({ error: 'pas_de_propriete_chez_le_provider',
          message: 'Ce logement n\'existe pas chez le canal de distribution : creer d\'abord sa propriete.' })
      }

      // Champs de mapping (defauts = payload valide ; surchargables en query).
      const occupancy = Number.isInteger(parseInt(req.query.occupancy, 10))
        ? parseInt(req.query.occupancy, 10) : (prop.capacity || 1)
      const pricingType = (req.query.pricing_type || 'Standard').trim()   // decision RLO->Standard
      const primaryOcc = req.query.primary_occ !== 'false'                 // defaut true
      const readonly = req.query.readonly === 'true'                       // defaut false
      const title = (req.query.title || `Booking.com — ${prop.name || ''}`).trim()

      const grp = await resolveGroupId(idChezLeProvider)
      if (!grp.group_id) {
        return res.status(502).json({ error: 'group_id introuvable pour ce bien (GET /groups)', http: grp.http })
      }

      // ⚠ LA CREATION MAPPE LE DERIVE, COMME `action=map`.
      // J'avais corrige `map` et OUBLIE `create` — la branche que l'ecran de
      // liaison utilise reellement. Constate le 10 septembre 2026 sur le canal
      // Booking de Cœur de vie 23, cree depuis le tableau de bord : mappe sur
      // `ad0a594e-…` = « Tarif Standard », le plan de BASE. Consequence
      // silencieuse : l'OTA lit le prix non derive, la commission Booking et le
      // `min_stay` portes par `property_channel_rate_plans` disparaissent.
      // Meme decision, meme fonction, meme refus que `map`.
      //
      // ⚠ SEULEMENT QUAND UN MAPPING EST DEMANDE. Sans codes, le canal se cree
      // vide et il n'y a aucun tarif a choisir : exiger le derive la
      // rendrait la creation impossible avant l'approbation de l'OTA, ce que
      // toute cette branche existe pour permettre.
      //
      // ⚠ ET PAS DE GARDE `canPushRates` ICI, contrairement a `map`.
      // `map` change la source de prix d'un canal DEJA en place : c'est un
      // changement de comportement. `create` pose le PREMIER mapping d'un canal
      // cree INACTIF — rien n'est pousse avant l'activation. Gater ici aurait
      // refuse l'onboarding de tout nouvel hote, dont le bien nait en
      // `rate_sync_mode = 'keep'`.
      let ratePlanCreate = prop.provider_rate_plan_id
      if (avecMapping) {
        const { data: liensC, error: eLiensC } = await supabase
          .from('property_channel_rate_plans')
          .select('provider_rate_plan_id')
          .eq('property_id', prop.id)
          .eq('channel', 'booking')
          .eq('role', 'derived')
          .neq('is_active', false)
        if (eLiensC) {
          console.error('[channel-bcom-write] property_channel_rate_plans', eLiensC.message)
          return res.status(500).json({ error: 'Erreur lecture' })
        }
        const choixC = choisirTarifDerive(liensC)
        if (!choixC.ok) return res.status(choixC.http).json(choixC.corps)
        ratePlanCreate = choixC.ratePlanId
      }

      // is_active:false FORCE cote serveur — non pilotable par l'appelant.
      const payload = {
        channel: {
          channel: OTA_CODE,
          group_id: grp.group_id,
          is_active: false,
          title,
          known_mappings_list: [],
          properties: [idChezLeProvider],
          // Vide tant que les codes de l'OTA ne sont pas lisibles : le mapping
          // est un geste d'apres l'approbation.
          rate_plans: avecMapping ? [
            {
              rate_plan_id: ratePlanCreate,
              settings: {
                occ_changed: false,
                occupancy,
                pricing_type: pricingType,
                primary_occ: primaryOcc,
                rate_plan_code: ratePlanCode,
                readonly,
                room_type_code: roomTypeCode
              }
            }
          ] : [],
          // ⚠ `hotel_id` EN NOMBRE, ET C'EST MESURE (10 septembre 2026).
          // En CHAINE, `POST /channels` rend HTTP 500 « internal_server_error »
          // SANS AUCUN detail — pas un 422 qui nommerait le champ. Trois autres
          // variantes ont ete essayees avant de trouver (sans rate_plans, sans
          // group_id, avec machine_account) : le seul changement qui fait passer
          // la creation de 500 a 201 est le TYPE de cet identifiant.
          //
          // L'ecran de liaison Booking de l'hote (components/booking-connect.js)
          // aurait donc echoue ici, juste apres une verification reussie — au
          // pire moment, et sans rien pour comprendre.
          //
          // ⚠ ET L'EXIGENCE EST INVERSE SUR LES APPELS DE LECTURE.
          // `test_connection`, `mapping_details` et `connection_details`
          // veulent `hotel_id` en CHAINE : en NOMBRE, `mapping_details` rend
          // HTTP 422 avec `{"errors":null}` — un corps vide, indiscernable
          // d'un refus de l'OTA. C'est exactement ce piege qui a fait
          // diagnostiquer a tort « Channex n'est pas autorise chez Booking »
          // le 10 septembre, et supprimer un canal correctement cree.
          // La creation veut un NOMBRE, la lecture veut une CHAINE : les deux
          // formes ne sont donc jamais interchangeables, contrairement a ce
          // qui etait note ici. `settingsFor` (api/channel-bcom.js) impose
          // deja la chaine du cote lecture — ne pas l'aligner sur celui-ci.
          // Le comportement du `PUT /channels/:id` n'a pas ete mesure.
          settings: { hotel_id: Number(hotelId) }
        }
      }

      // DRY-RUN (defaut) : montre le payload EXACT, rien n'est envoye.
      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method: 'POST', path: '/channels', payload }
        })
      }

      // ENVOI REEL : POST /channels uniquement. Aucun push ARI (allowlist).
      const w = await channelCall('POST', '/channels', payload)
      const channelId = w.json?.data?.id || w.json?.data?.attributes?.id || null

      // PREUVE : relecture du canal cree (lecture pure). is_active doit etre false.
      let proof = null
      if (channelId) {
        const after = await channelCall('GET', `/channels/${channelId}`)
        proof = {
          http: after.status,
          is_active: after.json?.data?.attributes?.is_active ?? null,
          rate_plans_count: Array.isArray(after.json?.data?.attributes?.rate_plans)
            ? after.json.data.attributes.rate_plans.length : null
        }
      }

      return res.status(w.ok ? 200 : 502).json({
        // ⚠ `error` EST OBLIGATOIRE SUR UN ECHEC, ET SON ABSENCE A COUTE.
        // `shared/api-client.js` construit son message avec `data.error` :
        // sans ce champ, un refus de Channex arrivait au front en
        // « Erreur serveur », et l'ecran de liaison affichait « la connexion
        // n'a pas pu etre finalisee » sans jamais dire pourquoi. La raison
        // reelle etait dans `result`, que le front jette. Mesure du
        // 10 septembre : un second canal Booking sur un bien qui en a deja un
        // se refusait ainsi en silence, et le bouton « Reessayer » rejouait
        // indefiniment le meme refus.
        ...(w.ok ? {} : { error: raisonChannex(w.json, 'La creation du canal a ete refusee') }),
        dry_run: false,
        http: w.status,
        channel_id: channelId,
        sent_payload: payload,
        result: redact(w.json),
        proof,
        // Commande d'annulation prete a l'emploi.
        delete_hint: channelId ? `?action=delete&channel_id=${channelId}&dry_run=false` : null
      })
    }

    // ================= MAP : poser le mapping APRES l'approbation =============
    // ⚠ CETTE ACTION EXISTE PARCE QUE LA CREATION NE PEUT PLUS TOUT FAIRE.
    // Les codes `room_type_code` / `rate_plan_code` ne sont lisibles chez l'OTA
    // qu'UNE FOIS la connexion approuvee dans l'extranet — et c'est la creation
    // du canal qui declenche cette demande. Sans cette action, un canal cree
    // sans mapping n'avait pour seule sortie que DELETE + recreation, donc une
    // NOUVELLE demande d'approbation : la boucle que la phase 1 cherche a eviter.
    //
    // Elle ne touche QUE le mapping : `is_active` n'est jamais envoye, et
    // l'allowlist reseau interdit toujours tout push ARI.
    if (action === 'map') {
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })
      if (!DELETE_CHANNEL_RE.test(`/channels/${channelId}`)) {
        return res.status(400).json({ error: 'channel_id invalide' })
      }
      const roomTypeCode = parseInt(req.query.room_type_code, 10)
      const ratePlanCode = parseInt(req.query.rate_plan_code, 10)
      if (!Number.isInteger(roomTypeCode) || !Number.isInteger(ratePlanCode)) {
        return res.status(400).json({
          error: 'room_type_code et rate_plan_code (entiers Booking) requis',
          message: 'Ils se lisent chez l\'OTA par `POST /channels/mapping_details`, une fois '
            + 'la connexion approuvee dans l\'extranet.'
        })
      }

      const gardeCanal = await requirePermissionPourCanal(req, res, { channelId, channelCall })
      if (!gardeCanal.ok) return

      // Le rate plan Channex du bien porte par ce canal.
      const bienDuCanal = String(gardeCanal.bienDuCanal || '')
      const { data: propM, error: propMErr } = await supabase
        .from('properties')
        .select('id, name, provider, provider_property_id, migration_target_property_id, provider_rate_plan_id, capacity')
        .or(`provider_property_id.eq.${bienDuCanal},migration_target_property_id.eq.${bienDuCanal}`)
        .maybeSingle()
      if (propMErr) {
        console.error('[channel-bcom-write] SELECT error', propMErr.message)
        return res.status(500).json({ error: 'Erreur lecture' })
      }
      if (!propM || !propM.provider_rate_plan_id) {
        return res.status(404).json({ error: 'Bien du canal introuvable ou sans rate plan' })
      }

      // ⚠ ON MAPPE LE TARIF DERIVE DU CANAL, PAS LE TARIF DE BASE.
      // Ce code envoyait `propM.provider_rate_plan_id` — le plan « Tarif
      // Standard », celui du coeur. Mesure du 10 septembre sur le canal
      // Booking de Colomiers, le seul qui fonctionne en production : il mappe
      // `55b784ba-…` = « Colomiers — booking (derive) », pas
      // `06a3f06c-…` = « Tarif Standard ». Mapper la base envoie a l'OTA le
      // prix NON derive : la commission Booking et le `min_stay` portes par
      // `property_channel_rate_plans` disparaissent, et toute la table devient
      // decorative.
      //
      // ⚠ ON REFUSE, ON NE RETOMBE PAS SUR LA BASE. J'avais mis un repli
      // « mieux vaut un mapping non derive qu'un refus », signale par un
      // booleen dans la reponse. Defaut releve en review : sur le chemin qui
      // ECRIT, ce booleen est noye dans un JSON a cote de `http: 200` et de
      // `rate_plans_after` — ca se lit comme un succes, et le prix non derive
      // part chez l'OTA quand meme. C'est exactement le defaut que ce diff
      // corrige, reintroduit par sa propre prudence. Le chemin jumeau tranche
      // deja ainsi : `api/channel-rateplan.js` (`action=remap`, `to=derived`)
      // rend HTTP 400 « Aucun rate plan derive booking en base ».
      //
      // ⚠ PAS DE `.eq('is_active', true)` : personne ne l'applique ailleurs
      // (quatre lectures dans api/channel-rateplan.js filtrent channel+role
      // seuls), le seul writer l'insere a `true` en dur et `set_rule` n'y
      // touche jamais. Une ligne a `is_active` NULL — posee a la main, ou
      // anterieure au defaut de colonne — serait donc invisible ICI et visible
      // partout ailleurs : deux verites, et c'est la divergente qui ecrirait
      // chez l'OTA. `.neq` laisse passer NULL, et n'exclut que le `false`
      // explicite.
      //
      // ⚠ PAS DE `.maybeSingle()` : aucune migration du depot ne cree cette
      // table, donc rien ne garantit `unique(property_id, channel)`. En cas de
      // doublon, `maybeSingle` sortait en 500 « Erreur lecture » sans
      // diagnostic. On lit, et on refuse en le disant.
      const { data: liens, error: lienErr } = await supabase
        .from('property_channel_rate_plans')
        .select('provider_rate_plan_id, derive_mode, derive_value, min_stay')
        .eq('property_id', propM.id)
        .eq('channel', 'booking')
        .eq('role', 'derived')
        .neq('is_active', false)
      if (lienErr) {
        console.error('[channel-bcom-write] property_channel_rate_plans', lienErr.message)
        return res.status(500).json({ error: 'Erreur lecture' })
      }
      const choix = choisirTarifDerive(liens)
      if (!choix.ok) return res.status(choix.http).json(choix.corps)
      const ratePlanCible = choix.ratePlanId

      // ⚠ MEME GARDE TARIFAIRE QUE LE CHEMIN JUMEAU. Choisir le tarif que
      // l'OTA lira EST une decision tarifaire : `api/channel-rateplan.js`
      // gate son `remap` par `canPushRates` avec ce motif exact. Un bien en
      // `keep` (Beds24 maitre des prix) ne doit pas voir son canal Booking
      // pointe sur le derive HoteSmart. Le dry-run reste autorise : il n'ecrit
      // rien, et c'est lui qui sert a montrer avant le geste.
      if (req.query.dry_run === 'false' && !canPushRates(propM)) {
        return res.status(200).json({ ...RATE_PUSH_BLOCKED })
      }

      const occupancyM = Number.isInteger(parseInt(req.query.occupancy, 10))
        ? parseInt(req.query.occupancy, 10) : (propM.capacity || 1)
      const payloadM = {
        channel: {
          // ⚠ ON N'ENVOIE QUE LE MAPPING, ET C'EST DELIBERE.
          // J'avais ajoute `settings: { hotel_id }` « au cas ou le PUT remplace
          // l'objet comme la creation ». Trois defauts, tous signales en review :
          // le comportement du PUT n'est PAS mesure (il n'est atteignable
          // qu'apres l'approbation extranet) ; renvoyer une seule cle de
          // `settings` aurait EFFACE les autres si le remplacement etait reel
          // (Channex y met `machine_account` et sept reglages de paiement) ; et
          // exiger de relire ce champ ouvrait un 502 sur une lecture non
          // garantie — le meme canal ne rend pas `group_id`, pourtant exige a
          // l'ecriture. Une prudence non mesuree qui casse vaut moins que le
          // comportement qui marchait.
          rate_plans: [{
            rate_plan_id: ratePlanCible,
            settings: {
              occ_changed: false,
              occupancy: occupancyM,
              pricing_type: (req.query.pricing_type || 'Standard').trim(),
              primary_occ: req.query.primary_occ !== 'false',
              rate_plan_code: ratePlanCode,
              readonly: req.query.readonly === 'true',
              room_type_code: roomTypeCode
            }
          }]
        }
      }

      const dryRunM = req.query.dry_run !== 'false'
      if (dryRunM) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method: 'PUT', path: `/channels/${channelId}`, payload: payloadM },
          rate_plan_id: ratePlanCible,
          note: 'Le mapping seul. `is_active` n\'est pas envoye : l\'activation reste un geste a part.'
        })
      }

      const wM = await channelCall('PUT', `/channels/${channelId}`, payloadM)
      // PREUVE : on relit le canal et on rend son mapping.
      const apres = await channelCall('GET', `/channels/${channelId}`)
      const ratePlansApres = apres.json?.data?.attributes?.rate_plans || []
      return res.status(wM.ok ? 200 : 502).json({
        ...(wM.ok ? {} : { error: raisonChannex(wM.json, 'Le mapping a ete refuse') }),
        dry_run: false,
        http: wM.status,
        channel_id: channelId,
        sent_payload: payloadM,
        result: redact(wM.json),
        rate_plans_count: ratePlansApres.length,
        rate_plans_after: redact(ratePlansApres),
        is_active_after: apres.json?.data?.attributes?.is_active ?? null
      })
    }

    // ================= DELETE : annulation =================
    if (action === 'delete') {
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })
      if (!DELETE_CHANNEL_RE.test(`/channels/${channelId}`)) {
        return res.status(400).json({ error: 'channel_id invalide' })
      }

      // ⚠ FUITE CORRIGEE : cette branche n'avait AUCUNE garde. Seule la branche
      // `create` en avait recu une. N'importe quel utilisateur authentifie
      // pouvait donc supprimer n'importe quel canal Channex par son id — y
      // compris actif, le garde-fou 409 etant contournable par `force=1` que
      // l'appelant fournit lui-meme.
      const gardeCanal = await requirePermissionPourCanal(req, res, { channelId, channelCall })
      if (!gardeCanal.ok) return

      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'DELETE', path: `/channels/${channelId}` } })
      }

      // Garde-fou : DELETE exige un canal inactif (le notre l'est). Refus si actif sans force.
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true && !force) {
        return res.status(409).json({ error: 'Canal actif : DELETE refuse (force=1 pour outrepasser).', channel_id: channelId })
      }

      const w = await channelCall('DELETE', `/channels/${channelId}`)

      // PREUVE : re-GET -> 404 / plus de data = supprime.
      const gone = await channelCall('GET', `/channels/${channelId}`)
      const deleted = gone.status === 404 || !gone.json?.data

      return res.status(w.ok ? 200 : 502).json({
        dry_run: false,
        http: w.status,
        channel_id: channelId,
        deleted,
        result: redact(w.json)
      })
    }

    return res.status(400).json({ error: 'action inconnue (create | delete)' })
  } catch (e) {
    console.error('[channel-bcom-write]', action, e.message)
    return res.status(500).json({ error: e.message })
  }
}

// ⚠ EXPORTS SECONDAIRES, SANS TOUCHER AU DEFAUT. `module.exports` reste la
// fonction handler — Vercel l'appelle telle quelle. On accroche les deux
// fonctions pures dessus pour que les tests les exercent directement, au lieu
// de lire la source et de rester verts quand la regle s'inverse.
module.exports.choisirTarifDerive = choisirTarifDerive
module.exports.raisonChannex = raisonChannex
