// lib/cron-messages-classify.js
// Detection des signalements de proprete dans les messages ENTRANTS des
// voyageurs -> ota_reviews (statut 'detecte', en attente de validation).
//
// POURQUOI CE MODULE EXISTE. Un voyageur a ecrit : « je ne voulais pas le
// marquer sur Airbnb mais vous devriez controler un peu le travail de femme de
// menage ». Cette phrase n'existe NULLE PART ailleurs — ni dans les tags OTA,
// ni dans la note, ni dans l'avis public. Sur 70 jours de messagerie reelle,
// six signalements de ce genre, contre UNE seule remarque sur 70 avis couvrant
// deux ans. La messagerie est, et de loin, la source la plus riche sur la
// proprete.
//
// PAS D'ETAGE 1, contrairement aux avis. Un message n'a ni tag ni note : aucune
// regle deterministe n'est possible. Et un pre-filtre lexical serait DANGEREUX —
// mesure sur les donnees reelles, il remonte 25 messages dont 19 sont des faux
// positifs (« fournissez-vous draps et serviettes ? », « nous avons vide les
// poubelles ») et raterait les formulations indirectes. A ~5,5 messages entrants
// par jour, tout classer coute quelques centimes par mois.

const { supabase, anthropic } = require('./cron-shared')
const { extraitVerifie } = require('./extrait-verifie')

const MARQUEUR   = 'messages_classify'
const CURSEUR    = 'messages_classify_cursor'
const PERIODE_MS = 60 * 60 * 1000    // horaire : un signalement pendant le sejour
                                     // a de la valeur PENDANT le sejour
const LOT_MAX    = 20
const BUDGET_MS  = 15000
const MODELE     = 'claude-haiku-4-5-20251001'
const MAX_TEXTE  = 4000
// ⚠ Au-dela de ce nombre d'echecs CONSECUTIFS sur le meme message, on le saute.
// Sans cette borne, un message que le modele ne sait pas traiter — une citation
// trop longue tronquee par max_tokens, donc un JSON invalide — gelait la file
// ENTIERE : le passage rejouait le meme lot toutes les heures, indefiniment, et
// aucun message posterieur n'etait jamais analyse. C'est ce que REVIEW.md
// regle 3 interdit : « une erreur permanente rejouee a chaque cycle coute
// infiniment plus cher qu'une notification manquee ».
const MAX_ECHECS = 3

// ─── Le prompt ──────────────────────────────────────────────────────────────
// Les quatre exclusions ne sont pas des precautions theoriques : chacune vient
// d'un faux positif releve dans les messages reels.
function construirePrompt (texte) {
  return `Tu analyses UN message envoye par un voyageur a son hote, pendant ou juste
apres son sejour.

Question unique : le voyageur SIGNALE-T-IL un probleme de proprete ou de
menage dans le logement ?

Reponds en JSON strict, sans texte autour :
{"signale":true|false,"extrait":"<citation exacte ou null>","gravite":"gene"|"probleme"}

- true  : il signale un manque de proprete, meme avec menagement, meme noye
          dans un message chaleureux, meme en disant qu'il ne le mettra pas
          dans son avis.
- false : tout le reste. C'est le cas le PLUS FREQUENT.

Ne reponds JAMAIS true pour :
- une QUESTION sur l'equipement (« fournissez-vous draps et serviettes ? ») ;
- un voyageur decrivant CE QU'IL A FAIT en partant (« j'ai vide les poubelles,
  mis les draps dans la machine ») — c'est de la politesse, pas un reproche ;
- un objet casse, une panne, un probleme d'acces ou de bruit : ce n'est pas
  de la proprete ;
- un compliment (« logement impeccable »).

"extrait" : citation MOT POUR MOT du passage concerne, jamais reformulee.
"gravite" : "probleme" si le sejour en a ete affecte, "gene" sinon.

Message : """${texte}"""`
}

// Valide la reponse du modele. Rien n'entre en base sans passer par ici.
function lireReponse (brut, texte) {
  let json
  try { json = JSON.parse(String(brut || '').replace(/```json|```/g, '').trim()) }
  catch { return null }
  if (typeof json?.signale !== 'boolean') return null
  if (!json.signale) return { signale: false }

  // L'extrait doit etre une citation REELLE : un modele qui reformule produirait
  // une phrase que le voyageur n'a jamais ecrite, montree telle quelle a l'hote
  // puis, a terme, a la prestataire. `extraitVerifie` rend la portion du TEXTE
  // D'ORIGINE — jamais la chaine du modele — et tolere les seuls ecarts
  // d'espaces : sur le rattrapage reel, quatre extraits legitimes sur cinq
  // etaient rejetes pour un simple retour ligne.
  const extrait = extraitVerifie(texte, json.extrait)
  const gravite = ['gene', 'probleme'].includes(json.gravite) ? json.gravite : null
  return { signale: true, extrait, gravite }
}

