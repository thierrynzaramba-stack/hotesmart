// api/channel-property.js
// Gere la creation et la liste des biens cote channel manager
// POST : cree property + room_type + rate_plan + push dispo 365j + INSERT Supabase
// GET  : liste les biens du user courant
//
// inventory_type :
//   whole = logement entier  -> count_of_rooms=1, dispo 1 sur 365j (le seul supporte aujourd'hui)
//   room / hotel             -> multi-unites, tarifs mutualisables (NON encore supporte)

const { createClient } = require('@supabase/supabase-js')
const { peutCouperLaPousseeDesPrix } = require('../lib/pilote-tarifaire')
const { requirePermission, UUID_RE, REF_SURE_RE } = require('../lib/require-permission')
const { refusPlancher, valeurEffective } = require('../lib/plancher-vs-base')
const { refsDuPerimetre } = require('../lib/permissions')
const { poserDerivesParDefaut } = require('../lib/rate-plans-derives')
const { clesMigrees } = require('../lib/cles-migrees')

const { surveillerReponse } = require('../lib/reponse-partenaire')
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Helpers cote channel manager
const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: {
      'user-api-key': CHANNEL_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  // ⚠ OBSERVATION SEULE (etape 1 du chantier « 200 sans JSON »). Un 2xx
  // dont le corps n'est pas exploitable est NOTE et sonne, et c'est tout :
  // la valeur rendue ci-dessous ne change pas d'un caractere. Les chemins
  // qui en tirent une conclusion destructrice se corrigent ensuite, un par
  // un. docs/kb/reponse-200-sans-json.md.
  await surveillerReponse({ fichier: 'api/channel-property.js', methode: method, chemin: path,
                            statut: res.status, texte: text })
  return { ok: res.ok, status: res.status, json }
}

async function channelDelete(path) {
  try {
    await channelCall('DELETE', path)
  } catch (e) {
    console.error('[channel] rollback failed', path, e.message)
  }
}

// Rollback DURCI de la property (le seul delete qui compte : sans property, les
// room_type/rate_plan orphelins sont inertes et invisibles). Retente une fois
// avant d'abandonner. Renvoie true si la property est bien supprimee (ou absente),
// false si un fantome subsiste cote channel manager -> l'appelant doit le signaler.
async function rollbackProperty(providerPropertyId) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await channelCall('DELETE', `/properties/${providerPropertyId}`)
      if (r.ok || r.status === 404) return true   // supprimee, ou deja absente
      console.error('[channel-property] rollback property non-ok', attempt, r.status, r.json)
    } catch (e) {
      console.error('[channel-property] rollback property exception', attempt, e.message)
    }
  }
  return false
}

// Date ISO (YYYY-MM-DD) decalee de n jours par rapport a aujourd'hui.
function isoPlusDays(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

// URLs d'annonces fournies par l'hote lors d'une demande de connexion OTA
// (Option B : mapping manuel). Objet { booking?, airbnb? }, les deux facultatifs.
// Ne garde que des URLs http(s) plausibles, tronquees a 500 car. Renvoie null
// si rien d'exploitable -> l'hote a pu demander sans coller de lien.
function sanitizeListingUrls(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of ['booking', 'airbnb']) {
    const v = raw[key]
    if (typeof v !== 'string') continue
    const url = v.trim().slice(0, 500)
    if (/^https?:\/\/\S+$/i.test(url)) out[key] = url
  }
  return Object.keys(out).length ? out : null
}

// Construit sell_mode + options d'un rate_plan a partir des parametres de prix.
// SOURCE UNIQUE de la formule (creation ET modification) pour ne jamais diverger.
// extraFee > 0 -> per_person (progression Airbnb-like) ; sinon per_room (prix unique).
function buildRatePlanOptions(basePrice, incGuests, extraFee, cap) {
  if (extraFee != null && extraFee > 0) {
    const options = []
    for (let i = 1; i <= cap; i++) {
      const additional = Math.max(0, i - incGuests)
      options.push({ occupancy: i, rate: Math.round((basePrice + (additional * extraFee)) * 100), is_primary: (i === cap) })
    }
    return { sell_mode: 'per_person', options }
  }
  return { sell_mode: 'per_room', options: [{ occupancy: cap, rate: Math.round(basePrice * 100), is_primary: true }] }
}

