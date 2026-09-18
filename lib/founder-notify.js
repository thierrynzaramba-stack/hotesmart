// ⚠️ DOC : comportement documenté dans docs/kb/alertes.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
// lib/founder-notify.js — Canal d'alerte FONDATEUR (Thierry) + persistance des incidents.
//
// notifyFounder(type, {...}) :
//   1. Persiste TOUJOURS l'incident dans automation_incidents (journal consultable).
//   2. Alerte le fondateur (SMS + email plateforme) SAUF si une alerte du même
//      (type, property_id) a déjà été envoyée dans la dernière heure (anti-spam).
//
// Env : FOUNDER_PHONE, FOUNDER_EMAIL (+ ALERT_BREVO_API_KEY côté platform-notify).
// Sans ces env, les envois sont des no-op traçés — l'incident reste persisté.

const { supabase } = require('./cron-shared')
const { sendPlatformSms, sendPlatformEmail } = require('./platform-notify')

const FOUNDER_PHONE = process.env.FOUNDER_PHONE
const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL

// ⚠ INCIDENTS QUI N'ONT PAS A REVEILLER — decision Thierry, 8 septembre 2026 :
// « pas de SMS car pas d'urgence ».
// Le SMS est reserve a ce qui exige un GESTE. Un remboursement automatique n'en
// exige aucun : l'argent est deja rendu, le voyageur deja prevenu. Le savoir au
// reveil suffit. L'e-mail part quand meme, et l'incident reste en base — un
// remboursement automatique qui se repeterait ne doit pas passer inapercu.
//
// ⚠ Ne pas y mettre un incident qui demande d'agir. `paiement_issue_incertaine`
// n'y sera JAMAIS : de l'argent encaisse sans reservation attend une decision
// humaine, et il l'attend tout de suite.
// ⚠ `ecriture_de_masse_annoncee` N'EST PAS UN INCIDENT, C'EST UN PREAVIS.
// Il existe pour que l'alerte `table_growth` qui suivra arrive AVEC son
// explication — pas pour reveiller qui que ce soit. Le reveiller ferait
// exactement ce que la regle veut eviter : du bruit qu'on apprend a ignorer.
// L'e-mail part quand meme, et la trace reste en base : c'est elle qui sert.
// ⚠ `email_voyageur_echec` N'EST PAS UN INCIDENT NON PLUS, C'EST UN COMPTEUR.
// Une ligne par tentative ratee, pour savoir quand arreter de reessayer. Elle est
// posee avec un seuil inatteignable, donc n'alerte jamais d'elle-meme ; c'est
// l'abandon au plafond (`email_voyageur_abandon`) qui reveille, une fois.
// ⚠ `notif_hote_non_envoyee` NE REVEILLE PAS. La reservation est bien
// enregistree — c'est son annonce qui n'est pas partie. Un SMS par vente et par
// bien, sur un compte mal configure, c'est l'alarme qu'on apprend a ignorer,
// et le jour d'une vraie panne elle s'y noie. L'e-mail part, la trace reste.
// ⚠ `menage_non_assigne` EN PAUSE DE SMS — DECISION DU 17 SEPTEMBRE 2026, ET
// C'EST UNE DETTE, PAS UN ACQUIS.
// Un menage sans personne EXIGE un geste : c'est precisement le genre d'incident
// que le SMS existe pour porter. On le met en pause quand meme, parce qu'il part
// AUJOURD'HUI trop souvent pour rester audible — et une alarme qu'on apprend a
// ignorer ne protege plus rien le jour ou elle dit vrai. C'est la meme mecanique
// que les huit tests rouges permanents du CLAUDE.md.
// ⚠ CE QU'ON ACCEPTE EN ECHANGE, ET QU'IL FAUT SAVOIR : un trou de garde peut
// desormais passer une nuit sans reveiller personne. L'e-mail part toujours, la
// ligne reste en base, et l'ecran de garde le montre — mais plus rien n'arrive
// dans la poche.
// ⚠ CE QUI DOIT LEVER LA PAUSE : ce n'est pas « quand on aura le temps », c'est
// quand l'incident ne partira plus que sur un VRAI trou — c'est-a-dire quand la
// proposition automatique aura reduit les non-assignes a ce que personne n'a
// voulu prendre. Detail et conditions de sortie : docs/kb/menage.md.
const SANS_SMS = new Set(['reservation_remboursee', 'ecriture_de_masse_annoncee',
  'email_voyageur_echec', 'email_confirmation_repli', 'notif_hote_non_envoyee',
  'menage_non_assigne'])