async function classerMessage (texte, deps = {}) {
  const client = deps.anthropic || anthropic
  const r = await client.messages.create({
    model: MODELE,
    max_tokens: 250,
    messages: [{ role: 'user', content: construirePrompt(texte.slice(0, MAX_TEXTE)) }]
  })
  return lireReponse(r?.content?.[0]?.text, texte)
}

// ─── Construction de la ligne ───────────────────────────────────────────────

// ⚠ L'idempotence repose sur messages.id, PAS sur provider_msg_id : celui-ci
// n'est peuple que sur 263 des 359 messages entrants reels. L'utiliser aurait
// produit des doublons ou des trous. `messages.id` est la cle primaire, toujours
// presente. L'unicite (user_id, provider, external_review_id) fait le reste :
// jamais deux entrees pour un meme message, sans contrainte nouvelle.
function refDuMessage (msgId) { return 'msg:' + String(msgId) }

function versLigne (msg, bien, resa, verdict) {
  return {
    user_id:            msg.user_id,
    property_id:        bien.id,
    property_id_ref:    bien.provider_property_id,
    provider:           'manuel',
    source:             'message',
    source_message_id:  msg.id,
    ota:                'direct',
    external_review_id: refDuMessage(msg.id),
    // ⚠ Nait en 'detecte' : c'est une PROPOSITION a l'hote, pas un fait etabli.
    // Seuls les confirmes comptent dans les indicateurs et, a terme, sur la
    // fiche prestataire — aucun reproche ne parvient a la prestataire sans que
    // l'hote l'ait valide.
    statut:             'detecte',
    content:            msg.body || '',
    content_public:     msg.body || '',
    ai_clean_verdict:   'remarque',
    ai_clean_excerpt:   verdict.extrait || null,
    ai_analyzed_at:     new Date().toISOString(),
    received_at:        msg.sent_at || msg.created_at || new Date().toISOString(),
    // La gravite vit dans `raw` et non dans une colonne : rien ne l'exploite
    // encore. Si le tri gene/probleme devient un besoin de la fiche prestataire,
    // la migration sera triviale et l'historique sera deja la.
    raw:                { source: 'message', message_id: msg.id, gravite: verdict.gravite || null },
    ...(resa ? { booking_uid: resa.booking_uid, stay_start: resa.stay_start, stay_end: resa.stay_end } : {})
  }
}

// ─── Passage ────────────────────────────────────────────────────────────────

