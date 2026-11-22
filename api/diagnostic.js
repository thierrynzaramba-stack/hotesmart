// api/diagnostic.js
// Endpoint de diagnostic (page pages/diagnostic.html). LECTURE SEULE.
// ?check=channel        -> teste la connexion live au gestionnaire de canaux
// ?check=channel_detail -> canaux d'UN bien (mappings, is_active)
// ?check=demandes       -> fils de messages d'UN bien : demandes Airbnb (dette 129, fondateur)
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

const { surveillerReponse } = require('../lib/reponse-partenaire')
const { classement, derniersPassages } = require('../lib/cron-stats')
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

// ⚠ LU A CHAQUE APPEL, PAS AU CHARGEMENT. Une garde dont la valeur est figee
// au demarrage a froid se trompe pendant toute la vie de l'instance si la
// variable change — et elle devient intestable sans recharger le module.
const fondateur = () => String(process.env.FOUNDER_EMAIL || '').trim().toLowerCase()

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
  // ⚠ OBSERVATION SEULE (etape 1 du chantier « 200 sans JSON »). Un 2xx
  // dont le corps n'est pas exploitable est NOTE et sonne, et c'est tout :
  // la valeur rendue ci-dessous ne change pas d'un caractere. Les chemins
  // qui en tirent une conclusion destructrice se corrigent ensuite, un par
  // un. docs/kb/reponse-200-sans-json.md.
  await surveillerReponse({ fichier: 'api/diagnostic.js', methode: method, chemin: path,
                            statut: res.status, texte: text })
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

  // ?check=cron_stats&fenetre=24h|7j[&limite=N][&cron=cron|cron-messages]
  // LE COUT DU CRON : le classement des taches, trie par requetes puis par
  // temps, avec le total par jour. Lot de mesure du 22 octobre 2026.
  if (check === 'cron_stats') {
    // ⚠ RESERVE AU FONDATEUR, ET C'EST UNE GARDE SERVEUR, PAS UN MASQUAGE
    // (regle absolue du depot). La carte de la page est cachee aux autres,
    // mais c'est ici que ca se refuse : le cout de la plateforme — quelles
    // taches tournent, a quelle cadence, pour quel volume — n'est pas une
    // donnee de client, et `domaine: 'titulaire'` SANS ressource designee ne
    // filtre rien (tout utilisateur est titulaire de son propre compte).
    const garde = await requirePermission(req, res, { domaine: 'titulaire' })
    if (!garde.ok) return
    if (!fondateur()) {
      // ⚠ LE REFUS DIT SA CAUSE. Sans cette distinction, une variable absente
      // sur un projet se lit « je n'ai pas le droit » et on cherche du cote
      // des droits pendant une heure. Un diagnostic qui ne diagnostique pas
      // sa propre porte est inutile.
      return res.status(403).json({ error: 'Réservé au fondateur', motif: 'FOUNDER_EMAIL absent de la configuration' })
    }
    if (String(garde.email || '').trim().toLowerCase() !== fondateur()) {
      return res.status(403).json({ error: 'Réservé au fondateur' })
    }

    const fenetre = req.query.fenetre === '7j' ? '7j' : '24h'
    const heures = fenetre === '7j' ? 168 : 24
    // Borne explicite : une limite venant du client ne choisit pas la taille
    // d'une reponse sans plafond.
    const demandee = parseInt(req.query.limite, 10)
    const limite = Number.isFinite(demandee) ? Math.min(Math.max(demandee, 1), 200) : 10
    const quelCron = ['cron', 'cron-messages'].includes(req.query.cron) ? req.query.cron : null

    const cl = await classement(supabase, { heures, limite, cron: quelCron })
    if (!cl.ok) {
      return res.status(503).json({
        ok: false, fenetre,
        error: cl.raison === 'migration_non_appliquee'
          ? 'Table de mesure absente : migration 2026-10-22-cron-stats non appliquée'
          : 'Classement illisible',
        detail: cl.detail,
      })
    }
    const der = await derniersPassages(supabase)
    return res.status(200).json({
      ok: true, fenetre, depuis: cl.depuis,
      taches_mesurees: cl.taches,
      classement: cl.classement,
      par_jour: cl.par_jour,
      // ⚠ TRANSMIS (constat de review). Sans lui, une panne de
      // `cron_stats_par_jour` affichait un bloc « total par jour » VIDE et
      // muet, qui se lit « aucun passage » — la conclusion inverse.
      par_jour_erreur: cl.par_jour_erreur,
      derniers_passages: der.ok ? der.passages : undefined,
      derniers_passages_erreur: der.ok ? undefined : der.raison,
    })
  }

  // ?check=demandes&property_id=<bien>
  // DETTE 129, LOT 1, ETAPE 0 — MESURER AVANT D'ECRIRE. LECTURE SEULE, chez
  // le gestionnaire de canaux comme dans le coeur. Dit, pour UN bien : combien
  // de demandes (fils sans reservation), combien de fils devenus reservations
  // dont les messages dorment sans reservation chez nous, et ce que le
  // rattrapage saura rattacher. docs/specs/spec-demandes-airbnb.md §3.
  if (check === 'demandes') {
    // ⚠ UN PARAMETRE REPETE N'EST PAS UNE EXCEPTION (review 1, M2) : `?a=1&a=2`
    // arrive en tableau, et `.trim` levait avant la garde — un 500 parti sans
    // `private, no-store`. On prend la premiere valeur, la garde juge le reste.
    const brut = [].concat(req.query.property_id == null ? '' : req.query.property_id)[0]
    // Le bien vient du CLIENT : revalide contre le perimetre de l'appelant
    // (404 bien inconnu, 403 bien d'un autre compte ou hors perimetre) AVANT
    // tout appel au partenaire.
    const garde = await requirePermission(req, res, {
      domaine: 'messages', niveau: 'read',
      bien: String(brut == null ? '' : brut).trim(), bienRequis: true
    })
    if (!garde.ok) return
    // ⚠ RESERVE AU FONDATEUR (review 1, S2). Ce controle tire jusqu'a plusieurs
    // centaines d'appels sur la cle du gestionnaire de canaux, PARTAGEE par
    // tous les clients : un outil de mesure de l'etape 0, pas une fonction
    // d'hote. Meme porte que `cron_stats`, et la meme raison de dire sa cause.
    if (!fondateur()) {
      return res.status(403).json({ error: 'Réservé au fondateur', motif: 'FOUNDER_EMAIL absent de la configuration' })
    }
    if (String(garde.email || '').trim().toLowerCase() !== fondateur()) {
      return res.status(403).json({ error: 'Réservé au fondateur' })
    }
    const bien = garde.bien
    const { getProvider } = require('../lib/channels')
    const { filsADetailler, mesurer } = require('../lib/demandes/mesure')
    // ⚠ PAR LE PROVIDER DU BIEN, JAMAIS NOMME EN DUR (review 1, M1) : un
    // provider sans notion de fil le dit par l'absence du lecteur.
    let provider = null
    try { provider = getProvider(bien.provider) } catch { provider = null }
    if (!provider || typeof provider.listerFils !== 'function' || typeof provider.idsDesMessagesDuFil !== 'function') {
      return res.status(400).json({ error: 'Le gestionnaire de canaux de ce bien n\'a pas de fils de messages' })
    }
    // ⚠ UNE ECHEANCE, PAS UN ESPOIR (review 1, C1). Les appels au partenaire
    // rejouent les 429 et les 5xx avec des attentes croissantes : sans borne,
    // une serie de refus finit en FUNCTION_INVOCATION_TIMEOUT, corps vide —
    // ce que l'en-tete de ce fichier interdit. Depassee, la mesure s'arrete et
    // le DIT (`interrompu`).
    // ⚠ ELLE SE CONSULTE ENTRE DEUX PAGES, ELLE NE COUPE PAS UN APPEL PARTI
    // (review 2, D1) : un seul appel qui rejoue quatre 429 dure ~15 s. C'est
    // pourquoi cette fonction a 60 s dans vercel.json — le filet, l'echeance
    // n'etant que la regle ordinaire. `channelCall`, partage, n'est pas touche.
    const echeance = Date.now() + 10000

    // 1. Les lignes du coeur SANS reservation de ce bien. ⚠ PAR CURSEUR :
    // PostgREST rend 1000 lignes sans erreur, et une mesure tronquee en
    // silence est pire qu'une mesure absente.
    const lignes = []
    let lignesCompletes = false
    let curseur = null
    for (let page = 0; page < 20; page++) {
      let q = supabase.from('messages')
        .select('id, provider_msg_id, direction, sent_at, body')
        .eq('user_id', bien.user_id)
        .eq('property_id', bien.provider_property_id)
        .is('booking_id', null)
        .order('id', { ascending: true })
        .limit(1000)
      if (curseur) q = q.gt('id', curseur)
      const { data, error } = await q
      if (error) return res.status(503).json({ ok: false, error: 'Lecture du cœur impossible', detail: error.message })
      const rangs = data || []
      lignes.push(...rangs)
      if (rangs.length < 1000) { lignesCompletes = true; break }
      curseur = rangs[rangs.length - 1].id
    }

    // 2. Les copies import AVEC reservation autour des copies webhook
    // (review 1, J1) : la jumelle d'un message de demande peut avoir ete
    // importee apres que le voyageur a reserve.
    // ⚠ UNE PLAGE, PAS UNE LISTE D'INSTANTS (review 2, D2) : `.in('sent_at', …)`
    // compare a la MICROSECONDE en SQL, alors que la jumelle se reconnait a la
    // milliseconde (regle de recordMessage, qui ne filtre pas l'instant en SQL
    // pour la meme raison). On lit la plage des instants webhook, par curseur,
    // et c'est `mesurer` qui compare des instants.
    const instantsWebhook = lignes.filter(l => !l.provider_msg_id).map(l => Date.parse(l.sent_at)).filter(Number.isFinite)
    const importAvecResa = []
    let jumellesCompletes = true
    if (instantsWebhook.length) {
      const de = new Date(Math.min(...instantsWebhook)).toISOString()
      const a = new Date(Math.max(...instantsWebhook) + 1).toISOString()
      jumellesCompletes = false
      let apres = null
      for (let page = 0; page < 20; page++) {
        let q = supabase.from('messages')
          .select('id, provider_msg_id, direction, sent_at, body')
          .eq('user_id', bien.user_id)
          .eq('property_id', bien.provider_property_id)
          .not('booking_id', 'is', null)
          .not('provider_msg_id', 'is', null)
          .gte('sent_at', de)
          .lt('sent_at', a)
          .order('id', { ascending: true })
          .limit(1000)
        if (apres) q = q.gt('id', apres)
        const { data, error } = await q
        if (error) return res.status(503).json({ ok: false, error: 'Lecture du cœur impossible', detail: error.message })
        const rangs = data || []
        importAvecResa.push(...rangs)
        if (rangs.length < 1000) { jumellesCompletes = true; break }
        apres = rangs[rangs.length - 1].id
      }
    }

    // 3. Les fils du bien chez le partenaire.
    const liste = await provider.listerFils({ propertyId: bien.provider_property_id, echeance })
    if (!liste.ok) return res.status(502).json({ ok: false, error: 'Fils illisibles chez le gestionnaire de canaux', motif: liste.erreur })

    // 4. Les identifiants de messages des fils utiles, cinq appels a la fois.
    // Le plus ancien instant se calcule en INSTANTS, pas en chaines.
    let plusAncien = null
    for (const l of lignes) {
      const t = Date.parse(l.sent_at)
      if (Number.isFinite(t) && (plusAncien == null || t < plusAncien)) plusAncien = t
    }
    const choix = filsADetailler(liste.fils, { depuis: plusAncien == null ? null : new Date(plusAncien).toISOString(), max: 60 })
    const details = new Map()
    const file = choix.choisis.slice()
    let interrompu = Boolean(liste.interrompu)
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (file.length) {
        if (Date.now() > echeance) { interrompu = true; return }
        const f = file.shift()
        const d = await provider.idsDesMessagesDuFil(f.id, { echeance })
        if (d.interrompu) interrompu = true
        details.set(f.id, d)
      }
    }))

    return res.status(200).json({
      ok: true,
      bien: bien.provider_property_id,
      nom: bien.name || null,
      liste_fils_complete: liste.complet,
      // Un nombre non nul dit que le filtre par bien du partenaire ne tient plus.
      fils_d_autres_biens_ecartes: liste.autres_biens || 0,
      // Un nombre non nul dit que le partenaire ne declare plus le bien de ses
      // fils : ecartes par defaut (review 2, S1), donc une mesure a revoir.
      fils_sans_bien_ecartes: liste.sans_bien || 0,
      lignes_lues_completes: lignesCompletes,
      jumelles_lues_completes: jumellesCompletes,
      // `tentes` compte les fils dont on a demande le detail, `lus_en_entier`
      // ceux dont on a tout lu (review 2, D3) : un echec ou une coupure ne
      // compte que dans le premier.
      detail: {
        candidats: choix.candidats,
        tentes: details.size,
        lus_en_entier: [...details.values()].filter(d => d && d.ok && d.complet).length,
        tronque: choix.tronque,
        interrompu,
      },
      ...mesurer({ fils: liste.fils, details, lignes, importAvecResa }),
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
