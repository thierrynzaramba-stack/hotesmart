// lib/cron-beds24-reviews.js
// Poll des avis Booking.com des biens Beds24 -> ota_reviews (coeur de donnees).
//
// ⚠ BOOKING.COM SEULEMENT, ET C'EST UNE LIMITE DE L'API, PAS UN CHOIX.
// La doc officielle Beds24 expose `GET /channels/booking/reviews` (« Get reviews
// from Booking.com ») mais AUCUN equivalent Airbnb : cote Airbnb, seuls `users`,
// `listings` et un POST d'actions existent. Les avis Airbnb des biens Beds24
// n'entreront donc dans le coeur qu'a la migration Channex de ces biens.
// Source : documentation officielle Beds24, verifiee le 3 septembre 2026.
//
// L'endpoint avait ete declare inexistant a l'etape 0 du chantier : la sonde
// testait `/review` au SINGULIER. Le piege est reel et documente au KB — sous
// `/channels/`, un chemin inexistant repond `200 null`, pas 404. Le vrai chemin,
// lui, repond `400 Invalid data` tant qu'il manque un parametre.

const { supabase } = require('./cron-shared')
const { upsertAvis, chargerIndexCompte } = require('./cron-channel-reviews')

const BASE       = 'https://beds24.com/api/v2'
const MARQUEUR   = 'beds24_reviews_poll'
const PERIODE_MS = 24 * 60 * 60 * 1000
const BUDGET_MS  = 20000
// ⚠ `from` est OBLIGATOIRE : sans lui, l'endpoint repond 400 quels que soient
// les autres parametres. En regime courant on regarde 400 jours en arriere ; au
// premier passage, tout l'historique.
const FENETRE_JOURS = 400
const DEPUIS_ORIGINE = '2023-01-01'

async function beds24Call (chemin, token) {
  // ⚠ Le reseau LEVE. Sans ce try, une coupure TCP (ECONNRESET, DNS, timeout)
  // remontait hors du poll : le marqueur etant deja pose, aucune reprise avant
  // 24 h, et tous les comptes SUIVANTS n'etaient pas poll du tout ce jour-la.
  // Un 500 ou un success:false etait gere, une coupure non.
  try {
    const res = await fetch(BASE + chemin, {
      headers: { accept: 'application/json', token }
    })
    const texte = await res.text()
    let json
    try { json = JSON.parse(texte) } catch { json = null }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    console.error('[beds24-reviews] appel reseau echec:', e.message)
    return { ok: false, status: 0, json: null, reseau: e.message }
  }
}

// ─── Normalisation (pures, testables sans reseau) ───────────────────────────

// ⚠ `content` est un OBJET, pas une chaine — {headline, positive, negative,
// language_code} — et vaut null dans 29 cas sur 93. Ecrit tel quel dans une
// colonne text, il aurait donne « [object Object] » : exactement le piege du
// `reply` de Channex, qui avait produit 68 reponses fantomes.
function extraireContenu (content) {
  if (!content || typeof content !== 'object') {
    return { texte: typeof content === 'string' ? content.trim() || null : null, langue: null }
  }
  const morceaux = [content.headline, content.positive, content.negative]
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
  return {
    texte: morceaux.length ? morceaux.join('\n\n') : null,
    // ⚠ `langue` n'est PAS ecrite en colonne : `raw` porte l'avis integral, donc
    // `content.language_code`. Elle est renvoyee ici pour que l'appelant puisse
    // la lire sans redecouper l'objet — et parce que le prompt de classification
    // porte une consigne explicite de ne pas traduire l'extrait.
    langue: typeof content.language_code === 'string' ? content.language_code : null
  }
}