// Les canaux ACTIFS d'un bien, par leur OTA. `null` = on n'a pas pu savoir.
//
// ⚠ `null` N'EST PAS « AUCUN ». Prendre une panne de lecture pour « ce bien
// n'est connecte nulle part » laisserait passer le `keep` qu'on veut refuser —
// et le refus existe precisement pour empecher un logement de se retrouver sans
// personne pour le tarifer.
async function canauxActifsDuBien (prop) {
  const cle = prop && (prop.provider_property_id || prop.migration_target_property_id)
  if (!cle) return []
  try {
    const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(cle)}`)
    if (!r || !r.ok) return null
    const rows = Array.isArray(r.json?.data) ? r.json.data : []
    return rows
      .filter(c => c.attributes?.is_active === true)
      .map(c => String(c.attributes?.channel || c.attributes?.ota_name || 'canal'))
  } catch (e) {
    console.error('[channel-property] lecture des canaux echec', e.message)
    return null
  }
}

module.exports = async function handler(req, res) {
  // ===== AUTH (pattern beds24.js) =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })

  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide' })
  }
  const user = userData.user

  // ===== GET : liste des biens (FUSION Beds24 + Channex) =====
  if (req.method === 'GET') {
    // ⚠ COMPTE COURANT, pas l'appelant. C'est le seul endpoint qui compose la
    // liste des biens des DEUX providers : sans lui, un membre delegue ne verrait
    // aucun bien Beds24 — la cle PMS n'etant pas lisible cote client (RLS
    // `auth.uid()` stricte, et c'est voulu). La garde revalide l'en-tete
    // X-Compte : etre membre actif de ce compte, ou rien.
    const gardeGet = await requirePermission(req, res, {
      domaine: 'reservations', niveau: 'read', userId: user.id,
      // Seul endpoint de ce lot ouvert a la delegation : c'est lui qui alimente
      // la liste des biens, donc tout le reste de l'interface.
      compteDelegue: true
    })
    if (!gardeGet.ok) return
    const compteLecture = gardeGet.accountUserId

    // ⚠ FILTRE DE PERIMETRE. Sans lui, un membre invite sur UN bien recevait le
    // portefeuille COMPLET du titulaire — noms, adresses, prix de base, URLs
    // d'annonces. C'est une collection : le perimetre ne peut pas se verifier
    // bien par bien, il doit devenir un filtre (comme messages et menages).
    const refsPerimetre = refsDuPerimetre(gardeGet.contexte)
    if (Array.isArray(refsPerimetre) && refsPerimetre.length === 0) {
      return res.status(200).json({ properties: [] })
    }

    let qProps = supabase
      .from('properties')
      // ⚠ `migration_target_property_id` : c'est elle qui rend un bien EN COURS
      // DE MIGRATION eligible aux ecrans de connexion OTA. Sans elle, un bien
      // encore `provider = 'beds24'` mais deja pourvu de sa propriete Channex
      // n'apparaissait nulle part — l'hote ne pouvait pas le connecter, et il
      // n'y avait aucun autre chemin dans le produit.
      .select('id, name, provider, provider_property_id, migration_target_property_id, currency, address, zip_code, city, country, capacity, base_price, prix_minimum, included_guests, extra_guest_fee, inventory_type, rate_sync_mode, pilote_tarifaire, ota_connect_status, ota_requested_at, ota_listing_urls, photo_url, created_at')
      .eq('user_id', compteLecture)
    if (refsPerimetre) {
      // ⚠ LE PIEGE UUID, POUR LA TROISIEME FOIS. `properties.id` est de type
      // uuid : y passer une reference Beds24 numerique (« 209413 ») fait echouer
      // la requete ENTIERE en 22P02, pas renvoyer zero ligne. Le membre voyait
      // « Erreur de chargement des biens » et croyait a une panne.
      // C'est exactement ce que documente resoudreBien depuis la regression SMS —
      // et refsDuPerimetre melange DELIBEREMENT les deux formes.
      // La branche `id` ne recoit donc que des UUID, et n'est meme pas emise
      // quand il n'y en a aucun.
      const sures = refsPerimetre.filter(r => REF_SURE_RE.test(r))
      if (!sures.length) return res.status(200).json({ properties: [] })
      const uuids = sures.filter(r => UUID_RE.test(r))
      const filtres = [`provider_property_id.in.(${sures.join(',')})`]
      if (uuids.length) filtres.unshift(`id.in.(${uuids.join(',')})`)
      qProps = qProps.or(filtres.join(','))
    }
    const { data: chanData, error: chanErr } = await qProps
      .order('created_at', { ascending: false })
    if (chanErr) {
      console.error('[channel-property] SELECT error', chanErr.message)
      return res.status(500).json({ error: 'Erreur lecture' })
    }
    // Les biens Beds24 sont servis par le fetch live plus bas. Depuis leur materialisation
    // en table (cron), on EXCLUT ici les lignes provider='beds24' pour ne pas les renvoyer
    // deux fois. provider null = ancien bien channex -> conserve. Sortie ainsi identique
    // a l'avant-materialisation : tous les consommateurs de cet endpoint restent corrects.
    // ⚠ SAUF LES BIENS EN COURS DE MIGRATION, ET C'EST TOUT L'ENJEU.
    // Un bien qui porte une `migration_target_property_id` a deja sa propriete
    // chez le nouveau provider : il doit etre servi DEPUIS LA BASE, comme
    // n'importe quel bien du canal. Servi par le fetch live Beds24, il arrivait
    // sans cette colonne — donc invisible aux ecrans de connexion, et le
    // correctif de leurs filtres restait inerte.
    //
    // Aggravant, et c'est le vrai risque : une fois le bien DEMAPPE de Beds24,
    // l'API Beds24 ne le renvoie plus et sa ligne locale etait filtree ici — le
    // bien DISPARAISSAIT purement et simplement de la liste de l'hote, au milieu
    // de sa migration. Trouve en review.
    const enMigration = (p) => !!p.migration_target_property_id
      && String(p.provider_property_id) !== String(p.migration_target_property_id)

    const channexProps = (chanData || [])
      .filter(p => p.provider !== 'beds24' || enMigration(p))
      .map(p => ({ ...p, provider: p.provider || 'channex' }))
    // Les identifiants deja servis depuis la base : le fetch live ne doit pas
    // les rendre une seconde fois.
    const dejaServis = new Set(channexProps.map(p => String(p.provider_property_id)))
    let beds24Props = []
    try {
      const { data: keyData } = await supabase
        .from('api_keys')
        .select('api_key')
        .eq('user_id', compteLecture)
        .single()
      if (keyData && keyData.api_key) {
        const r = await fetch('https://beds24.com/api/v2/properties', { headers: { token: keyData.api_key } })
        const d = await r.json()
        // ⚠ CINQUIEME PORTE DE LA MEME FAMILLE, ET LA PREMIERE EN LECTURE.
        // Le bien migre RESTE dans le compte Beds24 (filet de rollback, regle N2
        // du plan) : l'API du provider le rend donc toujours, et cette liste le
        // servait aux ecrans. Mesure du 11 septembre 2026 : Thierry voyait
        // QUATRE biens au lieu de deux — « Cœur de vie « La bulle » » et
        // « coeur de vie 23 » (les fantomes Beds24, qui portent les noms
        // d'origine) a cote de « La bulle » et « Cœur de vie l 23 » (les vraies
        // fiches). C'est exactement le piege qui lui avait coute une frayeur a
        // minuit cote Channex, cette fois dans son propre tableau de bord.
        //
        // Conséquences au-dela de la confusion : le calendrier les exclut avec
        // le bandeau « gere dans Beds24 », et la messagerie appelle
        // `/api/beds24` pour eux.
        //
        // Les quatre autres portes sont cote ECRITURE (materialisation,
        // snapshots, messages, codes d'acces) ; celle-ci ne fait que lire, et
        // c'est pourquoi elle avait echappe a l'inventaire.
        const migrees = await clesMigrees(supabase, compteLecture, 'beds24')
        // ⚠ GARDE AVEUGLE : on n'ajoute RIEN plutot que d'ajouter des fantomes.
        // Ici la liste Beds24 n'est qu'un complement de `channexProps`, qui vient
        // du coeur et reste juste : l'ecran garde donc les biens qu'on connait.
        // Mais on ne se tait pas — « je ne sais pas » n'est pas « non » : la
        // reponse porte le drapeau, et un hote purement Beds24 doit pouvoir
        // comprendre pourquoi son bien manque au lieu de le croire disparu.
        // ⚠ GARDE AVEUGLE : ON REFUSE LA REQUETE. NI FANTOMES, NI LISTE AMPUTEE.
        // Ma premiere version omettait le complement Beds24 et posait un drapeau
        // `beds24_indisponible` dans une reponse 200. Releve en review : AUCUN
        // front ne lisait ce drapeau, et un 200 a liste vide est la pire des
        // reponses — `shared/properties.js` rendait `allFailed: false`, donc
        // la messagerie affichait « Connecter mon logement » a un hote deja
        // connecte, et `pages/onboarding.html` reconciliait contre une liste
        // amputee, ce qui CREE des biens en double chez le canal. Une lecture
        // indisponible ne doit jamais declencher une ecriture.
        //
        // Un 503 est la seule reponse vraie : le client leve (shared/api-client.js),
        // `allFailed` passe a true, et l'ecran dit « chargement casse » au lieu
        // de « vous n'avez aucun bien ». La cecite dure au plus 5 s (cache
        // d'echec), donc un rechargement suffit.
        if (migrees.lectureEnEchec) {
          console.error('[channel-property] garde AVEUGLE : liste refusee (ni fantomes, ni liste amputee)')
          return res.status(503).json({
            error: 'La liste de vos biens est momentanément indisponible. Réessayez dans un instant.'
          })
        }
        beds24Props = (d.data || [])
          // ⚠ Les biens Beds24 arrivent de l'API du provider, pas de la base :
          // aucune RLS ne les borne. Le perimetre doit etre applique ICI, sinon
          // un membre restreint recevrait tous les biens Beds24 du titulaire.
          .filter(b => !refsPerimetre || refsPerimetre.includes(String(b.id)))
          // Deja servi depuis la base (bien en migration) : pas deux fois.
          .filter(b => !dejaServis.has(String(b.id)))
          // Migre : il ne doit plus apparaitre du tout.
          .filter(b => !migrees.has(String(b.id)))
          .map(b => ({
          id: b.id,
          name: b.name,
          provider: 'beds24',
          provider_property_id: b.id,
          currency: b.currency || 'EUR',
          address: b.address || '',
          city: b.city || '',
          country: b.country || '',
          capacity: (b.roomTypes && b.roomTypes[0] && b.roomTypes[0].maxPeople) || 1,
          inventory_type: 'whole',
          // ⚠ Champs BRUTS Beds24 conserves : shared/properties.js n'appelle plus
          // /api/beds24 getProperties, qui les renvoyait. Sans eux, l'accueil
          // perd sa ligne « Check-in / Check-out » pour tous les biens Beds24.
          checkInStart:  b.checkInStart  || null,
          checkInEnd:    b.checkInEnd    || null,
          checkOutEnd:   b.checkOutEnd   || null,
          created_at: null
        }))
      }
    } catch (e) {
      console.warn('[channel-property] Beds24 list skipped:', e.message)
    }
    // ⚠ LES CANAUX DESCENDENT AVEC LES BIENS, LUS DANS LE COEUR (dette 59).
    // Avant, l'ecran les demandait au partenaire EN DIRECT, un appel par bien,
    // a chaque affichage — et quand le partenaire se taisait, les pastilles
    // disparaissaient sans un mot : l'hote lisait « aucun canal » la ou il en
    // a deux. Ici, un seul aller-retour, et la date du dernier releve descend
    // avec, pour que l'ecran puisse dire de quand date ce qu'il montre.
    //
    // ⚠ UNE LECTURE DE CANAUX EN ECHEC NE VIDE PAS LA LISTE DES BIENS. Les
    // biens sont la vraie reponse ; les canaux sont un ornement. On les laisse
    // vides et on le journalise.
    const tous = [...beds24Props, ...channexProps]
    try {
      const ids = tous.map(b => String(b.id)).filter(Boolean)
      if (ids.length) {
        const { data: lignes, error: eC } = await supabase
          .from('canaux_du_bien')
          .select('property_id, ota, titre, actif, mappe_pour_ce_bien, listing_url, vu_le')
          .eq('user_id', compteLecture)
          .in('property_id', ids)
          .is('disparu_le', null)
          .limit(ids.length * 20)
        if (eC) throw new Error(eC.message)
        const parBien = new Map()
        for (const l of lignes || []) {
          const k = String(l.property_id)
          if (!parBien.has(k)) parBien.set(k, [])
          parBien.get(k).push({
            // ⚠ AUCUN IDENTIFIANT DU PARTENAIRE NE DESCEND, ni son nom : la
            // requete ne les demande meme pas, et le privilege par colonne les
            // refuserait de toute facon a un client.
            ota: l.ota, titre: l.titre, actif: l.actif === true,
            mappe: l.mappe_pour_ce_bien, listing_url: l.listing_url || null
          })
        }
        // ⚠ LA FRAICHEUR EST CELLE DU BIEN, PAS CELLE DU COMPTE. L'horloge
        // `canaux_releve` tient la cadence du releve ; elle ne dit pas de
        // quand datent LES CANAUX DE CE BIEN-LA. Poser la meme date sur toutes
        // les cartes ferait dire a chacune « verifie il y a 7 min » en parlant
        // d'autre chose qu'elle. On prend donc le `vu_le` le PLUS ANCIEN des
        // canaux du bien — le plus prudent — et on ne retombe sur l'horloge du
        // compte que pour un bien SANS canal, ou c'est la seule date qui
        // existe.
        const { echecVisibleParLHote, COLONNES_HORLOGE_ECRAN,
                fraicheurDuBien } = require('../lib/canaux-du-bien')
        const { data: h, error: eH } = await supabase.from('canaux_releve')
          .select(COLONNES_HORLOGE_ECRAN)
          .eq('user_id', compteLecture).maybeSingle()
        // ⚠ ET CET ECHEC SE DIT. `const { data: h }` jetait l'erreur : un refus
        // de privilege ou un hoquet rendait `h` nul, donc aucun bandeau et
        // aucune trace — le poste qui doit DIRE les pannes se taisait sur la
        // sienne. Famille « erreur avalee, cron a 200 ». Constat de la revue
        // de 6754f48.
        if (eH) console.error('[channel-property] horloge des canaux illisible :', eH.message)
        const horloge = h ? h.vu_le : null
        // ⚠ UN ECHEC DE RELEVE DESCEND JUSQU'A L'ECRAN. Sans ce drapeau,
        // l'hote voyait sa date de verification vieillir sans jamais savoir
        // POURQUOI — et nous non plus : le 19 octobre, une heure de diagnostic
        // pour une panne qui ne laissait aucune trace lisible. Le releve est
        // au grain du COMPTE : le drapeau vaut donc pour tous ses biens.
        // ⚠ UN EFFACEMENT SUSPENDU N'EST PAS UN ECHEC DE LECTURE. Le
        // disjoncteur rend `ok: false` pour que le cron et l'alarme le voient,
        // mais la lecture a reussi : l'hote ne doit RIEN lire d'anormal. Sans
        // ce `!== 'suspendu'`, le mot « verification impossible » s'afficherait
        // sur une lecture qui a parfaitement fonctionne.
        // ⚠ ET SEULEMENT SI LE RELEVE CONCERNE CE COMPTE. Un compte sans
        // aucun bien chez ce partenaire n'est plus releve du tout : sa ligne
        // `canaux_releve` reste a `ok: false` pour toujours, et le bandeau
        // serait affiche a vie sans qu'aucun bouton puisse l'eteindre — le
        // bouton appelle precisement le chemin qui n'ecrit rien. Vaut aussi
        // pour un compte entierement Beds24. Constat de la revue de 6754f48.
        const releveEnEchec = channexProps.length > 0 && echecVisibleParLHote(h)
        const datesParBien = new Map()
        for (const l of lignes || []) {
          const k = String(l.property_id)
          if (!datesParBien.has(k)) datesParBien.set(k, [])
          datesParBien.get(k).push({ vu_le: l.vu_le })
        }
        for (const b of tous) {
          b.canaux = parBien.get(String(b.id)) || []
          b.canaux_vu_le = fraicheurDuBien(datesParBien.get(String(b.id)), horloge)
          b.canaux_echec = releveEnEchec
        }
      }
    } catch (e) {
      console.error('[channel-property] canaux illisibles :', e.message)
      for (const b of tous) { b.canaux = null; b.canaux_vu_le = null; b.canaux_echec = false }
    }
    return res.status(200).json({ properties: tous })
  }

  // ===== PATCH : modification d'un bien =====
  // Body : { property_id (uuid Supabase), name?, address?, city?, zip_code?, country?,
  //          capacity?, base_price?, included_guests?, extra_guest_fee?, rate_sync_mode?,
  //          ota_connect_status?, ota_listing_urls? }
  // Devise volontairement NON modifiable (changement mal supporte cote Channex).
  if (req.method === 'PATCH') {
    const { property_id: pid, name, address, city, zip_code, country, rate_sync_mode,
      ota_connect_status, ota_listing_urls, capacity, base_price, included_guests, extra_guest_fee,
      prix_minimum } = req.body || {}
    if (!pid) return res.status(400).json({ error: 'property_id requis' })

    // Modification d'un bien = domaine `reglages` en ecriture, sur CE bien.
    // Le filtre user_id des requetes suivantes porte sur le compte PROPRIETAIRE
    // (garde.accountUserId), pas sur l'appelant : sinon un membre delegue
    // franchirait la garde puis recevrait 404, la delegation etant inoperante.
    const gardePatch = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'write', bien: pid, bienRequis: true
    })
    if (!gardePatch.ok) return
    const compteBien = gardePatch.accountUserId
    // ⚠ L'UUID RESOLU PAR LA GARDE, PAS LE PARAMETRE BRUT (revue de l'etape 3
    // du lot Logements, 22 octobre 2026). `resoudreBien` accepte une reference
    // PARTENAIRE, et quatre endpoints sur cinq repartent deja de `garde.bien.id`.
    // Ici on repartait de `pid` : depuis `/logements/209413`, la fiche
    // s'affichait entierement, et toute sauvegarde rendait 404 « Bien
    // introuvable » sur un bien manifestement present (`.eq('id', '209413')`
    // sur une colonne uuid -> 22P02). C'est le quatrieme passage du piege UUID.
    const bienPid = gardePatch.bien ? gardePatch.bien.id : pid

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      // ⚠ `migration_target_property_id` EST LU PAR `canauxActifsDuBien` : une
      // garde qui juge sur une colonne non selectionnee est une garde ouverte
      // (lecon deja payee sur `base_price` et le cran d'arret). Un bien en
      // cours de bascule porte ses canaux sous sa cle CIBLE.
      // ⚠ `prix_minimum` A ETE AJOUTE LE 22 OCTOBRE 2026, ET SON ABSENCE AVAIT
      // ROUVERT LA GARDE DU PLANCHER. Mesure de recette de Thierry : plancher
      // 50 EUR en base, prix de base passe a 20 EUR -> 200, « Enregistre »,
      // valeur persistee, aucun refus. La garde lisait `prop.prix_minimum`, qui
      // valait `undefined` faute d'etre SELECTIONNE : elle ne pouvait pas
      // mordre. C'est mot pour mot la lecon ecrite deux lignes plus haut pour
      // `migration_target_property_id` — « une garde qui juge sur une colonne
      // non selectionnee est une garde ouverte » — et je l'ai repayee.
      .select('id, provider, provider_property_id, migration_target_property_id, provider_room_type_id, provider_rate_plan_id, capacity, base_price, prix_minimum, included_guests, extra_guest_fee, pilote_tarifaire')
      .eq('id', bienPid)
      .eq('user_id', compteBien)
      .single()
    if (propErr || !prop) return res.status(404).json({ error: 'Bien introuvable' })

    const updates = {}
    if (name !== undefined && String(name).trim()) updates.name = String(name).trim().slice(0, 100)
    if (address !== undefined) updates.address = address ? String(address).trim().slice(0, 200) : null
    if (city !== undefined) updates.city = city ? String(city).trim().slice(0, 100) : null
    if (zip_code !== undefined) updates.zip_code = zip_code ? String(zip_code).trim().slice(0, 20) : null
    if (country !== undefined && country) updates.country = String(country).trim().slice(0, 2).toUpperCase()

    // ─── Prix plancher, en CENTIMES ───────────────────────────────────────
    // ⚠ NE TOUCHE NI LA GRILLE NI L'ARI : ce n'est pas un tarif, c'est un
    // refus. Aucune poussee provider n'en decoule, contrairement a
    // `base_price` — d'ou son traitement a part, hors du bloc prix/occupation.
    // `null` est une valeur legitime : « pas de plancher propre, on retombe
    // sur le plancher global du code ».
    if (prix_minimum !== undefined) {
      if (prix_minimum === null || prix_minimum === '') {
        updates.prix_minimum = null
      } else {
        const cents = Math.round(Number(prix_minimum))
        if (!Number.isFinite(cents) || cents <= 0 || cents > 10000000) {
          // ⚠ UNE PHRASE, PAS UN NOM DE COLONNE ET UNE UNITE INTERNE (revue de
          // l'etape 3). L'hote saisit des EUROS dans un champ libelle
          // « Prix plancher » : lui rendre « prix_minimum invalide (centimes,
          // > 0) » lui parle d'une colonne et d'une unite qu'il n'a jamais vues.
          return res.status(400).json({
            error: 'prix_minimum_invalide',
            message: 'Le prix plancher doit etre un montant superieur a zero.'
          })
        }
        updates.prix_minimum = cents
      }
    }

    // ⚠ UN PLANCHER AU-DESSUS DU PRIX DE BASE REND LE BIEN INVENDABLE, et la
    // regle vit maintenant dans `lib/plancher-vs-base.js` : elle se juge sur les
    // deux valeurs EFFECTIVES, et plus seulement sur ce que porte le corps.
    // Son en-tete raconte pourquoi (l'ecran V5 a separe les deux champs).
    {
      const refus = refusPlancher({
        plancherCents: valeurEffective(updates.prix_minimum,
          prop.prix_minimum != null ? Number(prop.prix_minimum) : null),
        basePriceEuros: valeurEffective(
          base_price !== undefined ? Number(base_price) : undefined, Number(prop.base_price))
      })
      if (refus) return res.status(400).json(refus)
    }

    // Mode de prix : reserve aux biens OTA/Channex (un bien Beds24 n'a pas de rate_sync_mode
    // pertinent). Valeurs contraintes en base, revalidees ici.
    if (rate_sync_mode !== undefined) {
      if (!['keep', 'managed'].includes(rate_sync_mode)) {
        return res.status(400).json({ error: 'rate_sync_mode invalide (keep | managed)' })
      }
      if (prop.provider !== 'channex' && prop.provider !== 'channel') {
        return res.status(400).json({ error: 'Le mode de prix ne s applique qu aux biens connectes aux plateformes' })
      }
      // ⚠ `keep` EST DEVENU IMPOSSIBLE SUR UN BIEN A CANAL ACTIF, ET CE N'EST
      // PAS UN DURCISSEMENT ARBITRAIRE. Constat de terrain du 11 septembre 2026
      // sur l'extranet Booking : des qu'un channel manager est lie, la
      // plateforme REFUSE que l'hote edite ses tarifs (« modification
      // obligatoire par le CM »). En `keep`, plus PERSONNE ne peut donc tarifer
      // le logement — ni l'hote chez l'OTA, ni nous — et le seul prix qui
      // subsiste est celui que nous avons pousse au provisionnement. Un bien
      // reel s'est vendu ainsi 31 nuits a 199 € a plat.
      //
      // Le libelle « Je garde mes prix » promettait donc quelque chose que
      // l'OTA interdit. On refuse, et on DIT pourquoi : un refus muet renverrait
      // l'hote a l'ecran sans qu'il comprenne ce qui vient de lui etre epargne.
      if (rate_sync_mode === 'keep') {
        // ⚠ LA PORTE INVERSE DE B BIS (lot 4.5). Le §2 bis interdit de faire
        // passer un bien « Je garde mes prix » sous YieldFlow. Rien n'y
        // interdisait le chemin SYMETRIQUE : couper la poussee d'un bien DEJA
        // pilote par YieldFlow atteint le meme etat interdit — l'app ecrit des
        // prix que plus rien n'envoie, `calendar_inventory` porte une strategie
        // invisible des plateformes, et le journal ne voit rien.
        //
        // On REFUSE plutot que de retomber en 'calendrier' tout seul : le choix
        // de l'ecrivain appartient a l'hote, et « rien ne change sans son
        // geste » est la regle du lot.
        const verrou = peutCouperLaPousseeDesPrix(prop)
        if (!verrou.ok) {
          return res.status(409).json({ error: verrou.error, code: verrou.code })
        }
        const canauxActifs = await canauxActifsDuBien(prop)
        if (canauxActifs === null) {
          return res.status(502).json({
            error: 'Impossible de verifier l etat de vos connexions pour le moment. Reessayez.'
          })
        }
        if (canauxActifs.length) {
          return res.status(409).json({
            error: 'Votre bien est connecté à une plateforme — vos prix ne peuvent plus être '
              + 'modifiés dans son extranet, c\'est HôteSmart qui les envoie.',
            canaux: canauxActifs
          })
        }
      }
      updates.rate_sync_mode = rate_sync_mode
    }
    // Demande de connexion OTA (Option B : mapping manuel par l'equipe HoteSmart).
    // L'hote ne peut que passer draft -> requested. Le passage a 'live' est reserve
    // a l'admin (endpoint dedie, allow-list ADMIN_EMAILS) : jamais depuis ici.
    if (ota_connect_status !== undefined) {
      if (ota_connect_status !== 'requested') {
        return res.status(400).json({ error: 'Transition de statut non autorisee' })
      }
      if (prop.provider !== 'channex' && prop.provider !== 'channel') {
        return res.status(400).json({ error: 'Statut OTA reserve aux biens connectes aux plateformes' })
      }
      updates.ota_connect_status = 'requested'
      updates.ota_requested_at = new Date().toISOString()   // horodatage serveur, jamais le client
    }
    // URLs d'annonces (facultatives) : validees/tronquees, ou null si rien d'exploitable.
    if (ota_listing_urls !== undefined) {
      updates.ota_listing_urls = sanitizeListingUrls(ota_listing_urls)
    }

    // ===== Champs prix / occupation (modifiables apres creation) =====
    // Ces champs definissent le rate_plan (et le room_type pour la capacite) cote
    // Channex. Une ecriture DB seule ferait diverger DB et Channex -> plus bas on
    // reconstruit le rate_plan EN PLACE (meme provider_rate_plan_id : les mappings de
    // canaux qui referencent cet id ne sont pas casses), de facon BLOQUANTE.
    let pricingTouched = false
    let grilleSautee = false     // vrai si la grille n'a pas pu etre reconstruite (pas de prix de base)
    let effCap, effBase, effInc, effExtra
    if (capacity !== undefined || base_price !== undefined || included_guests !== undefined || extra_guest_fee !== undefined) {
      if (prop.provider !== 'channex' && prop.provider !== 'channel') {
        return res.status(400).json({ error: 'Champs prix reserves aux biens connectes aux plateformes' })
      }
      pricingTouched = true
      // Valeur effective = nouvelle valeur si fournie, sinon valeur actuelle en base.
      effCap = capacity !== undefined ? parseInt(capacity, 10) : Number(prop.capacity)
      if (!effCap || effCap < 1 || effCap > 20) return res.status(400).json({ error: 'capacite_invalide', message: 'La capacite doit etre un nombre entre 1 et 20.' })
      // ⚠ `base_price` PEUT ETRE ABSENT, ET CE N'EST PLUS UNE ERREUR.
      // Constat de review du 8 septembre 2026 : `Number(null)` vaut 0, donc un
      // bien sans prix de base voyait sa fiche VERROUILLEE — impossible de
      // toucher la capacite, les voyageurs inclus ou le supplement, avec un
      // message qui lui reprochait un prix de base dont on venait de decider
      // qu'il n'en a pas besoin (moteur direct, option A).
      //
      // Un prix de base FOURNI reste valide normalement. Ce qui change : son
      // absence n'interdit plus de modifier le reste — elle interdit seulement
      // de reconstruire la GRILLE tarifaire, qui n'aurait aucun montant a
      // porter. Voir le bloc de poussee plus bas.
      if (base_price !== undefined && base_price !== null && base_price !== '') {
        effBase = parseFloat(base_price)
        if (!effBase || effBase <= 0 || effBase > 100000) {
          return res.status(400).json({ error: 'prix_de_base_invalide', message: 'Le prix de base doit etre un montant superieur a zero.' })
        }
      } else {
        const enBase = prop.base_price != null ? Number(prop.base_price) : null
        effBase = (enBase && enBase > 0) ? enBase : null
      }
      effInc = included_guests !== undefined
        ? ((included_guests === null || included_guests === '') ? effCap : parseInt(included_guests, 10))
        : (prop.included_guests != null ? Number(prop.included_guests) : effCap)
      if (!effInc || effInc < 1 || effInc > effCap) return res.status(400).json({ error: 'inclus_invalide', message: 'Le nombre de voyageurs inclus doit aller de 1 a la capacite du logement.' })
      effExtra = extra_guest_fee !== undefined
        ? ((extra_guest_fee === null || extra_guest_fee === '') ? null : parseFloat(extra_guest_fee))
        : (prop.extra_guest_fee != null ? Number(prop.extra_guest_fee) : null)
      // ⚠ `NaN` PASSAIT. Dette pre-existante relevee en review : `parseFloat('abc')`
      // rend NaN, et `(NaN < 0 || NaN > 100000)` est FAUX — la garde laissait
      // passer, puis supabase-js serialisait NaN en `null` : le supplement etait
      // efface en silence au lieu de rendre un 400.
      if (effExtra != null && (!Number.isFinite(effExtra) || effExtra < 0 || effExtra > 100000)) {
        return res.status(400).json({ error: 'supplement_invalide', message: 'Le supplement par voyageur doit etre un montant positif.' })
      }

      // ⚠ SANS PRIX DE BASE, LA GRILLE NE PEUT PAS ETRE RECONSTRUITE — et alors
      // toucher a l'occupation ferait DIVERGER la DB et Channex.
      // Constat de review : le room_type partirait a `occ_adults: 4` pendant que
      // les options du rate plan s'arreteraient a 2, et la DB dirait 4. Le
      // commentaire de ce bloc promet exactement l'inverse (« une ecriture DB
      // seule ferait diverger DB et Channex »). On refuse plutot que de mentir.
      grilleSautee = !effBase
      const occupationBouge = capacity !== undefined || included_guests !== undefined || extra_guest_fee !== undefined
      if (grilleSautee && occupationBouge && prop.provider_rate_plan_id) {
        return res.status(409).json({
          error: 'grille_non_reconstructible',
          message: 'Ce logement n\'a pas de prix de base : la grille tarifaire ne peut pas etre reconstruite, '
            + 'et modifier la capacite ou l\'occupation ferait diverger HoteSmart de la plateforme. '
            + 'Renseignez un prix de base pour ce logement, ou modifiez ces champs avant de le connecter.'
        })
      }
      updates.capacity = effCap
      updates.base_price = effBase
      updates.included_guests = effInc
      updates.extra_guest_fee = effExtra
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Aucun champ a modifier' })

    // Sync prix/occupation cote Channex (BLOQUANT : si echec, on n'ecrit PAS en DB pour
    // ne pas diverger). room_type mis a jour si la capacite change ; rate_plan reconstruit
    // en place via la formule partagee. Fait AVANT le PUT property cosmetique.
    if (pricingTouched && (prop.provider === 'channex' || prop.provider === 'channel') && prop.provider_property_id) {
      if (capacity !== undefined && prop.provider_room_type_id) {
        const rtRes = await channelCall('PUT', `/room_types/${prop.provider_room_type_id}`, {
          room_type: { occ_adults: effCap, default_occupancy: effCap }
        })
        if (!rtRes.ok) {
          console.error('[channel-property] PATCH room_type echec', rtRes.status, rtRes.json)
          return res.status(502).json({ error: 'Mise a jour de la capacite echouee cote plateforme' })
        }
      }
      // ⚠ SANS PRIX DE BASE, ON NE RECONSTRUIT PAS LA GRILLE.
      // `buildRatePlanOptions(null, …)` produirait `Math.round(null * 100)` = 0,
      // donc une grille a 0 €. Et le staging l'a mesure : Channex IGNORE un
      // rate a 0 et garde la grille precedente — on ecrirait donc soit du zero,
      // soit rien, en croyant avoir mis a jour.
      //
      // Ce n'est pas une perte : depuis le 8 septembre 2026, `runFullSync`
      // pousse chaque date avec son propre prix et FERME celles qui n'en ont
      // pas. La grille du rate plan ne sert que de defaut aux dates non
      // poussees — et il n'y en a plus.
      if (prop.provider_rate_plan_id && !grilleSautee) {
        const rp = buildRatePlanOptions(effBase, effInc, effExtra, effCap)
        const rpRes = await channelCall('PUT', `/rate_plans/${prop.provider_rate_plan_id}`, {
          rate_plan: { sell_mode: rp.sell_mode, options: rp.options }
        })
        if (!rpRes.ok) {
          console.error('[channel-property] PATCH rate_plan echec', rpRes.status, rpRes.json)
          return res.status(502).json({ error: 'Mise a jour du tarif echouee cote plateforme' })
        }
      }
    }

    // Sync cote channel manager (best effort, non bloquant)
    let channelSynced = null
    if ((prop.provider === 'channex' || prop.provider === 'channel') && prop.provider_property_id) {
      const chBody = { property: {} }
      if (updates.name) chBody.property.title = updates.name
      if (updates.address !== undefined) chBody.property.address = updates.address || undefined
      if (updates.city !== undefined) chBody.property.city = updates.city || undefined
      if (updates.zip_code !== undefined) chBody.property.zip_code = updates.zip_code || undefined
      if (updates.country) chBody.property.country = updates.country
      if (Object.keys(chBody.property).length) {
        const r = await channelCall('PUT', `/properties/${prop.provider_property_id}`, chBody)
        channelSynced = r.ok
        if (!r.ok) console.error('[channel-property] PATCH sync channel echec', r.status, r.json)
      }
    }

    const { data: updated, error: updErr } = await supabase
      .from('properties')
      .update(updates)
      .eq('id', bienPid)
      .eq('user_id', compteBien)
      .select()
      .single()
    if (updErr) {
      console.error('[channel-property] UPDATE error', updErr.message)
      return res.status(500).json({ error: 'Erreur de mise a jour' })
    }
    return res.status(200).json({
      property: updated,
      channel_synced: channelSynced,
      // Dit a l'hote ce qui n'a PAS ete fait, plutot que de le laisser croire
      // que sa grille tarifaire a suivi.
      grille_non_reconstruite: grilleSautee || undefined,
      note: grilleSautee
        ? 'Ce logement n\'a pas de prix de base : la grille tarifaire n\'a pas ete reconstruite. Vos prix par date restent la seule source, et une date sans prix part fermee.'
        : undefined
    })
  }

  // ===== DELETE : suppression complete d'un bien =====
  // Body : { property_id (uuid Supabase) }
  // Supprime chez le channel manager (canaux compris) PUIS purge Supabase :
  // properties + toutes les donnees liees par property_id (= provider_property_id).
  // DESTRUCTIF ET DEFINITIF — la confirmation est cote UI.
  if (req.method === 'DELETE') {
    const { property_id: pid } = req.body || {}
    if (!pid) return res.status(400).json({ error: 'property_id requis' })

    // ⚠ ACTION DESTRUCTRICE : supprime le bien ET purge toutes ses donnees liees
    // (bookings_snapshot, menage_events, messages…). Exige `reglages` en
    // ecriture sur CE bien. Comme pour PATCH, les requetes suivantes portent sur
    // le compte PROPRIETAIRE, pas sur l'appelant.
    const gardeDelete = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'write', bien: pid, bienRequis: true
    })
    if (!gardeDelete.ok) return
    const compteBien = gardeDelete.accountUserId
    // ⚠ L'UUID RESOLU, comme au PATCH : une reference partenaire dans l'URL
    // rendait 404 sur un bien bien present (le piege UUID, quatrieme passage).
    const bienPid = gardeDelete.bien ? gardeDelete.bien.id : pid

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, name, provider, provider_property_id, provider_rate_plan_id')
      .eq('id', bienPid)
      .eq('user_id', compteBien)
      .single()
    if (propErr || !prop) return res.status(404).json({ error: 'Bien introuvable' })

    const providerId = prop.provider_property_id

    // ⚠⚠ GARDE-FOU DE LA SUPPRESSION : C'EST LA MEME FONCTION QUE L'ECRAN, ET
    // ELLE LIT LE COEUR. Correctif du 26 octobre 2026, apres une review qui a
    // trouve la garde precedente MORTE DE DEUX FACONS INDEPENDANTES.
    //
    // La version d'avant interrogeait le partenaire et comparait le
    // `rate_plan_id` de chaque mapping a `prop.provider_rate_plan_id`, c'est-a-dire
    // au plan de BASE. Or `api/channel-mapping.js` ecrit lui-meme, depuis le
    // correctif du 10 septembre 2026, que tous les mappings pointent le plan
    // DERIVE du canal et que « ce match n'aboutit PLUS JAMAIS ». Le refus etait
    // donc inatteignable. Et le bloc entier etait de surcroit conditionne par
    // `prop.provider_rate_plan_id` : un bien sans plan de base ne le traversait
    // meme pas.
    //
    // Resultat mesure dans le code : un bien channex relie a une annonce Airbnb
    // par son plan derive se supprimait SANS 409 — `DELETE /properties/{id}`
    // chez le partenaire, puis purge de `bookings_snapshot`, `messages`,
    // `menages` et `message_sent_log`, l'annonce restant en vente. Irreversible.
    //
    // ⚠ ET C'EST LA CLASSE DE DEFAUT GRAVEE AU CLAUDE.md : « UN MASQUAGE PAR
    // DROIT NE SUFFIT JAMAIS ». L'ecran avait ete durci deux fois (recette du
    // 22 octobre, revue du 23) pour desactiver « Supprimer » sur un mappage
    // relie ou indetermine. Le serveur, lui, ne refusait rien — et le masquage
    // ne tombe jamais devant une requete faite a la main.
    //
    // ⚠ ON N'ECRIT PAS LA REGLE UNE SECONDE FOIS. `suppressionPossible` est
    // exportee par lib/logement/lecture.js « pour qu'une regle ne soit ecrite
    // qu'une fois » — ce sont ses mots. Deux copies divergent : c'est
    // exactement ce qui vient de se produire entre l'ecran et ce handler. On
    // appelle donc LA fonction, avec les memes entrees, et le refus porte le
    // motif qu'elle rend.
    {
      const { suppressionPossible } = require('../lib/logement/lecture')
      const { echecVisibleParLHote, COLONNES_HORLOGE_ECRAN } = require('../lib/canaux-du-bien')

      // ⚠ LA LIMITE EST UNE BORNE DE PRUDENCE, PAS UNE TRONCATURE ACCEPTEE.
      // Une lecture tronquee rendrait une liste de canaux INCOMPLETE, donc un
      // « aucun canal mappe » qui ne veut rien dire — le defaut des 1000 lignes
      // silencieuses du depot. Si la limite est atteinte, on ne conclut pas :
      // on refuse en indetermine.
      const LIGNES_MAX = 200
      const { data: lignes, error: eCanaux } = await supabase
        .from('canaux_du_bien')
        .select('ota, titre, actif, mappe_pour_ce_bien')
        .eq('user_id', compteBien)
        .eq('property_id', String(bienPid))
        .is('disparu_le', null)
        .limit(LIGNES_MAX)

      // ⚠ `null` ET `[]` NE SE CONFONDENT PAS, et c'est tout le sujet :
      // `suppressionPossible` rend `canaux_illisibles` sur `null` (on ne sait
      // pas) et poursuit sur `[]` (ce bien n'est en vente nulle part). Passer
      // un tableau vide sur une erreur de lecture transformerait une panne en
      // autorisation.
      let canaux = null
      if (eCanaux) {
        console.error('[channel-property] DELETE : canaux_du_bien illisible', eCanaux.message)
      } else if ((lignes || []).length >= LIGNES_MAX) {
        console.error('[channel-property] DELETE : canaux_du_bien tronque a', LIGNES_MAX)
      } else {
        canaux = (lignes || []).map(l => ({
          ota: l.ota, titre: l.titre, actif: l.actif === true, mappe: l.mappe_pour_ce_bien
        }))
      }

      // L'horloge du releve, pour le cas `jamais_releve` : l'ecran refuse quand
      // AUCUNE ligne de canal n'existe et que le releve n'a jamais abouti —
      // parce qu'alors l'absence de canal ne prouve rien.
      let releveDuCompte = null
      let releveEnEchec = false
      {
        const { data: h, error: eH } = await supabase.from('canaux_releve')
          .select(COLONNES_HORLOGE_ECRAN)
          .eq('user_id', compteBien)
          .maybeSingle()
        // ⚠ UNE HORLOGE ILLISIBLE N'EST PAS UNE HORLOGE ABSENTE, mais les deux
        // menent au meme refus prudent ici : `releveDuCompte` reste `null`.
        if (eH) console.error('[channel-property] DELETE : canaux_releve illisible', eH.message)
        else {
          // ⚠ `vu_le`, PAS LA LIGNE. C'est la valeur que l'ecran passe
          // (lib/logement/lecture.js : `horloge: horlogeLigne ? horlogeLigne.vu_le : null`),
          // et ce handler annonce « memes entrees ». Passer la ligne entiere la
          // rend toujours truthy : une ligne existante SANS `vu_le` — l'etat
          // d'un releve qui n'a jamais rien ecrit, puisque `noterLeReleve` ne
          // pose `vu_le` que si `bilan.ok || bilan.ecrits > 0` — serait lue
          // « releve abouti » ici et « jamais releve » a l'ecran. Aujourd'hui
          // l'autre moitie de la condition (`releveEnEchec`) rattrape ce cas,
          // donc l'ecart est inerte ; une divergence inerte reste une
          // divergence, et c'est elle qui a coute la garde morte.
          releveDuCompte = h ? (h.vu_le || null) : null
          releveEnEchec = echecVisibleParLHote(h)
        }
      }

      const verdict = suppressionPossible(prop, canaux, {
        releveDuCompte, releveEnEchec, peutSupprimer: true
      })
      if (verdict.possible !== true) {
        const MESSAGES = {
          annonce_reliee: 'Ce logement est encore relié à une annonce Airbnb ou Booking. '
            + 'Déconnectez-le d\'abord (bouton « Déconnecter cette annonce » dans l\'assistant '
            + 'de connexion), puis vous pourrez le supprimer.',
          mapping_inconnu: 'Nous n\'avons pas pu établir si ce logement est encore relié à une '
            + 'annonce. Rien n\'a été supprimé. Réessayez dans quelques minutes, ou déconnectez '
            + 'l\'annonce depuis l\'assistant de connexion.',
          canaux_illisibles: 'Nous n\'avons pas pu lire les annonces de ce logement. Rien n\'a '
            + 'été supprimé. Réessayez dans quelques minutes.',
          jamais_releve: 'Les annonces de ce compte n\'ont encore jamais été relevées : nous ne '
            + 'pouvons pas affirmer que ce logement n\'est plus en vente. Rien n\'a été supprimé.'
          // ⚠ PAS DE `droit_refuse` ICI, ET C'EST VOLONTAIRE. `suppressionPossible`
          // le rend quand `peutSupprimer` est faux ; on lui passe `true`, parce
          // que le DROIT a deja ete tranche en amont par `requirePermission`,
          // qui refuse en 403. Porter ce motif dans cette table ferait rendre
          // 409 a un refus de droit — or le depot a une regle explicite : « le
          // test qui tranche : si on retire le masquage et qu'on clique, le
          // serveur refuse-t-il ? Si la reponse n'est pas "oui, en 403", il n'y
          // a pas de garde. » Un 409 ici brouillerait cette mesure.
        }
        // ⚠ UN MOTIF INCONNU REFUSE AUSSI. `suppressionPossible` en rend cinq
        // aujourd'hui — quatre arrivent ici, `droit_refuse` etant tranche en
        // amont. Si elle en gagne un sixieme, le defaut de ce handler doit
        // etre le REFUS, pas le passage : une suppression irreversible ne se
        // decide pas par omission.
        return res.status(409).json({
          error: MESSAGES[verdict.motif]
            || 'La suppression de ce logement est refusée : son état n\'a pas pu être établi. '
               + 'Rien n\'a été supprimé.',
          motif: verdict.motif || 'refus_sans_motif'
        })
      }
    }

    // 1. Suppression cote channel manager
    //
    // ⚠ UN REFUS DU PARTENAIRE ARRETE TOUT, ET LA PURGE N'A PAS LIEU
    // (decision de Thierry, 26 octobre 2026). La version d'avant journalisait
    // l'echec et purgeait quand meme, avec ce commentaire : « On n'avorte pas :
    // l'utilisateur veut supprimer son bien. »
    //
    // Ce raisonnement produit le pire des deux etats : la propriete reste chez
    // le partenaire — donc l'annonce reste en vente et continue de recevoir des
    // reservations — pendant que HoteSmart a efface les reservations, les
    // messages et les menages qui lui permettraient de les traiter. L'hote se
    // retrouve avec un bien qui vend et un systeme aveugle, et rien ne le lui
    // dit : la reponse portait un simple drapeau.
    //
    // Un bien non supprime se re-supprime ; des reservations purgees ne
    // reviennent pas.
    //
    // ⚠ UN 404 RESTE UN SUCCES, et ce n'est pas une indulgence : il veut dire
    // que la propriete n'est DEJA plus chez le partenaire. Refuser la purge
    // dans ce cas rendrait le bien definitivement insupprimable.
    let channelDeleted = null
    if ((prop.provider === 'channex' || prop.provider === 'channel') && providerId) {
      const r = await channelCall('DELETE', `/properties/${providerId}`)
      channelDeleted = r.ok || r.status === 404
      if (!channelDeleted) {
        console.error('[channel-property] DELETE channel echec', r.status, r.json)
        return res.status(409).json({
          error: 'Le gestionnaire de canaux a refusé de supprimer ce logement. '
            + 'Rien n\'a été supprimé chez HôteSmart : vos réservations, messages et '
            + 'ménages sont intacts. Réessayez dans quelques minutes.',
          motif: 'partenaire_refuse',
          statut_partenaire: r.status
        })
      }
    }

    // 2. Purge des donnees liees (property_id TEXT = id provider)
    if (providerId) {
      const propKey = String(providerId)

      // message_sent_log n'a pas de property_id : purge via les booking_id du bien
      //
      // ⚠ LECTURE PAGINEE. Constat de review du 7 septembre 2026.
      // Cette lecture n'avait aucune borne : sur un bien portant plus de 1000
      // reservations, PostgREST en rendait 1000 SANS ERREUR, et la purge
      // manquait silencieusement les `message_sent_log` des autres — precisement
      // les donnees orphelines que le commentaire ci-dessous dit vouloir eviter.
      // Une purge incomplete ne se rattrape pas : le bien n'existe plus, et plus
      // rien ne relie ces lignes a quoi que ce soit.
      const bookingIds = []
      {
        const PAGE = 1000
        for (let de = 0; ; de += PAGE) {
          const { data, error } = await supabase
            .from('bookings_snapshot')
            .select('booking_id')
            .eq('user_id', compteBien)
            .eq('property_id', propKey)
            // L'ordre rend la pagination deterministe.
            .order('booking_id', { ascending: true })
            .range(de, de + PAGE - 1)
          if (error) {
            console.error('[channel-property] lecture booking_id pour purge echec', error.message)
            break
          }
          bookingIds.push(...(data || []).map(r => r.booking_id))
          if (!data || data.length < PAGE) break
        }
      }
      // `.in()` accepte mal une liste immense : on supprime par paquets.
      for (let i = 0; i < bookingIds.length; i += 500) {
        await supabase.from('message_sent_log')
          .delete().eq('user_id', compteBien).in('booking_id', bookingIds.slice(i, i + 500))
      }

      // Tables enfant keyees par property_id = provider_property_id (TEXT). AUCUNE FK
      // cascade (property_id TEXT vs properties.id UUID) -> purge EXPLICITE obligatoire,
      // sinon donnees orphelines (bug messages Colomiers). Groupe AVEC colonne user_id
      // (scoping defensif) :
      const tablesWithUser = [
        'bookings_snapshot', 'booking_change_events', 'conversations', 'agent_tasks', 'message_templates',
        'knowledge', 'property_status', 'messages',
        'menage_events', 'menage_comments', 'menage_done', 'agent_prompting', 'public_tokens',
        'sms_logs'
      ]
      for (const t of tablesWithUser) {
        const { error: delErr } = await supabase.from(t).delete()
          .eq('property_id', propKey).eq('user_id', compteBien)
        if (delErr) console.error(`[channel-property] purge ${t} echec`, delErr.message)
      }
      // Groupe SANS colonne user_id : filtre property_id seul.
      const tablesNoUser = ['access_codes', 'calendar_inventory', 'channel_sync_queue']
      for (const t of tablesNoUser) {
        const { error: delErr } = await supabase.from(t).delete().eq('property_id', propKey)
        if (delErr) console.error(`[channel-property] purge ${t} echec`, delErr.message)
      }
      // airbnb_connect_sessions : sa colonne property_id = UUID HoteSmart ; la cle provider
      // est provider_property_id -> on purge par provider_property_id (= propKey).
      const { error: sessErr } = await supabase.from('airbnb_connect_sessions').delete()
        .eq('provider_property_id', propKey).eq('user_id', compteBien)
      if (sessErr) console.error('[channel-property] purge airbnb_connect_sessions echec', sessErr.message)
    }

    // 3. Suppression du bien lui-meme
    const { error: delPropErr } = await supabase
      .from('properties')
      .delete()
      .eq('id', bienPid)
      .eq('user_id', compteBien)
    if (delPropErr) {
      console.error('[channel-property] DELETE properties error', delPropErr.message)
      return res.status(500).json({ error: 'Erreur de suppression' })
    }

    console.log(`[channel-property] Bien supprime: ${prop.name} (${pid}, provider ${providerId || 'n/a'})`)
    return res.status(200).json({ deleted: true, channel_deleted: channelDeleted })
  }

  // ===== POST : creation d'un bien complet =====
  if (req.method === 'POST') {
    // ⚠ UN RELEVE A LA DEMANDE, ET SEULEMENT QUAND L'ECRAN LE PROPOSE (dette
    // 59). L'ecran n'affiche « Actualiser » qu'au-dela de 24 h sans
    // confirmation : ce chemin n'existe donc pas en temps normal. Il force le
    // releve en ignorant la cadence horaire — c'est tout son interet — mais il
    // reste borne par le writer (8 s, 5 comptes) et il ne lit QUE le
    // partenaire.
    if ((req.body || {}).action === 'relever_canaux') {
      // ⚠ `compteDelegue` COMME LE GET. Sans lui, `requirePermission` retombe
      // sur le compte de l'APPELANT : un membre qui travaille sur le compte du
      // titulaire voyait le bandeau du titulaire, cliquait, et relevait SON
      // propre compte — lecture du partenaire, ecriture de SES canaux, 200, et
      // le bandeau du titulaire toujours la. Geste inoperant, aucun mot : la
      // panne meme que ce chantier corrige. Constat de la revue de 6754f48.
      const garde = await requirePermission(req, res,
        { domaine: 'reservations', niveau: 'read', compteDelegue: true })
      if (!garde.ok) return
      // ⚠ UN PLANCHER DE CADENCE, MEME SUR LE CHEMIN FORCE. Ce chemin ignore
      // volontairement la cadence horaire — c'est son interet —, mais il
      // n'avait AUCUNE borne : chaque clic valait un appel au partenaire et,
      // pendant une suspension, une ligne `automation_incidents`
      // (`reportIncident` insere toujours, seul l'envoi est amorti). Un hote
      // qui s'acharne sur le bouton remplissait la table. Soixante secondes
      // n'enlevent rien a son geste. Constat de la revue de 6754f48.
      const { data: hAvant, error: eAvant } = await supabase.from('canaux_releve')
        .select('tente_le').eq('user_id', garde.accountUserId).maybeSingle()
      // Fail-open : sans cette date, le releve a lieu. Mais l'echec se dit —
      // c'est le motif que ce meme commit corrige plus haut.
      if (eAvant) console.error('[channel-property] cadence du releve illisible :', eAvant.message)
      const depuis = hAvant && hAvant.tente_le
        ? Date.now() - new Date(hAvant.tente_le).getTime() : null
      if (depuis !== null && depuis < 60000) {
        // ⚠ UN MOTIF, PAS UN SILENCE. Rendu sans motif, ce 200 faisait
        // RECHARGER la page pour la rendre identique, sans un mot : le defaut
        // meme que ce chantier corrige, par la porte du plancher de cadence.
        // Avec son motif, l'ecran dit « Verification faite ». Constat de la
        // re-revue.
        return res.status(200).json({ ok: true, motif: 'cadence', canaux: 0, disparus: 0 })
      }
      const { rafraichirCanauxDuCompte } = require('../lib/canaux-du-bien')
      const bilan = await rafraichirCanauxDuCompte({ userId: garde.accountUserId })
      // ⚠ ON REND 200 MEME EN ECHEC, AVEC LE MOTIF. L'ecran a deja ses canaux :
      // un releve qui rate ne doit pas lui faire croire que la page est cassee.
      return res.status(200).json({
        ok: bilan.ok, motif: bilan.motif,
        canaux: bilan.ecrits, disparus: bilan.disparus
      })
    }


    // ⚠ CETTE GARDE NE FILTRAIT RIEN, ET C'EST MESURE (19 octobre 2026, sur
    // staging). Sans ressource designee et SANS `compteDelegue`,
    // `requirePermission` fait retomber `accountUserId` sur l'APPELANT
    // (lib/require-permission.js) — et tout utilisateur authentifie est
    // titulaire de son propre compte, donc `reglages:write` etait toujours
    // accorde. Mesure : un POST de creation avec le jeton d'un membre a rendu
    // 400, le refus de la VALIDATION qui vient apres, et non 403.
    //
    // Le seul garde-fou etait le masquage du bouton « + Ajouter un bien » dans
    // pages/biens.html — et il ne masquait rien, faute de regle `[hidden]` sur
    // une page qui ne charge pas shared/ui.css.
    //
    // Ce que ca coutait : un membre creait un bien sur SON compte, et ce
    // chemin provisionne une propriete, un type de chambre et un plan tarifaire
    // CHEZ LE PARTENAIRE. Aucune fuite entre comptes — mais une ecriture chez
    // le partenaire, et un bien hors de tout suivi.
    //
    // DEUX CHANGEMENTS, ET IL FAUT LES DEUX :
    //   · `compteDelegue: true` fait venir le compte cible de l'en-tete de
    //     compte, verifie (membre actif, invitation acceptee) ;
    //   · et on exige que l'appelant soit TITULAIRE de ce compte. Sans en-tete,
    //     le compte cible est l'appelant lui-meme : le parcours normal — un
    //     hote qui cree son premier bien — passe sans changement.
    {
      const garde = await requirePermission(req, res,
        { domaine: 'reglages', niveau: 'write', compteDelegue: true })
      if (!garde.ok) return
      const { estTitulaireDuCompte } = require('../lib/permissions')
      if (!estTitulaireDuCompte({ userId: garde.userId, accountUserId: garde.accountUserId })) {
        console.log('[channel-property] refus creation : membre non titulaire du compte vise')
        return res.status(403).json({
          error: 'Seul le titulaire du compte peut ajouter un logement.' })
      }
    }

    const { name, capacity, currency, address, city, country, zip_code, base_price, included_guests, extra_guest_fee, ota_connect_status } = req.body || {}

    // Statut de connexion OTA a la creation (facultatif). Seul 'requested' est
    // accepte (parcours onboarding : l'hote demande la connexion en creant le bien).
    // Absent -> defaut DB 'draft' (cas /biens/nouveau). Jamais 'live' ici.
    if (ota_connect_status !== undefined && ota_connect_status !== 'requested') {
      return res.status(400).json({ error: 'ota_connect_status invalide (requested attendu ou champ absent)' })
    }
    const requestConnect = ota_connect_status === 'requested'

    // Type d'inventaire : defaut whole. Seul whole est supporte pour l'instant.
    const inventoryType = (req.body?.inventory_type || 'whole').toLowerCase()
    if (!['whole', 'room', 'hotel'].includes(inventoryType)) {
      return res.status(400).json({ error: "inventory_type invalide (whole | room | hotel)" })
    }
    if (inventoryType !== 'whole') {
      return res.status(501).json({
        error: "Type de bien non encore supporte. Seuls les logements entiers (whole) sont disponibles pour l'instant.",
        inventory_type: inventoryType
      })
    }

    // Validation minimale
    if (!name || typeof name !== 'string' || name.length < 1 || name.length > 100) {
      return res.status(400).json({ error: 'Nom requis (1-100 caracteres)' })
    }
    const cap = parseInt(capacity, 10)
    if (!cap || cap < 1 || cap > 20) {
      return res.status(400).json({ error: 'Capacite requise (1-20)' })
    }
    const cur = (currency || 'EUR').toUpperCase()
    const cnt = (country || 'FR').toUpperCase()

    // Prix de base requis
    const basePrice = parseFloat(base_price)
    if (!basePrice || basePrice <= 0 || basePrice > 100000) {
      return res.status(400).json({ error: 'Prix de base requis (>0)' })
    }
    // Voyageurs inclus : optionnel, defaut = capacity
    const incGuests = parseInt(included_guests, 10) || cap
    if (incGuests < 1 || incGuests > cap) {
      return res.status(400).json({ error: 'Voyageurs inclus invalide (1 a capacite)' })
    }
    // Supplement par voyageur additionnel : optionnel
    const extraFee = extra_guest_fee != null && extra_guest_fee !== '' ? parseFloat(extra_guest_fee) : null
    if (extraFee != null && (extraFee < 0 || extraFee > 100000)) {
      return res.status(400).json({ error: 'Supplement invalide' })
    }

    let providerPropertyId = null
    let providerRoomTypeId = null
    let providerRatePlanId = null

    try {
      // Etape 1 : creer property cote channel
      const propRes = await channelCall('POST', '/properties', {
        property: {
          title: name,
          currency: cur,
          property_type: 'apartment',
          country: cnt,
          zip_code: zip_code || undefined,
          timezone: 'Europe/Paris',            // TODO: deduire du pays du bien
          settings: {
            allow_availability_autoupdate_on_confirmation: true,   // defaut Channex: decremente sur nouvelle resa
            allow_availability_autoupdate_on_modification: false,  // gere par notre PMS
            allow_availability_autoupdate_on_cancellation: false   // gere par notre PMS
          }
        }
      })
      if (!propRes.ok) {
        console.error('[channel-property] POST property failed', propRes.status, propRes.json)
        return res.status(502).json({ error: 'Creation property echouee' })
      }
      providerPropertyId = propRes.json?.data?.id
      if (!providerPropertyId) {
        console.error('[channel-property] no property id in response', propRes.json)
        return res.status(502).json({ error: 'Reponse invalide' })
      }

      // Etape 2 : creer room_type
      // whole => 1 seule unite vendable (count_of_rooms verrouille a 1).
      const roomRes = await channelCall('POST', '/room_types', {
        room_type: {
          property_id: providerPropertyId,
          title: name,
          count_of_rooms: 1,
          occ_adults: cap,
          occ_children: 0,
          occ_infants: 0,
          default_occupancy: cap
        }
      })
      if (!roomRes.ok) {
        console.error('[channel-property] POST room_type failed', roomRes.status, roomRes.json)
        await channelDelete(`/properties/${providerPropertyId}`)
        return res.status(502).json({ error: 'Creation room_type echouee' })
      }
      providerRoomTypeId = roomRes.json?.data?.id

      // Etape 3 : creer rate_plan (formule partagee avec la modification -> buildRatePlanOptions)
      const rpCreate = buildRatePlanOptions(basePrice, incGuests, extraFee, cap)
      const ratePlanPayload = {
        rate_plan: {
          property_id: providerPropertyId,
          room_type_id: providerRoomTypeId,
          title: 'Tarif Standard',
          currency: cur,
          sell_mode: rpCreate.sell_mode,
          options: rpCreate.options
        }
      }
      const rateRes = await channelCall('POST', '/rate_plans', ratePlanPayload)
      if (!rateRes.ok) {
        console.error('[channel-property] POST rate_plan failed', rateRes.status, rateRes.json)
        await channelDelete(`/room_types/${providerRoomTypeId}`)
        await channelDelete(`/properties/${providerPropertyId}`)
        return res.status(502).json({ error: 'Creation rate_plan echouee' })
      }
      providerRatePlanId = rateRes.json?.data?.id

      // Etape 3bis : ouvrir la dispo (whole = 1 unite) sur 500 jours.
      // Horizon aligne sur le full sync (channel-fullsync.js days:500) : sans ca,
      // les dates J+366..J+500 naissent fermees (0) jusqu'au premier full sync.
      // Le prix n'est PAS pousse ici : une date sans tarif applique base_price.
      const availPayload = {
        values: [{
          property_id: providerPropertyId,
          room_type_id: providerRoomTypeId,
          date_from: isoPlusDays(0),
          date_to: isoPlusDays(500),
          availability: 1
        }]
      }
      let availRes = await channelCall('POST', '/availability', availPayload)
      if (!availRes.ok) {
        // Hoquet transitoire probable : une seule relance apres 2s.
        await new Promise(r => setTimeout(r, 2000))
        availRes = await channelCall('POST', '/availability', availPayload)
        if (!availRes.ok) {
          // Non bloquant pour la creation, mais on le signale : la dispo devra etre repoussee.
          console.error('[channel-property] push dispo 500j echoue apres retry', availRes.status, availRes.json)
        }
      }

      // Etape 3ter : installer l'application Messages sur la propriete.
      // Indispensable pour l'agent IA / messages auto (sinon l'API messages renvoie 403).
      // Non bloquant : si echec, le bien reste utilisable, la messagerie sera a activer.
      const appRes = await channelCall('POST', '/applications/install', {
        application_installation: {
          property_id: providerPropertyId,
          application_code: 'channex_messages'
        }
      })
      if (!appRes.ok) {
        console.error('[channel-property] install app messages echoue', appRes.status, appRes.json)
      }

      // Etape 3quater : installer l'application Booking CRS.
      // Sans elle, POST /bookings repond 403 (mesure du protocole du 6 septembre) :
      // la saisie manuelle et, plus tard, le moteur de reservation direct seraient
      // inutilisables sur ce bien. Comme pour Messages : non bloquant, le bien
      // reste utilisable sans, et l'echec est dit.
      //
      // ⚠ LES BIENS DEJA CREES N'ONT PAS CETTE APP — ce chemin ne couvre que les
      // nouveaux. Pour le parc existant (Colomiers compris), l'installation se
      // rattrape a la volee : lib/channels/channex.js expose `installerCRS`, et
      // l'appelant du verrou la declenche sur un 403.
      const crsRes = await channelCall('POST', '/applications/install', {
        application_installation: {
          property_id: providerPropertyId,
          application_code: 'booking_crs'
        }
      })
      if (!crsRes.ok) {
        console.error('[channel-property] install app booking_crs echoue', crsRes.status, crsRes.json)
      }

      // Etape 4 : INSERT en base Supabase
      const { data: insertData, error: insertError } = await supabase
        .from('properties')
        .insert({
          user_id: user.id,
          name,
          provider: 'channex',
          inventory_type: inventoryType,
          provider_property_id: providerPropertyId,
          provider_room_type_id: providerRoomTypeId,
          provider_rate_plan_id: providerRatePlanId,
          currency: cur,
          address: address || null,
          city: city || null,
          country: cnt,
          zip_code: zip_code || null,
          capacity: cap,
          base_price: basePrice,
          included_guests: incGuests,
          extra_guest_fee: extraFee,
          // ⚠ UN BIEN CREE ICI NAIT EN `managed`, ET CE N'EST PAS UN DEFAUT DE
          // CONFORT. Sans cette ligne, le defaut de la base (`keep`) s'applique
          // a un mode que l'hote n'a jamais choisi et que cet ecran ne nomme
          // nulle part — il ne se voit qu'APRES, sur la fiche du bien.
          //
          // Ce que ca produisait, mesure sur un bien reel le 11 septembre 2026 :
          // la disponibilite part TOUJOURS (anti-surreservation), les tarifs
          // seulement en `managed`. Les dates s'ouvraient donc a la vente au
          // `base_price` du provisionnement pendant que la grille de l'hote
          // restait dans le coeur. 31 nuits vendues a 199 € a plat : 14
          // sous-vendues, 4 sur-vendues de 30 € pour le voyageur, et 13 sans
          // aucun prix saisi.
          //
          // ⚠ ET `keep` N'A AUCUN SENS ICI. Il veut dire « mes prix vivent sur
          // la plateforme, n'y touche pas ». Or, constate par Thierry sur
          // l'extranet Booking : des qu'un channel manager est lie, la
          // plateforme REFUSE que l'hote edite ses tarifs (« modification
          // obligatoire par le CM »). En `keep`, personne ne peut donc tarifer
          // le logement — ni l'hote chez l'OTA, ni nous. Le seul prix qui
          // subsiste est celui que NOUS avons pousse au provisionnement.
          //
          // `keep` reste pose par le parcours de MIGRATION
          // (`lib/migration-mode-prix.js`), ou il a un sens : les prix vivent
          // encore chez l'ancien channel manager, le temps de la bascule.
          rate_sync_mode: 'managed',
          // Onboarding : l'hote demande la connexion en creant le bien. Sinon defaut DB 'draft'.
          ...(requestConnect ? { ota_connect_status: 'requested', ota_requested_at: new Date().toISOString() } : {})
        })
        .select()
        .single()

      if (insertError) {
        console.error('[channel-property] INSERT Supabase failed', insertError.message)
        // Rollback : enfants best-effort, puis property avec retry. Si la property
        // ne peut pas etre supprimee -> fantome cote channel manager : on le signale
        // distinctement (jamais silencieux) pour nettoyage manuel.
        await channelDelete(`/rate_plans/${providerRatePlanId}`)
        await channelDelete(`/room_types/${providerRoomTypeId}`)
        const cleaned = await rollbackProperty(providerPropertyId)
        if (!cleaned) {
          console.error(`[channel-property] ORPHAN provider_property_id=${providerPropertyId} (rollback incomplet apres INSERT KO)`)
          return res.status(502).json({ error: 'rollback_incomplete', orphan_property_id: providerPropertyId })
        }
        return res.status(500).json({ error: 'Sauvegarde echouee' })
      }

      // Etape 5 : LES TARIFS DERIVES PAR CANAL.
      // ⚠ SANS EUX, LE BIEN EST INCONNECTABLE A BOOKING.
      // Le mapping doit pointer le tarif DERIVE du canal, jamais la base
      // (mesure du 10 septembre 2026 sur le canal Booking de Colomiers, le seul
      // en production ; `action=map` de api/channel-bcom-write.js refuse
      // desormais en l'absence de derive). Jusqu'ici cette creation n'existait
      // qu'en action manuelle `create_derived` : un bien neuf naissait avec son
      // seul « Tarif Standard », donc sans regle de prix par canal ET sans
      // rien a mapper. Le defaut touchait TOUT nouvel hote, pas seulement la
      // migration de Bagneres — Colomiers ne l'avait pas revele parce que ses
      // derives avaient ete crees a la main.
      //
      // Non bloquant, comme les installations d'applications ci-dessus : le
      // bien reste utilisable, et l'echec est RENDU (`derives`) au lieu d'etre
      // avale. C'est ce silence qui avait laisse le trou ouvert.
      const derives = await poserDerivesParDefaut(supabase, channelCall, insertData)

      return res.status(201).json({
        property: insertData,
        dispo_pushed: availRes.ok,
        messages_app: appRes.ok,
        derives
      })

    } catch (err) {
      console.error('[channel-property] Internal error', err.message)
      if (providerRatePlanId) await channelDelete(`/rate_plans/${providerRatePlanId}`)
      if (providerRoomTypeId) await channelDelete(`/room_types/${providerRoomTypeId}`)
      if (providerPropertyId) {
        const cleaned = await rollbackProperty(providerPropertyId)
        if (!cleaned) {
          console.error(`[channel-property] ORPHAN provider_property_id=${providerPropertyId} (rollback incomplet apres exception)`)
          return res.status(502).json({ error: 'rollback_incomplete', orphan_property_id: providerPropertyId })
        }
      }
      return res.status(500).json({ error: 'Erreur interne' })
    }
  }

  return res.status(405).json({ error: 'Methode non autorisee' })
}

// Export secondaire, sans toucher au defaut : la fonction que le test tient.
module.exports.canauxActifsDuBien = canauxActifsDuBien