const LABELS = {
  send_failure:    'Échecs d\'envoi répétés',
  seam_failure:    'Échec création code serrure',
  volume:          'Volume de messages anormal',
  webhook_error:   'Erreur webhook Channex répétée',
  circuit_breaker: 'Coupe-circuit auto déclenché',
  event_loop:      'Boucle de production d\'événements ménage',
  table_growth:    'Croissance anormale d\'une table',
  // Canal e-mail des reservations directes (chantier canal-email, etape 3).
  email_voyageur_echec:   'Tentative d\'e-mail voyageur en echec (compteur, pas une alerte)',
  email_voyageur_abandon: 'E-MAIL VOYAGEUR ABANDONNE — le message ne partira pas',
  // La confirmation est PARTIE, mais sous l'enseigne HoteSmart : rien n'est
  // casse, une identite est a regler. Pas de SMS — ca n'a pas a reveiller.
  email_confirmation_repli: 'Confirmation envoyee sous l\'identite HoteSmart',
  // L'hote croit etre prevenu de ses ventes directes : s'il ne l'est pas, il
  // doit l'apprendre autrement que par un client a sa porte.
  notif_hote_non_envoyee: 'NOUVELLE RESERVATION NON ANNONCEE a l\'hote',
  // Pannes de FACTURATION d'un service tiers : l'IA, les SMS/e-mails ou les
  // serrures s'arretent NET, et rien ne le disait a l'ecran.
  api_credit:      'SERVICE TIERS COUPE — credit ou quota epuise',
  menage_non_assigne: 'Ménage sans prestataire assigné',
  overbooking:     'SURRÉSERVATION — deux séjours sur la même nuit',
  stop_sell_perdu: 'STOP-SELL PERDU — des dates fermées sont redevenues vendables',
  // Moteur de reservation directe (etape 3).
  paiement_orphelin:         'PAIEMENT ORPHELIN — encaissé sans tentative correspondante',
  paiement_sans_reservation: 'PAIEMENT SANS RÉSERVATION — argent encaissé, rien de créé',
  paiement_issue_incertaine: 'ARGENT EN SUSPENS — issue de la création inconnue, NE PAS REJOUER',
  reservation_remboursee:    'Réservation impossible — voyageur remboursé automatiquement',
  message_non_envoye:        'MESSAGE VOYAGEUR NON ENVOYÉ — information manquante',
  // La garde des cles migrees est AVEUGLE : plus aucun bien Beds24 n'est
  // synchronise tant que ca dure, et la liste des biens est refusee a l'ecran.
  // Le `detail` porte le message et le code de la base : c'est la seule chose
  // qui dira la cause (timeout, pooler, cache de schema).
  cles_migrees_illisible:    'GARDE AVEUGLE — table des clés migrées illisible, synchro Beds24 suspendue',
  // L'import des messages s'est abstenu plusieurs cycles d'affilée. Ce n'est
  // plus un cycle chargé, c'est un état : les réponses écrites depuis l'app OTA
  // n'entrent plus dans le cœur, donc l'agent IA lit un fil amputé et peut
  // répondre une seconde fois au même voyageur. Ça, ça demande un geste.
  messages_import_suspendu:  'IMPORT DES MESSAGES SUSPENDU — l\'agent IA lit un fil amputé',
  // Préavis d'écriture volumineuse, pour que la sonde de croissance qui suivra
  // soit lisible. Aucune action attendue.
  ecriture_de_masse_annoncee: 'Écriture de masse annoncée (croissance attendue)'
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

// reportIncident : persiste TOUJOURS l'incident, puis alerte le fondateur SEULEMENT si
//   - le nombre d'incidents (type[, bien]) de la dernière heure atteint `threshold`, ET
//   - aucune alerte (alerted=true) du même (type[, bien]) n'a déjà été envoyée cette heure.
// threshold=1 -> alerte immédiate ; threshold=2 -> 2e occurrence (échecs "répétés").
// propertyId null -> anti-spam/seuil par type seul (ex. erreur webhook sans bien résolu).
// `fenetreMs` : duree de l'anti-spam. Defaut UNE HEURE — la bonne maille pour un
// incident d'exploitation qu'on veut voir revenir s'il persiste. Certaines pannes
// n'ont aucun interet a rappeler d'heure en heure : un credit d'API epuise est le
// meme fait toute la journee, et une alerte horaire ferait du bruit la ou une
// seule suffit. D'ou le parametre, plutot qu'une valeur en dur.
// ─── L'ESCALADE : un incident qui dure doit s'espacer ────────────────────────
//
// ⚠ VECU LE 18 SEPTEMBRE 2026. Colomiers avait un menage du 22 sans personne de
// garde — un fait vrai, stable, que personne ne pouvait corriger sur-le-champ.
// L'anti-spam horaire a donc reexpedie la MEME phrase toutes les heures : 235
// e-mails transactionnels sur le compte, au point de noyer un e-mail de test
// qu'on cherchait. C'est litteralement l'alarme qu'on apprend a ignorer, et
// c'est la faute que ce depot combat partout ailleurs.
//
// Une alerte utile dit deux choses : « ca ne va pas » et « ca ne va TOUJOURS
// pas ». La premiere merite l'heure ; la seconde, de plus en plus d'espace.
//
// LA REGLE : 1 h, puis 2, 4, 8, 16, plafonnees a 24 h. Le compteur repart de
// zero quand le fait se TAIT assez longtemps, ou qu'il est acquitte. Un nouveau
// probleme reveille tout de suite, meme s'il succede a un ancien qu'on avait
// fini par espacer.
const PLAFOND_ESCALADE_MS = 24 * 3600 * 1000
const MEMOIRE_ESCALADE_MS = 7 * 24 * 3600 * 1000
// ⚠ LA RUPTURE PAR LE SILENCE, ET ELLE EST INDISPENSABLE.
// La remise a zero « par acquittement » etait du CODE MORT : `acquitted_at`
// n'est pose que sur les incidents `overbooking`, qui n'empruntent meme pas
// `reportIncident`. Rien ne remettait donc le compteur a zero quand un fait
// disparaissait simplement — l'hote corrige, trois jours passent, le meme
// message revient, et la memoire de 7 jours le plafonnait AUSSITOT a 24 h de
// silence apres son premier e-mail. Un episode neuf herité du silence d'un
// ancien : l'inverse de ce que l'escalade cherche.
//
// Deux alertes separees par plus de 48 h ne sont pas le meme episode.
const SILENCE_NOUVEL_EPISODE_MS = 48 * 3600 * 1000

// Signature du FAIT, pas de l'incident : deux lignes qui disent la meme phrase
// sont le meme probleme qui dure. `detail` est jsonb (`{ message }`) quand il
// vient d'une chaine ; on compare donc le message, pas l'enveloppe.
//
// ⚠ ELLE DOIT SURVIVRE A L'ALLER-RETOUR PAR POSTGRES, sinon l'escalade est
// inerte sans le dire. Deux pieges, tous deux trouves en review :
//   - `detail.message || JSON.stringify(detail)` : pour un message VIDE, le
//     cote vivant calculait `''` et la ligne relue `'{"message":""}'`. Jamais
//     egaux, donc jamais d'escalade. On teste la PRESENCE de la cle, pas sa
//     verite.
//   - le repli `JSON.stringify` sur un objet sans `message` compare un objet JS
//     a un objet relu de jsonb, qui ne conserve ni l'ordre des cles ni la mise
//     en forme des nombres. Latent — tous les appelants portent un `message` —
//     mais le premier qui n'en portera pas verrait l'escalade muette. On trie
//     donc les cles, comme `stableStringify` le fait pour les snapshots.
function stable (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

function messageDe (detail) {
  if (detail == null) return ''
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object' && 'message' in detail) return String(detail.message)
  return stable(detail)
}

// Fail-safe : une lecture en echec rend la fenetre de base. On prefere une
// alerte de trop a une alerte manquante — c'est le sens meme d'une alerte.
async function fenetreEscaladee (type, pid, message, base) {
  try {
    const depuis = new Date(Date.now() - MEMOIRE_ESCALADE_MS).toISOString()
    let q = supabase.from('automation_incidents')
      .select('detail, created_at, acquitted_at')
      .eq('type', type).eq('alerted', true)
      .gte('created_at', depuis)
      .order('created_at', { ascending: false })
      .limit(50)
    q = pid ? q.eq('property_id', pid) : q.is('property_id', null)
    const { data, error } = await q
    if (error || !data) return base

    // ⚠ ON COMPTE LES LIGNES QUI DISENT LA MEME CHOSE, ON N'ARRETE PAS A LA
    // PREMIERE QUI DIT AUTRE CHOSE. Rompre sur un message different paraissait
    // juste et ne l'etait pas : `menage_non_assigne` a DEUX producteurs sur le
    // meme bien (`synchroniserMenages` et `expirerPropositions`), avec des
    // phrases differentes, dans la meme passe de cron. Le fait A, escalade a 8 h,
    // voyait la ligne du fait B arriver en tete, repartait a 1 h, et les deux
    // s'etouffaient mutuellement a l'heure — le mode de panne a 235 e-mails que
    // ce lot corrige. Constat de review.
    //
    // Un autre fait sur le meme bien n'efface donc pas l'anciennete du notre ;
    // seul le SILENCE le fait.
    let consecutives = 0
    let precedent = Date.now()
    for (const ligne of data) {
      if (ligne.acquitted_at) break
      const quand = new Date(ligne.created_at).getTime()
      // Un trou de plus de 48 h : ce qui precede appartient a un autre episode.
      if (Number.isFinite(quand) && precedent - quand > SILENCE_NOUVEL_EPISODE_MS) break
      if (messageDe(ligne.detail) !== message) continue
      consecutives++
      precedent = quand
    }
    if (!consecutives) return base
    return Math.min(base * Math.pow(2, consecutives), PLAFOND_ESCALADE_MS)
  } catch (e) {
    console.error('[founder-notify] escalade non calculee :', e.message)
    return base
  }
}

async function reportIncident(type, { userId = null, propertyId = null, propertyName = null, detail = null, threshold = 1, fenetreMs = 3600 * 1000 } = {}) {
  const pid = propertyId != null ? String(propertyId) : null

  // 1. Persistance systématique (alerted=false pour l'instant).
  let insertedId = null
  try {
    const { data } = await supabase.from('automation_incidents').insert({
      user_id:     userId,
      property_id: pid,
      type,
      detail:      detail == null ? null : (typeof detail === 'string' ? { message: detail } : detail),
      alerted:     false
    }).select('id').maybeSingle()
    insertedId = data?.id ?? null
  } catch (e) {
    console.error('[founder-notify] insert incident echec:', e.message)
  }

  // 2. Seuil + anti-spam sur la fenêtre — qui s'élargit si le fait persiste.
  const fenetreEffective = await fenetreEscaladee(type, pid, messageDe(detail), fenetreMs)
  const since = new Date(Date.now() - fenetreEffective).toISOString()
  let count = 1, alreadyAlerted = false
  try {
    let q = supabase.from('automation_incidents')
      .select('id, alerted').eq('type', type).gte('created_at', since)
    q = pid ? q.eq('property_id', pid) : q.is('property_id', null)
    const { data } = await q
    if (data) { count = data.length || 1; alreadyAlerted = data.some(r => r.alerted === true) }
  } catch (e) { /* défaut : count=1 */ }

  if (count < threshold || alreadyAlerted) return { recorded: true, alerted: false, count }

  // ⚠ LE JOURNAL APRES LA GARDE, PAS AVANT. Pose plus haut, il partait aussi sur
  // le chemin ETOUFFE : une ligne par tick de cron — 288 par jour — pour dire
  // qu'on amortit la repetition. Amortir le bruit en le journalisant a chaque
  // fois, c'est le deplacer, pas le reduire.
  if (fenetreEffective !== fenetreMs) {
    console.log(`[founder-notify] ${type}${pid ? ' / ' + pid : ''} persiste — `
      + `anti-spam porte a ${Math.round(fenetreEffective / 60000)} min`)
  }

  // 3. Alerte fondateur (SMS + email plateforme) + marque l'incident alerted.
  const label = LABELS[type] || type
  const name  = propertyName || (pid ? `bien ${pid}` : 'compte')
  const body  = typeof detail === 'string' ? detail : (detail?.message || '')
  const sms  = `HoteSmart ALERTE — ${label}\n${name}\n${body}`.slice(0, 300)
  const html = `<h3>HôteSmart — Alerte : ${esc(label)}</h3>`
    + `<p><strong>${esc(name)}</strong></p>`
    + (body ? `<p>${esc(body)}</p>` : '')
    + `<p style="color:#86868b;font-size:12px">Anti-spam : 1 par type et par bien toutes les `
    + `${Math.round(fenetreEffective / 60000)} min`
    + `${fenetreEffective > fenetreMs ? ' — élargi parce que ce fait persiste' : ''}.</p>`

  const out = { recorded: true, alerted: true, count }
  if (FOUNDER_PHONE && !SANS_SMS.has(type)) out.sms = await sendPlatformSms(FOUNDER_PHONE, sms)
  if (FOUNDER_EMAIL) out.email = await sendPlatformEmail(FOUNDER_EMAIL, `[HôteSmart] ${label} — ${name}`, html)
  if (!FOUNDER_PHONE && !FOUNDER_EMAIL) console.warn('[founder-notify] aucun canal fondateur configure (FOUNDER_PHONE/EMAIL)')
  if (insertedId) {
    try { await supabase.from('automation_incidents').update({ alerted: true }).eq('id', insertedId) } catch (e) {}
  }
  return out
}

// Alerte immédiate (threshold=1) — wrapper de compatibilité.
function notifyFounder(type, opts = {}) {
  return reportIncident(type, { ...opts, threshold: opts.threshold || 1 })
}

// ─── Envoi SEUL, sans persistance ni anti-spam ───────────────────────────────
// ⚠ RESERVE AUX ALARMES QUI GERENT ELLES-MEMES LEUR CYCLE DE VIE.
// `reportIncident` insere une ligne a CHAQUE appel et se tait si une alerte du
// meme (type, bien) est deja partie dans l'heure. Ces deux comportements sont
// justes pour un incident ordinaire, et faux pour une alarme recurrente :
// l'insertion dupliquerait l'incident que l'appelant tient deja ouvert, et
// l'anti-spam eteindrait precisement la relance qu'on veut voir insister.
//
// Aujourd'hui un seul appelant : lib/cron-overbooking.js. La surreservation est
// le seul incident du produit qui ne se rattrape pas apres coup — deux voyageurs
// devant la meme porte. Ne pas elargir cet usage sans la meme justification : une
// alerte qui crie pour rien finit ignoree.
async function envoyerAlerteBrute(type, { propertyName = null, propertyId = null, detail = null, prefixe = '' } = {}) {
  const label = LABELS[type] || type
  const name  = propertyName || (propertyId ? `bien ${propertyId}` : 'compte')
  const body  = typeof detail === 'string' ? detail : (detail?.message || '')
  const titre = `${prefixe}${label}`
  const sms   = `HoteSmart ALERTE — ${titre}\n${name}\n${body}`.slice(0, 300)
  const html  = `<h3>HôteSmart — Alerte : ${esc(titre)}</h3>`
    + `<p><strong>${esc(name)}</strong></p>`
    + (body ? `<p>${esc(body)}</p>` : '')
    + `<p style="color:#c0392b;font-size:12px">Cette alarme se répète jusqu'à acquittement manuel.</p>`

  const out = { sms: null, email: null }
  try { if (FOUNDER_PHONE) out.sms = await sendPlatformSms(FOUNDER_PHONE, sms) }
  catch (e) { console.error('[founder-notify] sms alarme echec:', e.message) }
  try { if (FOUNDER_EMAIL) out.email = await sendPlatformEmail(FOUNDER_EMAIL, `[HôteSmart] ${titre} — ${name}`, html) }
  catch (e) { console.error('[founder-notify] email alarme echec:', e.message) }
  if (!FOUNDER_PHONE && !FOUNDER_EMAIL) console.warn('[founder-notify] aucun canal fondateur configure')
  return out
}

module.exports = { reportIncident, notifyFounder, envoyerAlerteBrute, LABELS, SANS_SMS }