// `scoring` est un objet plat ; on le rend au format commun [{category, score}]
// pour que la fiche et le pricing lisent la meme forme quel que soit le provider.
// ⚠ `Number.isFinite(Number(v))` et non `typeof v === 'number'`. Si le provider
// rendait un jour "9.5" en chaine, un test de type strict aurait mis la note a
// null : le seuil de proprete ne se serait JAMAIS applique, sans erreur ni log.
// C'est le mode de defaillance exact que ce chantier vient de payer avec
// `provider` absent d'un select.
function nombreOuNull (v) {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normaliserScores (scoring) {
  if (!scoring || typeof scoring !== 'object') return null
  const out = []
  for (const [cle, val] of Object.entries(scoring)) {
    if (cle === 'review_score') continue
    const n = nombreOuNull(val)
    if (n === null) continue
    out.push({ category: cle, score: n })
  }
  return out.length ? out : null
}

// La reponse de l'hote. Prudence heritee de Channex : le champ peut etre un
// objet, et un objet vide n'est pas une reponse.
function extraireReponse (reply) {
  if (!reply) return null
  if (typeof reply === 'string') return reply.trim() || null
  if (typeof reply === 'object') {
    for (const cle of ['reply', 'message', 'text', 'content', 'body']) {
      const v = reply[cle]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

// Beds24 rend « 2026-06-19 12:34:53 » : ni ISO, ni fuseau. On le traite comme
// UTC plutot que de laisser le moteur deviner selon la machine.
function versIso (t) {
  if (!t) return null
  if (typeof t === 'number') { const d = new Date(t); return isNaN(d.getTime()) ? null : d.toISOString() }
  if (typeof t !== 'string') return null
  const brut = t.trim()
  if (!brut) return null
  // Forme observee : « 2026-06-19 12:34:53 », ni ISO ni fuseau. On la lit comme
  // UTC explicitement plutot que de laisser le moteur deviner selon la machine
  // qui execute le cron.
  const d1 = new Date(brut.replace(' ', 'T') + 'Z')
  if (!isNaN(d1.getTime())) return d1.toISOString()
  // Repli : une valeur deja ISO, ou portant un decalage, serait sinon rendue
  // null — et un received_at null fait couler l'avis en bas de toutes les listes.
  const d2 = new Date(brut)
  return isNaN(d2.getTime()) ? null : d2.toISOString()
}

function versLigne (avis, bien) {
  const contenu = extraireContenu(avis.content)
  const scoring = avis.scoring || {}
  return {
    user_id:            bien.user_id,
    property_id:        bien.id,
    property_id_ref:    bien.provider_property_id,
    provider:           'beds24',
    ota:                'booking',
    external_review_id: String(avis.review_id),
    ota_reservation_id: avis.reservation_id != null ? String(avis.reservation_id) : null,
    guest_name:         avis.reviewer?.name || null,
    content:            contenu.texte,
    content_public:     contenu.texte,
    // Booking.com n'a pas de retour prive : tout ce qu'ecrit le voyageur est
    // public. `content_private` reste donc null, comme cote Channex.
    reply:              extraireReponse(avis.reply),
    is_replied:         !!extraireReponse(avis.reply),
    // ⚠ BRUT. Les echelles Beds24 sont coherentes (verifie sur 93 avis), mais on
    // ne convertit pas pour autant : le coeur stocke ce que le provider dit.
    overall_score:      nombreOuNull(scoring.review_score),
    score_clean:        nombreOuNull(scoring.clean),
    scores:             normaliserScores(scoring),
    received_at:        versIso(avis.created_timestamp),
    provider_updated_at: versIso(avis.last_change_timestamp),
    // `raw` porte l'avis integral, donc `content.language_code` : la langue est
    // conservee sans colonne dediee, comme la gravite des messages.
    raw:                avis
  }
}

// ─── Poll ───────────────────────────────────────────────────────────────────

async function pollBeds24Reviews (results, deps = {}) {
  const sb = deps.supabase || supabase
  const appel = deps.beds24Call || beds24Call
  const maintenant = deps.now || (() => Date.now())

  // ⚠ UN MARQUEUR PAR COMPTE, pas un marqueur global.
  //
  // Avec un marqueur unique, deux defauts se combinaient. Le budget coupe apres
  // quelques comptes ; rien ne memorisait ou l'on s'etait arrete et la liste
  // n'etait pas ordonnee, donc le passage suivant rebrulait le budget sur les
  // memes comptes de tete — les derniers pouvaient n'etre JAMAIS poll. Pire :
  // le marqueur global etant pose, `premier` passait a false pour tout le monde,
  // et ces comptes-la auraient un jour ete lus avec une fenetre de 400 jours au
  // lieu de l'historique complet. Leurs avis plus anciens n'entraient jamais
  // dans le coeur, en silence et definitivement — sur les donnees reelles, la
  // moitie des six annees couvertes.
  //
  // Par compte, chacun garde sa cadence ET son « premier passage ».
  const marqueurDe = (userId) => `${MARQUEUR}:${userId}`

  const bilan = { comptes: 0, biens: 0, lus: 0, ecrits: 0, resolus: 0, erreurs: 0, sautes: 0 }
  const echeance = maintenant() + BUDGET_MS

  // ⚠ UN JETON PAR COMPTE (REVIEW.md regle 1). Contrairement a Channex, Beds24
  // a bien une cle par hote : on itere sur les comptes et chaque appel part avec
  // le jeton de SON compte. Les biens sont lus sur le meme user_id.
  const { data: cles, error: errCles } = await sb.from('api_keys')
    .select('user_id, api_key').not('api_key', 'is', null)
  if (errCles) {
    results?.errors?.push({ context: 'beds24_reviews', error: errCles.message })
    return { ...bilan, interrompu: 'db' }
  }

  for (const cle of (cles || [])) {
    if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }

    // Cadence propre a ce compte.
    const idMarq = marqueurDe(cle.user_id)
    const { data: marker } = await sb
      .from('cron_logs').select('last_run').eq('id', idMarq).maybeSingle()
    if (!deps.forcer && marker?.last_run &&
        (maintenant() - new Date(marker.last_run).getTime()) < PERIODE_MS) {
      bilan.sautes++
      continue
    }
    // Premier passage DE CE COMPTE : tout l'historique. Ensuite : fenetre
    // glissante.
    const depuis = !marker?.last_run
      ? DEPUIS_ORIGINE
      : new Date(maintenant() - FENETRE_JOURS * 24 * 3600 * 1000).toISOString().slice(0, 10)

    // Marqueur pose AVANT le travail, comme les autres passages.
    const { error: errMarqueur } = await sb.from('cron_logs').upsert({
      id: idMarq, last_run: new Date(maintenant()).toISOString(),
      total_messages: 0, total_replies: 0, errors: []
    }, { onConflict: 'id' })
    if (errMarqueur) {
      console.error('[beds24-reviews] marqueur NON ecrit:', errMarqueur.message)
      results?.errors?.push({ context: 'beds24_reviews', error: 'marqueur: ' + errMarqueur.message })
      bilan.erreurs++
      continue
    }
    bilan.comptes++
    bilan.depuis = depuis

    // ⚠ Index des codes OTA, RECHARGE A CHAQUE COMPTE. Hisser cette variable
    // hors de la boucle ferait rattacher l'avis d'un compte au sejour d'un
    // autre — meme numero de reservation Booking chez deux hotes, dates du
    // premier ecrites chez le second (REVIEW.md regle 1).
    let index = null

    const { data: biens, error: errBiens } = await sb.from('properties')
      .select('id, user_id, provider_property_id')
      .eq('user_id', cle.user_id).eq('provider', 'beds24')
      .not('provider_property_id', 'is', null)
    if (errBiens) {
      console.error('[beds24-reviews] lecture des biens echec:', errBiens.message)
      results?.errors?.push({ context: 'beds24_reviews', error: 'biens: ' + errBiens.message })
      bilan.erreurs++
      continue
    }

    for (const bien of (biens || [])) {
      if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }
      bilan.biens++

      // ⚠ Le try entoure L'APPEL, pas seulement l'implementation par defaut :
      // `deps.beds24Call` peut lever, et une exception ici remonterait hors du
      // poll — marqueur deja pose, donc aucune reprise avant 24 h, et les
      // comptes SUIVANTS pas traites du tout.
      let r
      try {
        r = await appel(
          `/channels/booking/reviews?propertyId=${encodeURIComponent(bien.provider_property_id)}&from=${depuis}`,
          cle.api_key)
      } catch (e) {
        console.error('[beds24-reviews] appel echec', bien.provider_property_id, e.message)
        r = { ok: false, status: 0, json: null }
      }
      if (!r.ok || !r.json?.success) {
        console.error('[beds24-reviews] lecture echec', bien.provider_property_id, r.status)
        bilan.erreurs++
        results?.errors?.push({ context: 'beds24_reviews',
          error: `bien ${bien.provider_property_id} : HTTP ${r.status}` })
        continue
      }
      const liste = Array.isArray(r.json.data) ? r.json.data : []
      bilan.lus += liste.length
      if (!liste.length) continue

      // Un avis sans identifiant ne peut pas etre rendu idempotent : l'unicite
      // porte sur external_review_id.
      const lignes = liste.filter(a => a && a.review_id).map(a => versLigne(a, bien))
      if (lignes.length !== liste.length) bilan.erreurs += liste.length - lignes.length
      if (!lignes.length) continue

      // ⚠ RESOLUTION DU SEJOUR ICI, a l'ingestion.
      // Une premiere version s'en remettait a « un rattrapage commun » — qui
      // N'EXISTE PAS : la passe de rattrapage separee a ete retiree au lot 2,
      // parce que le poll relit tout et retente chaque avis a chaque passage.
      // Resultat mesure : 0 avis rattache sur 93, alors que 17 l'etaient.
      // Supposer un mecanisme au lieu de le verifier, exactement ce que le
      // chantier a deja paye deux fois.
      if (!index) index = await chargerIndexCompte(sb, cle.user_id)
      for (const l of lignes) {
        const resa = (index && l.ota_reservation_id) ? index.get(String(l.ota_reservation_id)) : null
        if (resa) {
          l.booking_uid = resa.booking_uid
          l.stay_start  = resa.stay_start
          l.stay_end    = resa.stay_end
          bilan.resolus = (bilan.resolus || 0) + 1
        }
      }

      // upsertAvis separe les lignes AVEC ancrage de celles SANS : indispensable
      // ici, le lot etant desormais mixte (17 resolues sur 93).
      const res = await upsertAvis(sb, lignes)
      if (res.error) {
        bilan.erreurs += lignes.length
        console.error('[beds24-reviews] upsert echec:', res.error.message)
      } else {
        bilan.ecrits += res.ecrits
      }
    }
  }

  if (bilan.erreurs > 0) {
    results?.errors?.push({ context: 'beds24_reviews', error: bilan.erreurs + ' erreur(s) au poll' })
  }
  // Une troncature muette ressemble a un passage reussi : les comptes non
  // traites le seront au cycle suivant, chacun gardant sa propre cadence, mais
  // l'ecart doit remonter.
  if (bilan.interrompu === 'budget') {
    console.error('[beds24-reviews] passage TRONQUE sur budget apres', bilan.comptes, 'compte(s)')
    results?.errors?.push({ context: 'beds24_reviews',
      error: 'passage tronque sur budget apres ' + bilan.comptes + ' compte(s)' })
  }
  if (bilan.lus > 0) console.log('[beds24-reviews] bilan', JSON.stringify(bilan))
  if (results) results.totalBeds24Reviews = (results.totalBeds24Reviews || 0) + bilan.ecrits
  return bilan
}

module.exports = {
  pollBeds24Reviews,
  // exportes pour les tests
  extraireContenu,
  normaliserScores,
  extraireReponse,
  versIso,
  versLigne
}