async function classerMessages (results, deps = {}) {
  const sb = deps.supabase || supabase
  const maintenant = deps.now || (() => Date.now())

  if (!deps.forcer) {
    const { data: marker } = await sb
      .from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
    if (marker?.last_run && (maintenant() - new Date(marker.last_run).getTime()) < PERIODE_MS) {
      return { skipped: 'cadence' }
    }
  }

  // Marqueur pose AVANT le travail, meme raison que les autres passages : une
  // invocation tuee par le plafond de 60 s ne doit pas relancer cette etape a
  // chaque tick de 5 min.
  const { error: errMarqueur } = await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(maintenant()).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (errMarqueur) {
    console.error('[messages-classify] marqueur NON ecrit:', errMarqueur.message)
    results?.errors?.push({ context: 'messages_classify', error: 'marqueur: ' + errMarqueur.message })
    return { skipped: 'marqueur_illisible' }
  }

  const bilan = { lus: 0, detectes: 0, ecrits: 0, sans_bien: 0, erreurs: 0 }
  const echeance = maintenant() + BUDGET_MS

  // ⚠ CURSEUR SUR created_at, PAS sur sent_at. `created_at` est la date
  // d'INSERTION en base : elle est monotone par construction, donc un message
  // ancien importe tardivement (rattrapage de sync, reconnexion d'un canal) sera
  // vu. Un curseur sur `sent_at` l'aurait saute definitivement.
  // `total_messages` de la ligne curseur porte le nombre d'echecs CONSECUTIFS
  // sur le message qui suit le curseur. Detournement assume d'une colonne
  // existante plutot qu'une table de plus pour un entier.
  const { data: cur } = await sb.from('cron_logs')
    .select('last_run, total_messages').eq('id', CURSEUR).maybeSingle()
  const depuis = cur?.last_run || '1970-01-01T00:00:00Z'
  const echecsAvant = Number(cur?.total_messages) || 0

  let q = sb.from('messages')
    .select('id, user_id, body, sent_at, created_at, booking_id, property_id')
    // Les messages SORTANTS ne sont jamais analyses : une reponse de l'hote
    // n'est pas un signalement, et l'analyser produirait des detections sur nos
    // propres mots.
    .eq('direction', 'inbound')
    .gt('created_at', depuis)
    .order('created_at', { ascending: true })
    .limit(LOT_MAX)

  const { data: file, error } = await q
  if (error) {
    console.error('[messages-classify] lecture echec:', error.message)
    results?.errors?.push({ context: 'messages_classify', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }
  if (!file || !file.length) return bilan

  const cacheBien = new Map()
  const cacheResa = new Map()
  // Dernier message reellement traite. Un echec ne l'efface PAS : jeter le
  // travail deja fait du lot obligeait a le refaire, et c'est ce qui reouvrait
  // la porte au retraitement.
  let dernierTraite = null
  let echecSur = null

  for (const msg of file) {
    if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }
    const texte = String(msg.body || '').trim()
    // Un message vide n'est pas un echec : il n'y a rien a analyser, le curseur
    // avance. Sinon la file ne progresserait jamais.
    if (!texte) { bilan.lus++; dernierTraite = msg.created_at; continue }
    bilan.lus++

    let verdict = null
    try { verdict = await classerMessage(texte, deps) }
    catch (e) { console.error('[messages-classify] appel IA echec:', e.message) }

    if (!verdict) {
      // Echec (exception ou reponse illisible) : on ne depasse PAS ce message,
      // sinon il serait saute definitivement — quatre l'ont ete au rattrapage.
      // Mais on ne gele pas non plus : le compteur d'echecs consecutifs, plus
      // bas, finit par le sauter en le signalant.
      bilan.erreurs++
      echecSur = msg
      break
    }

    // Traite avec succes : le curseur peut le depasser.
    dernierTraite = msg.created_at
    if (!verdict.signale) continue

    bilan.detectes++

    // Le bien, resolu en base sur le compte du message.
    const cle = msg.user_id + '|' + String(msg.property_id)
    if (!cacheBien.has(cle)) {
      const { data, error: errBien } = await sb.from('properties')
        .select('id, provider_property_id')
        .eq('user_id', msg.user_id).eq('provider_property_id', String(msg.property_id)).limit(2)
      // ⚠ UNE PANNE N'EST PAS UNE ABSENCE, et l'erreur n'est PAS mise en cache.
      // Ignorer `error` faisait passer un 503 transitoire pour « bien inconnu » :
      // le curseur avancait et la detection etait perdue definitivement, sans
      // autre trace qu'une ligne de log. Le cache aggravait — un incident d'une
      // seconde coutait tous les messages du meme bien dans le lot.
      if (errBien) {
        console.error('[messages-classify] lecture du bien echec:', errBien.message)
        bilan.erreurs++
        echecSur = msg
        dernierTraite = null
        break
      }
      cacheBien.set(cle, (data && data.length === 1) ? data[0] : null)
    }
    const bien = cacheBien.get(cle)
    // Bien reellement absent, ou deux biens du meme compte sur la meme
    // reference : on n'ecrit pas, et le curseur avance — il n'y a rien a
    // retenter, ce message ne se rattachera jamais.
    if (!bien) { bilan.sans_bien++; continue }

    // Le sejour, pour l'ancrage temporel.
    let resa = null
    if (msg.booking_id) {
      const cleR = msg.user_id + '|' + String(msg.booking_id)
      if (!cacheResa.has(cleR)) {
        const { data, error: errResa } = await sb.from('bookings_snapshot')
          .select('booking_id, snapshot')
          .eq('user_id', msg.user_id).eq('booking_id', String(msg.booking_id)).maybeSingle()
        // Meme raison : une panne ici graverait une detection SANS ancrage de
        // sejour, et le message ne serait plus jamais relu — alors que le schema
        // prevoit explicitement une resolution tardive.
        if (errResa) {
          console.error('[messages-classify] lecture du sejour echec:', errResa.message)
          bilan.erreurs++
          echecSur = msg
          dernierTraite = null
          break
        }
        cacheResa.set(cleR, data ? {
          booking_uid: String(data.booking_id),
          stay_start: data.snapshot?.arrival || null,
          stay_end: data.snapshot?.departure || null
        } : null)
      }
      resa = cacheResa.get(cleR)
    }

    // ⚠ ignoreDuplicates : ON CONFLICT DO NOTHING, PAS DO UPDATE.
    //
    // `versLigne` pose toujours `statut: 'detecte'`. Avec un upsert classique,
    // retraiter un message ECRASAIT la decision de l'hote : une detection
    // confirmee repassait en attente, une detection ignoree reapparaissait — et
    // l'hote n'avait aucun moyen de s'en debarrasser. C'est la garantie centrale
    // de ce lot (« aucun reproche ne parvient a la prestataire sans validation »)
    // qui sautait, silencieusement.
    //
    // Le retraitement n'est pas theorique : un echec en milieu de lot fait
    // rejouer les messages deja traites du meme lot au passage suivant.
    //
    // DO NOTHING est le bon comportement : la premiere detection cree la ligne,
    // les suivantes n'y touchent pas. Ce que le modele dirait de different a la
    // seconde lecture n'a aucune valeur face a une decision humaine deja prise.
    const { error: e } = await sb.from('ota_reviews')
      .upsert(versLigne(msg, bien, resa, verdict),
              { onConflict: 'user_id,provider,external_review_id', ignoreDuplicates: true })
    if (e) {
      // Une ecriture ratee est un echec TRANSITOIRE : on ne depasse pas ce
      // message, sinon la detection serait perdue definitivement.
      console.error('[messages-classify] upsert echec:', e.message)
      bilan.erreurs++
      echecSur = msg
      break
    }
    bilan.ecrits++
  }

  // ─── Avancee du curseur ───────────────────────────────────────────────────
  // Trois cas, et c'est le coeur de la robustesse de ce passage :
  //   - tout s'est bien passe : le curseur va au dernier message traite ;
  //   - echec sur un message : le curseur va au dernier SUCCES (le travail deja
  //     fait n'est pas jete), et le compteur d'echecs augmente ;
  //   - le meme message a echoue MAX_ECHECS fois : on le saute en le signalant
  //     fort, plutot que de geler la file pour toujours.
  let echecs = echecsAvant
  let curseurCible = dernierTraite

  if (echecSur) {
    echecs = echecsAvant + 1
    if (echecs >= MAX_ECHECS) {
      console.error('[messages-classify] message ignore apres', echecs,
                    'echecs consecutifs, id:', echecSur.id)
      results?.errors?.push({ context: 'messages_classify',
        error: `message ${echecSur.id} ignore apres ${echecs} echecs consecutifs` })
      curseurCible = echecSur.created_at   // on le depasse
      echecs = 0
      bilan.ignores = (bilan.ignores || 0) + 1
    }
  } else {
    echecs = 0
  }

  if (curseurCible) {
    const { error: errCur } = await sb.from('cron_logs').upsert({
      id: CURSEUR, last_run: curseurCible,
      total_messages: echecs, total_replies: 0, errors: []
    }, { onConflict: 'id' })
    // ⚠ Le retour EST controle. C'etait la seule requete du module dont le
    // resultat etait jete : un echec silencieux faisait rejouer tout le lot au
    // passage suivant, sans aucune trace pour l'expliquer.
    if (errCur) {
      console.error('[messages-classify] curseur NON ecrit:', errCur.message)
      results?.errors?.push({ context: 'messages_classify', error: 'curseur: ' + errCur.message })
    }
  }

  if (bilan.erreurs > 0) {
    results?.errors?.push({ context: 'messages_classify',
                            error: bilan.erreurs + ' message(s) non analyses' })
  }
  // Un compte dont les property_id ne resolvent jamais perdrait 100 % de ses
  // detections en silence : ce compteur doit se voir.
  if (bilan.sans_bien > 0) {
    results?.errors?.push({ context: 'messages_classify',
                            error: bilan.sans_bien + ' message(s) sans bien rattachable' })
  }
  if (bilan.lus > 0) console.log('[messages-classify] bilan', JSON.stringify(bilan))
  if (results) results.totalMessagesClassified = (results.totalMessagesClassified || 0) + bilan.lus
  return bilan
}

module.exports = {
  classerMessages,
  // exportes pour les tests
  construirePrompt,
  lireReponse,
  versLigne,
  refDuMessage
}
