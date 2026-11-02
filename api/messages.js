// api/messages.js
// Endpoint LECTURE de la messagerie unifiee (etape 4b).
// Le front (messagerie.html, etape 4c) lit UNIQUEMENT cet endpoint pour afficher
// les conversations. Source de verite = table `messages` (RLS sans policy -> lecture
// serveur en service key), enrichie par bookings_snapshot (metadonnees reservation :
// guestName, dates, statut, ota -- Channex + Beds24 unifies). CommonJS.

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { requirePermission } = require('../lib/require-permission')
const {
  arriveesProches, verdictDuCode, codesParReservation, lireLesCodes, STATUTS_SANS_ARRIVEE
} = require('../lib/ecran/etat-du-code')
const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')
// La MEME regle que le cron des codes d'arrivee : le menage est « fait » quand
// le dernier menage du bien est posterieur au depart precedent. Ne pas la
// recopier, elle a deja ete corrigee deux fois.
const { etatMenage } = require('../lib/cron-arrival-code')
// Lot 7 du chantier avis : l'archivage des fils (spec §9), une fonction pure.
const { etatArchivage } = require('../lib/archivage-conversations')
const { readStatus } = require('../lib/bookings-snapshot-status')

// Jour de Paris (celui des biens), YYYY-MM-DD, a un decalage de jours pres.
//
// ⚠ LE DECALAGE EST CALENDAIRE, PAS 24 h — ET CETTE COPIE AVAIT ETE OUBLIEE.
// Le correctif du lot (b) n'avait touche que celle de `api/ecran/aujourdhui.js`,
// alors que CET endpoint est l'AUTRE injecteur du meme `arriveesProches` : tout
// l'interet de `lib/ecran/etat-du-code.js` est qu'une seule regle serve les
// deux ecrans, et `jourParis` est justement la piece restee injectee.
// Mesure : le 24 octobre 2026 a 22 h 30 UTC (Paris 25 octobre 00 h 30, jour de
// 25 heures), `jourParis(0)` et `jourParis(1)` rendaient tous deux
// « 2026-10-25 » ; le 27 mars 2027, le lendemain SAUTAIT au 29. Ces nuits-la,
// `/messages` et `/aujourdhui` auraient designe des arrivees « proches »
// differentes pour la meme reservation le meme jour — la divergence exacte que
// l'extraction a ete ecrite pour empecher.
const jourParis = (decalage = 0) => {
  const [a, m, j] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })
    .format(new Date()).split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, j + decalage)).toISOString().slice(0, 10)
}
// `STATUTS_SANS_ARRIVEE` vit dans lib/ecran/etat-du-code.js : une seule
// definition, partagee par cet endpoint et par l'endpoint d'ecran.

// ─── Etat d'arrivee : menage fait ? code transmis ? ────────────────────────
// Demande de Thierry (23 septembre 2026) : sur les arrivees du jour et du
// lendemain, la messagerie dit d'un coup d'oeil si le logement est pret et si
// le voyageur a son code. Calcule ICI, sur le compte du proprietaire (service
// role), pour les seules arrivees proches : quelques lignes par jour.
//
// « Code transmis » se PROUVE : un message sortant du fil contient le code.
// Ni `access_codes.status` (qui passe a 'active' meme en Mode Test, quand le
// message n'est qu'une tache a valider), ni `message_sent_log` (ecrit aussi
// en Mode Test) ne disent que le voyageur l'a recu.
// ⚠ LE VERDICT A QUITTE CE FICHIER, IL N'A PAS CHANGE.
// `lib/ecran/etat-du-code.js` le porte maintenant, et `/api/ecran/aujourdhui`
// l'appelle avec une lecture BORNEE aux arrivees du jour et du lendemain — au
// lieu d'appeler CET endpoint pour un seul champ, ce qui coutait 18 requetes et
// 437 212 octets (mesure du 22 octobre 2026, 42 % du poids de l'accueil).
// Ici, rien ne bouge : memes entrees, meme sortie, et un test de PARITE
// compare les deux chemins sur les memes donnees.
async function etatsDArrivee(userId, conversations, snapByBooking) {
  const proches = arriveesProches(conversations, jourParis)
  if (!proches.length) return
  const { lignes, erreur } = await lireLesCodes(supabase,
    proches.map(c => c.bookId), proches.map(c => c.propertyId))
  if (erreur) console.error('[messages] lecture access_codes echec', erreur)
  const codeParBooking = codesParReservation(lignes)
  for (const c of proches) {
    const snap = snapByBooking[c.bookId] || {}
    let menage = 'inconnu'
    try {
      menage = await etatMenage(userId, c.propertyId, { arrival: c.firstNight, id: c.bookId }, snap.provider || c.provider || 'beds24')
    } catch (e) { console.error('[messages] etatMenage echec', c.bookId, e.message) }
    const row = codeParBooking[`${c.propertyId}|${c.bookId}`]
    c.arrivee = { menage, codeEtat: verdictDuCode(row, c.messages) }
  }
}

// ─── Normalisation OTA (marque blanche) ──────────────────────────────────────
// Valeur brute heterogene (Beds24 'airbnb' / Channex 'Airbnb.com' / ...) -> cle CSS.
function otaKey(raw) {
  const s = String(raw || '').toLowerCase()
  if (!s || s === 'direct')                                                    return 'direct'
  if (s.includes('airbnb'))                                                    return 'airbnb'
  if (s.includes('booking'))                                                   return 'booking'
  if (s.includes('vrbo') || s.includes('homeaway') || s.includes('abritel'))   return 'vrbo'
  if (s.includes('expedia'))                                                   return 'expedia'
  return 'ota'   // OTA non reconnue mais non-directe
}

const OTA_LABELS = { airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo', expedia: 'Expedia', ota: 'Autre OTA', direct: 'Direct' }

// Libelle propre : cle connue -> label mappe ; 'ota' inconnue -> capitalize brut.
function otaLabel(raw) {
  const k = otaKey(raw)
  if (k === 'ota') {
    const r = String(raw || '').trim()
    return r ? r[0].toUpperCase() + r.slice(1) : 'Direct'
  }
  return OTA_LABELS[k]
}

// Regle marque blanche : Channex -> OTA seule ; Beds24 -> "Beds24 · OTA". Jamais 'Channex'.
function displayLabel(provider, raw) {
  const label = otaLabel(raw)
  return provider === 'beds24' ? `Beds24 · ${label}` : label
}

// ─── L'archivage des fils (lot 7 du chantier avis, spec §9) ─────────────────
// ⚠ CET ENDPOINT EST LE SEUL WRITER des colonnes d'archivage de
// `conversation_flags` (migration 2026-09-25-conversation-flags-archivage.sql).
// L'epingle, elle, reste ecrite par la messagerie : on ne la touche jamais ici,
// on la RECOPIE telle quelle (sinon un upsert creerait une ligne epinglee par
// defaut — la colonne naît `true`).
//
// ⚠ `archive_after` DESIGNE, pour un archivage manuel, L'INSTANT de
// l'archivage : un message posterieur ramene le fil en boite principale. Les
// regles automatiques, elles, ne se stockent pas — elles se calculent a la
// lecture (lib/archivage-conversations.js), sans cron ni writer de plus.
async function appliquerArchivage(userId, conversations, depuis) {
  // ⚠ BORNEE AUX FILS LUS, PAR PAQUETS (constat de revue) : la table grossit
  // desormais (desepingler met a jour, archiver cree une ligne), et au-dela de
  // 1000 lignes PostgREST tronque SANS ERREUR — des epingles et des archivages
  // auraient ete ignores. Meme famille que la troncature de bookings_snapshot.
  const ids = conversations.map(c => String(c.bookId))
  const flags = []
  let error = null
  for (let i = 0; i < ids.length && !error; i += 100) {
    let r = await supabase
      .from('conversation_flags')
      .select('book_id, pinned, archived_manual, archive_after, unarchived_manual_at, read_at')
      .eq('user_id', userId)
      .in('book_id', ids.slice(i, i + 100))
    // Repli : migration read_at pas encore appliquee sur cette base.
    if (r.error && /read_at/.test(r.error.message || '')) {
      r = await supabase
        .from('conversation_flags')
        .select('book_id, pinned, archived_manual, archive_after, unarchived_manual_at')
        .eq('user_id', userId)
        .in('book_id', ids.slice(i, i + 100))
    }
    if (r.error) error = r.error
    else flags.push(...(r.data || []))
  }
  if (error) {
    // Colonnes absentes (migration du 25 septembre non appliquee) : pas
    // d'archivage, et l'ecran le sait — il ne montre ni l'onglet ni les boutons.
    console.error('[messages] archivage indisponible :', error.message)
    return false
  }
  // La publication arrive par le JOURNAL DU COEUR, jamais par les tables des
  // avis (spec §2 bis). Sans evenements lisibles, la regle « publiee » ne joue
  // pas — les autres, si.
  const { data: evts, error: eE } = await supabase
    .from('core_events')
    .select('payload, created_at')
    .eq('user_id', userId)
    .eq('type', 'avis.evaluation_publiee')
    .gte('created_at', depuis)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (eE) console.error('[messages] evenements de publication illisibles', eE.message)
  const publiee = new Map()
  for (const ev of evts || []) {
    const b = ev && ev.payload && ev.payload.booking_uid
    if (b && !publiee.has(String(b))) publiee.set(String(b), ev.created_at)
  }
  const parFil = new Map(flags.map(f => [String(f.book_id), f]))
  const maintenant = Date.now()
  for (const c of conversations) {
    const f = parFil.get(String(c.bookId)) || {}
    const e = etatArchivage({
      depart: c.lastNight, dernierMessage: c.lastTime,
      epinglee: f.pinned === true,
      archiveeManuellement: f.archived_manual === true, archiveeLe: f.archive_after || null,
      desarchiveeLe: f.unarchived_manual_at || null,
      publieeLe: publiee.get(String(c.bookId)) || null,
      maintenant,
    })
    c.archivee = e.archivee
    c.raisonArchivage = e.raison
    // L'etat lu (etape 2) : expose tel quel, null = jamais ouvert.
    c.readAt = f.read_at || null
    // L'epingle (etape 4, portee de l'ancienne page) : la liste la montre et
    // la remonte ; une epinglee n'est jamais archivee (etatArchivage le sait).
    c.epinglee = f.pinned === true
  }
  return true
}

// ─── L'etat LU (lot 2 etape 2) ───────────────────────────────────────────────
// SEUL WRITER de conversation_flags.read_at : l'ouverture d'un fil par l'hote.
// Memes verifications de perimetre que l'archivage ; la ligne est creee avec
// pinned=false explicite (la colonne nait true par defaut, voir archiverFil).
async function marquerLu(req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const bookingId = String(req.body.booking_id || '').trim()
  if (!bookingId || bookingId.length > 200) return res.status(400).json({ error: 'Conversation invalide' })
  const [m, sn] = await Promise.all([
    supabase.from('messages').select('property_id').eq('user_id', userId).eq('booking_id', bookingId).limit(1),
    supabase.from('bookings_snapshot').select('property_id').eq('user_id', userId).eq('booking_id', bookingId).limit(1),
  ])
  if (m.error || sn.error) return res.status(503).json({ error: 'Lecture impossible' })
  const bien = (m.data && m.data[0] && m.data[0].property_id) || (sn.data && sn.data[0] && sn.data[0].property_id) || null
  if (bien == null) return res.status(404).json({ error: 'Conversation introuvable' })
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(bien))) {
    return res.status(404).json({ error: 'Conversation introuvable' })
  }
  const maintenant = new Date().toISOString()
  const { data: flag, error: eF } = await supabase.from('conversation_flags')
    .select('id').eq('user_id', userId).eq('book_id', bookingId).maybeSingle()
  if (eF) return res.status(503).json({ error: 'Lecture impossible' })
  // `property_id_ref` comme l'archivage : la colonne du perimetre par bien ne
  // doit pas rester nulle sur une ligne nee d'une lecture (releve en review).
  const ecriture = flag
    ? supabase.from('conversation_flags').update({ read_at: maintenant, property_id_ref: String(bien) }).eq('id', flag.id)
    : supabase.from('conversation_flags').insert({ user_id: userId, book_id: bookingId, read_at: maintenant, pinned: false, property_id_ref: String(bien) })
  const { error: eW } = await ecriture
  if (eW) {
    // Migration read_at pas encore appliquee : on le dit, sans casser l'ecran.
    console.error('[messages] read_at non ecrit :', eW.message)
    return res.status(503).json({ error: 'Marquage impossible' })
  }
  return res.status(200).json({ ok: true, read_at: maintenant })
}

// ─── Clore une proposition (lot 2 etape 3) ───────────────────────────────────
// La VALIDATION reste la sequence de l'ancienne page (messagerie.html) : le
// client envoie d'abord par posterMessage (routage par SOURCE), PUIS cette
// action pose le statut et le journal `conversations` — ici et pas sous RLS,
// parce qu'un profil delegue n'ecrit pas ces tables en direct.
// Statuts : 'done' (envoyee) / 'ignored' (rejetee) — CEUX DE L'ANCIENNE PAGE ;
// le 'rejected' de la spec n'existe pas en base, on n'ouvre pas une seconde
// famille (decision du 11 octobre, signalee a Thierry).
async function cloreProposition(req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const taskId = String(req.body.task_id || '').trim()
  const statut = req.body.statut === 'done' ? 'done'
    : req.body.statut === 'ignored' ? 'ignored' : null
  const texte = typeof req.body.texte === 'string' ? req.body.texte.trim() : ''
  if (!taskId || taskId.length > 64 || !statut) return res.status(400).json({ error: 'Demande invalide' })
  // 'done' signifie « cette reponse est partie » : sans texte, pas de journal.
  if (statut === 'done' && !texte) return res.status(400).json({ error: 'Texte requis' })
  // Borne comme les autres champs du fichier : le journal n'accueille pas un
  // payload arbitraire qu'aucun envoi de cette taille ne peut prouver.
  if (texte.length > 10000) return res.status(400).json({ error: 'Texte trop long' })
  const { data: tache, error: eT } = await supabase.from('agent_tasks')
    .select('id, status, property_id, book_id, guest_name, guest_message')
    .eq('user_id', userId).eq('id', taskId).maybeSingle()
  if (eT) return res.status(503).json({ error: 'Lecture impossible' })
  if (!tache) return res.status(404).json({ error: 'Proposition introuvable' })
  // Perimetre par bien, 404 pas 403 — meme regle qu'archiverFil.
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(tache.property_id))) {
    return res.status(404).json({ error: 'Proposition introuvable' })
  }
  // ⚠ `sending` N'EST CLOTURABLE QUE POUR UN ENVOI (constat 4 de la revue).
  // C'est l'etat normal quand l'ecran a RESERVE la tache avant d'envoyer :
  // refuser ce statut bloquerait la cloture de son propre envoi. Mais
  // l'accepter pour un REJET rouvrait la course que le claim ferme : le cron
  // claime et commence l'appel provider, l'hote clique « Ne pas envoyer », la
  // tache passe a `ignored` — et le cron finit d'envoyer. Le voyageur a recu
  // le message, l'hote lit « rejetee », et rien ne le dit.
  // Un rejet n'a rien a reserver, donc rien a gagner a accepter `sending` : il
  // attend que la tache revienne (echec de l'envoi, ou reprise des orphelines).
  const CLOTURABLES = statut === 'done'
    ? ['pending_validation', STATUT_EN_COURS]
    : ['pending_validation']
  if (!CLOTURABLES.includes(tache.status)) {
    // Deja close ailleurs (ancienne page, autre onglet) : on le dit, on ne
    // re-ecrit pas — l'ecran retire la bulle dans les deux cas.
    return res.status(409).json({ error: 'deja_close', statut: tache.status })
  }
  // La condition de statut dans l'UPDATE ferme la course entre deux clics.
  // ⚠ ET ELLE DESARME L'ECHEANCE : sans `send_after: null`, une tache close par
  // l'ecran garderait son echeance et la passe du cron la relirait comme due.
  const { data: maj, error: eU } = await supabase.from('agent_tasks')
    .update({ status: statut, send_after: null })
    .eq('id', tache.id).eq('user_id', userId).eq('status', tache.status)
    .select('id')
  if (eU) return res.status(503).json({ error: 'Enregistrement impossible' })
  if (!maj || !maj.length) return res.status(409).json({ error: 'deja_close' })
  if (statut === 'done') {
    // Le journal de l'ancienne page, memes colonnes. Son echec ne defait pas
    // la cloture (l'ancienne page ne le verifie pas non plus) : il se logge.
    const { error: eJ } = await supabase.from('conversations').insert({
      user_id: userId, property_id: tache.property_id, guest_name: tache.guest_name,
      guest_message: tache.guest_message, agent_reply: texte, book_id: String(tache.book_id)
    })
    if (eJ) console.error('[messages] journal conversations non ecrit', eJ.message)
  }
  return res.status(200).json({ ok: true, task_id: tache.id, statut })
}

// ─── Le CLAIM, avant que l'ecran envoie (chantier « delai de reponse IA ») ───
//
// ⚠ C'EST LE CORRECTIF DU CONSTAT CENTRAL DE L'ETAPE 0. `cloreProposition` a
// toujours eu un claim atomique, mais l'ecran envoyait D'ABORD et le claim
// venait APRES : « le client envoie d'abord par posterMessage, PUIS cette
// action pose le statut ». Inoffensif tant que seul un humain envoyait — deux
// onglets se soldaient par un 409 apres coup. Des que le CRON peut envoyer la
// meme tache, cet ordre produit le double envoi au voyageur.
//
// L'ecran suit donc desormais le meme ordre que la passe du cron :
//   1. POST { action: 'reserver' }  -> la tache passe a `sending` (409 si prise)
//   2. l'ecran envoie               -> seulement si l'etape 1 a reussi
//   3. POST { action: 'proposition' } -> `done` + journal
// Un 409 a l'etape 1 veut dire « cette reponse vient de partir » : l'ecran le
// dit et n'envoie RIEN.
const STATUT_EN_COURS = 'sending'

async function reserverProposition (req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const taskId = String(req.body.task_id || '').trim()
  if (!taskId || taskId.length > 64) return res.status(400).json({ error: 'Demande invalide' })

  const { data: tache, error: eT } = await supabase.from('agent_tasks')
    .select('id, status, property_id, suggested_reply')
    .eq('user_id', userId).eq('id', taskId).maybeSingle()
  if (eT) return res.status(503).json({ error: 'Lecture impossible' })
  if (!tache) return res.status(404).json({ error: 'Proposition introuvable' })
  // Perimetre par bien, 404 pas 403 — meme regle qu'archiverFil.
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(tache.property_id))) {
    return res.status(404).json({ error: 'Proposition introuvable' })
  }

  // ⚠ LA CONDITION DE STATUT EST LE CLAIM : zero ligne = quelqu'un d'autre l'a
  // prise (le cron, ou un autre onglet). On ne reessaie pas, on le DIT.
  const { data: prise, error: eU } = await supabase.from('agent_tasks')
    .update({ status: STATUT_EN_COURS, updated_at: new Date().toISOString() })
    .eq('id', tache.id).eq('user_id', userId).eq('status', 'pending_validation')
    .select('id')
  if (eU) return res.status(503).json({ error: 'Reservation impossible' })
  if (!prise || !prise.length) {
    return res.status(409).json({ error: 'deja_prise', statut: tache.status })
  }
  return res.status(200).json({ ok: true, task_id: tache.id, texte: tache.suggested_reply })
}

// ⚠ ET UNE RESERVATION SE RELACHE — MAIS DESARMEE, comme la reprise des
// orphelines du cron (constat 14 de la revue du 27 octobre 2026). L'ecran ne
// relache qu'apres un ECHEC de `posterMessage` : c'est precisement le cas
// « on ne sait pas si l'envoi est parti ». `reprendreOrphelines` refuse
// deliberement de renvoyer dans ce doute et rend la main a l'hote ; laisser
// `send_after` dans le passe ici faisait l'inverse — le cron renvoyait le meme
// brouillon au cycle suivant. Deux traitements opposes pour le meme doute.
async function relacherProposition (req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const taskId = String(req.body.task_id || '').trim()
  if (!taskId || taskId.length > 64) return res.status(400).json({ error: 'Demande invalide' })
  const { data: tache, error: eT } = await supabase.from('agent_tasks')
    .select('id, property_id').eq('user_id', userId).eq('id', taskId).maybeSingle()
  if (eT) return res.status(503).json({ error: 'Lecture impossible' })
  if (!tache) return res.status(404).json({ error: 'Proposition introuvable' })
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(tache.property_id))) {
    return res.status(404).json({ error: 'Proposition introuvable' })
  }
  const { error: eU } = await supabase.from('agent_tasks')
    .update({
      status: 'pending_validation',
      send_after: null,
      // ⚠ LA SUSPENSION S'EFFACE AUSSI (constat 5 de la seconde revue).
      // Desarmer en laissant `suspendu_le` produisait un etat SANS ISSUE : la
      // bulle affichait « En attente : vous modifiez » pour toujours, sans lien
      // de reprise (il exige une echeance) et sans que le cron la reprenne
      // (`reprendreSuspensionsDormantes` exige `send_after` non nul).
      suspendu_le: null,
      summary: "Envoi interrompu : impossible de savoir si le message est parti. "
        + "Vérifiez le fil avant de renvoyer.",
      updated_at: new Date().toISOString()
    })
    .eq('id', tache.id).eq('user_id', userId).eq('status', STATUT_EN_COURS)
  if (eU) return res.status(503).json({ error: 'Enregistrement impossible' })
  return res.status(200).json({ ok: true, task_id: tache.id, desarmee: true })
}

// ─── La REPRISE du compte a rebours (decision 4 de Thierry, 27/10/2026) ──────
//
// ⚠ « Reprise AVEC LE TEMPS RESTANT, 5 minutes au minimum » — et ce temps se
// CALCULE, il n'a pas besoin d'une colonne. `send_after - suspendu_le` est
// exactement ce qui restait quand l'hote a ouvert le brouillon : les deux
// instants sont en base.
//
// Sans ce recalcul, deux defauts opposes : si on laissait `send_after` tel
// quel, un brouillon ouvert vingt minutes partirait a la seconde ou l'hote le
// relache — sous ses doigts ; et si on repartait du delai PLEIN, l'hote qui
// jette un oeil a sa proposition repousserait l'envoi de quinze minutes a
// chaque regard.
//
// Le plancher de 5 minutes existe pour le cas limite : un brouillon suspendu a
// trente secondes de son echeance ne doit pas partir dans la seconde qui suit
// le relachement.
const REPRISE_MIN_MS = 5 * 60 * 1000

async function reprendreEcheance (req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const taskId = String(req.body.task_id || '').trim()
  if (!taskId || taskId.length > 64) return res.status(400).json({ error: 'Demande invalide' })

  const { data: tache, error: eT } = await supabase.from('agent_tasks')
    .select('id, status, property_id, send_after, suspendu_le')
    .eq('user_id', userId).eq('id', taskId).maybeSingle()
  if (eT) return res.status(503).json({ error: 'Lecture impossible' })
  if (!tache) return res.status(404).json({ error: 'Proposition introuvable' })
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(tache.property_id))) {
    return res.status(404).json({ error: 'Proposition introuvable' })
  }
  if (tache.status !== 'pending_validation') {
    return res.status(409).json({ error: 'deja_close', statut: tache.status })
  }
  // Rien a reprendre : la tache n'etait pas suspendue, ou n'a pas d'echeance.
  if (!tache.suspendu_le || !tache.send_after) {
    return res.status(409).json({ error: 'rien_a_reprendre' })
  }

  const echeance = Date.parse(tache.send_after)
  const suspension = Date.parse(tache.suspendu_le)
  if (!Number.isFinite(echeance) || !Number.isFinite(suspension)) {
    return res.status(409).json({ error: 'rien_a_reprendre' })
  }
  const maintenant = Date.now()
  const restait = Math.max(REPRISE_MIN_MS, echeance - suspension)
  const nouvelle = new Date(maintenant + restait).toISOString()

  const { data: maj, error: eU } = await supabase.from('agent_tasks')
    .update({ suspendu_le: null, send_after: nouvelle, updated_at: new Date(maintenant).toISOString() })
    .eq('id', tache.id).eq('user_id', userId).eq('status', 'pending_validation')
    .select('id')
  if (eU) return res.status(503).json({ error: 'Enregistrement impossible' })
  if (!maj || !maj.length) return res.status(409).json({ error: 'deja_close' })
  return res.status(200).json({ ok: true, task_id: tache.id, send_after: nouvelle })
}

// ─── Le brouillon que l'hote a ecrit (decision 6 de Thierry, 27/10/2026) ─────
//
// ⚠ SANS CETTE ACTION, LA REPRISE DU COMPTE A REBOURS ENVOIE LE TEXTE DE L'IA.
// L'edition de l'hote ne touchait pas la base : `suggested_reply` portait le
// texte de l'IA, et l'ecran envoyait le contenu du champ au moment du clic. Une
// reprise automatique livrait donc au voyageur la version que l'hote avait
// justement commence a corriger.
//
// Trois colonnes bougent ensemble, et chacune a son role :
//   · `suggested_reply` -> le texte de l'hote, celui qui partira ;
//   · `suspendu_le`     -> l'ouverture suspend le compte a rebours (regle 2) ;
//   · `modifie_le`      -> la reprise devra l'ALERTER (decision 7), et la
//                          sourdine de nuit ne s'applique qu'a ce cas.
async function enregistrerBrouillon (req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const taskId = String(req.body.task_id || '').trim()
  const texte = typeof req.body.texte === 'string' ? req.body.texte : null
  const ouverture = req.body.ouverture === true
  if (!taskId || taskId.length > 64) return res.status(400).json({ error: 'Demande invalide' })
  // Une ouverture n'apporte pas de texte ; une sauvegarde en exige un.
  if (!ouverture && (texte === null || !texte.trim())) {
    return res.status(400).json({ error: 'Texte requis' })
  }
  // Borne comme les autres champs du fichier.
  if (texte !== null && texte.length > 10000) return res.status(400).json({ error: 'Texte trop long' })

  const { data: tache, error: eT } = await supabase.from('agent_tasks')
    .select('id, status, property_id').eq('user_id', userId).eq('id', taskId).maybeSingle()
  if (eT) return res.status(503).json({ error: 'Lecture impossible' })
  if (!tache) return res.status(404).json({ error: 'Proposition introuvable' })
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(tache.property_id))) {
    return res.status(404).json({ error: 'Proposition introuvable' })
  }
  // ⚠ UNE TACHE DEJA PARTIE NE S'EDITE PAS : sans cette garde, l'hote
  // ecraserait le texte d'une reponse deja delivree, et le journal
  // `conversations` dirait autre chose que ce que le voyageur a lu.
  if (tache.status !== 'pending_validation') {
    return res.status(409).json({ error: 'deja_close', statut: tache.status })
  }

  const maintenant = new Date().toISOString()
  const patch = { suspendu_le: maintenant, updated_at: maintenant }
  // ⚠ `modifie_le` NE SE POSE QUE SUR UNE VRAIE ECRITURE. Une simple ouverture
  // suspend le compte a rebours, mais elle ne doit PAS declencher l'alerte de
  // reprise ni la sourdine : l'hote qui ouvre, lit et ferme n'a rien change, et
  // le brouillon de l'IA peut partir la nuit comme en journee (decision 7).
  if (!ouverture) {
    patch.suggested_reply = texte
    patch.modifie_le = maintenant
  }

  const { data: maj, error: eU } = await supabase.from('agent_tasks')
    .update(patch)
    .eq('id', tache.id).eq('user_id', userId).eq('status', 'pending_validation')
    .select('id')
  if (eU) return res.status(503).json({ error: 'Enregistrement impossible' })
  if (!maj || !maj.length) return res.status(409).json({ error: 'deja_close' })
  return res.status(200).json({ ok: true, task_id: tache.id, suspendu: true, modifie: !ouverture })
}

// ─── L'epingle (lot 2 etape 4) ───────────────────────────────────────────────
// Portee de l'ancienne messagerie, qui l'ecrivait en direct sous RLS — ici en
// action gardee, pour qu'un profil delegue `messages = write` epingle aussi.
// ⚠ UNE MISE A JOUR, PAS UNE SUPPRESSION (lecon du lot 7 avis) : la ligne
// porte aussi l'archivage et read_at. Creation avec pinned explicite.
async function epinglerFil(req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const epingler = req.body.action === 'epingler'
  const bookingId = String(req.body.booking_id || '').trim()
  if (!bookingId || bookingId.length > 200 || bookingId === '__SIM_ENABLED__') {
    return res.status(400).json({ error: 'Conversation invalide' })
  }
  // Perimetre par bien, 404 jamais 403 — memes verifications qu'archiverFil.
  const [m, sn] = await Promise.all([
    supabase.from('messages').select('property_id').eq('user_id', userId).eq('booking_id', bookingId).limit(1),
    supabase.from('bookings_snapshot').select('property_id').eq('user_id', userId).eq('booking_id', bookingId).limit(1),
  ])
  if (m.error || sn.error) return res.status(503).json({ error: 'Lecture impossible' })
  const bien = (m.data && m.data[0] && m.data[0].property_id) || (sn.data && sn.data[0] && sn.data[0].property_id) || null
  if (bien == null) return res.status(404).json({ error: 'Conversation introuvable' })
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(bien))) {
    return res.status(404).json({ error: 'Conversation introuvable' })
  }
  // L'upsert d'archiverFil, a l'identique : pas de select-puis-insert (deux
  // onglets simultanes violaient la contrainte unique — releve en review) ;
  // les colonnes absentes (archivage, read_at) ne sont pas touchees.
  const { error: eW } = await supabase.from('conversation_flags').upsert(
    { user_id: userId, book_id: bookingId, pinned: epingler, property_id_ref: String(bien) },
    { onConflict: 'user_id,book_id' })
  if (eW) {
    console.error('[messages] epingle non ecrite :', eW.message)
    return res.status(503).json({ error: 'Épingle non enregistrée' })
  }
  return res.status(200).json({ ok: true, booking_id: bookingId, epinglee: epingler })
}

async function archiverFil(req, res) {
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const archiver = req.body.action === 'archiver'
  const bookingId = String(req.body.booking_id || '').trim()
  // La ligne du simulateur vit dans la meme table : elle n'est pas un sejour.
  if (!bookingId || bookingId.length > 200 || bookingId === '__SIM_ENABLED__') {
    return res.status(400).json({ error: 'Conversation invalide' })
  }
  // ⚠ LE PERIMETRE PAR BIEN : un membre limite au bien A n'archive pas un fil
  // du bien B. Le bien se lit sur le fil (messages), sinon sur la reservation.
  const [m, sn] = await Promise.all([
    supabase.from('messages').select('property_id').eq('user_id', userId).eq('booking_id', bookingId).limit(1),
    supabase.from('bookings_snapshot').select('property_id').eq('user_id', userId).eq('booking_id', bookingId).limit(1),
  ])
  if (m.error || sn.error) return res.status(503).json({ error: 'Lecture impossible' })
  const bien = (m.data && m.data[0] && m.data[0].property_id) || (sn.data && sn.data[0] && sn.data[0].property_id) || null
  if (bien == null) return res.status(404).json({ error: 'Conversation introuvable' })
  const refs = refsDuPerimetre(garde.contexte)
  // ⚠ 404, PAS 403 (constat de revue) : un 403 apprenait a un membre limite au
  // bien A qu'un fil existe sur le bien B — ce que le GET d'existence, plus
  // haut, s'interdit deja.
  if (refs !== null && !refs.map(String).includes(String(bien))) {
    return res.status(404).json({ error: 'Conversation introuvable' })
  }
  const { data: flag, error: eF } = await supabase.from('conversation_flags')
    .select('pinned').eq('user_id', userId).eq('book_id', bookingId).maybeSingle()
  if (eF) return res.status(503).json({ error: 'Lecture impossible' })
  const pinned = Boolean(flag && flag.pinned)
  // Spec §9 : une conversation epinglee n'est jamais archivee. On le dit.
  if (archiver && pinned) {
    return res.status(409).json({ error: 'Désépinglez la conversation avant de l’archiver.', motif: 'epinglee' })
  }
  const maintenant = new Date().toISOString()
  const etat = archiver
    ? { archived_manual: true, archive_after: maintenant, archived_reason: 'manuel', unarchived_manual_at: null }
    : { archived_manual: false, archive_after: null, archived_reason: null, unarchived_manual_at: maintenant }
  const { error: eU } = await supabase.from('conversation_flags').upsert(
    { user_id: userId, book_id: bookingId, pinned, property_id_ref: String(bien), ...etat },
    { onConflict: 'user_id,book_id' })
  if (eU) {
    console.error('[messages] archivage non enregistre', eU.message)
    return res.status(503).json({ error: 'Archivage non enregistré' })
  }
  return res.status(200).json({ ok: true, booking_id: bookingId, archivee: archiver })
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // L'archivage manuel est une ECRITURE : sa propre garde, avant la lecture.
  if (req.method === 'POST' && req.body && (req.body.action === 'archiver' || req.body.action === 'desarchiver')) {
    return await archiverFil(req, res)
  }
  // Etape 2 de la messagerie V5 : l'ouverture d'un fil pose read_at.
  if (req.method === 'POST' && req.body && req.body.action === 'lu') {
    return await marquerLu(req, res)
  }
  // Etape 3 : Envoyer / Rejeter une proposition clot la tache (et le journal).
  if (req.method === 'POST' && req.body && req.body.action === 'proposition') {
    return await cloreProposition(req, res)
  }
  // Chantier « delai de reponse IA » : le claim AVANT l'envoi, son relachement,
  // et le brouillon que l'hote a ecrit.
  if (req.method === 'POST' && req.body && req.body.action === 'reserver') {
    return await reserverProposition(req, res)
  }
  if (req.method === 'POST' && req.body && req.body.action === 'relacher') {
    return await relacherProposition(req, res)
  }
  if (req.method === 'POST' && req.body && req.body.action === 'brouillon') {
    return await enregistrerBrouillon(req, res)
  }
  if (req.method === 'POST' && req.body && req.body.action === 'reprendre') {
    return await reprendreEcheance(req, res)
  }
  // Etape 4 : l'epingle, portee de l'ancienne page.
  if (req.method === 'POST' && req.body && (req.body.action === 'epingler' || req.body.action === 'desepingler')) {
    return await epinglerFil(req, res)
  }

  // ── Droits ──
  // Endpoint de COLLECTION : aucun identifiant client ne designe le compte, c'est
  // l'en-tete X-Compte qui le fait — revalide par la garde.
  //
  // ⚠ ENDPOINT DELEGABLE (etape 5, lot 3), et c'est le plus sensible du lot : il
  // renvoie les CONVERSATIONS DES VOYAGEURS, corps des messages compris. Trois
  // barrieres :
  //   1. `user_id` = compte cible ;
  //   2. filtre de perimetre sur `messages.property_id` ;
  //   3. meme filtre sur `bookings_snapshot`, qui porte les noms et les dates.
  // La troisieme n'est pas cosmetique : sans elle, un membre restreint recevrait
  // en memoire les reservations de tout le compte, et il suffirait d'un message
  // mal rattache pour qu'elles remontent a l'ecran.
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const refsAutorisees = refsDuPerimetre(garde.contexte)
  // Filtre de perimetre en SQL (construction + garde de format : lib/permissions).
  // Une expression vide signifie « perimetre vide ou refuse » : on echoue ferme.
  // Le cas property_id NULL est EXCLU (defaut) : une conversation voyageur sans
  // bien rattache ne doit pas apparaitre a un membre limite a un autre bien.
  const filtreOr = filtrePerimetreSql(refsAutorisees)
  // ─── La tuile « messages ecrits par l'IA » (dette 66) ──────────────────────
  // COMPTE SEUL, depuis la COLONNE origine seulement : les envois d'avant la
  // migration (origine null) ne comptent pas — aucun historique reconstitue
  // (decision de Thierry du 12 octobre 2026). Migration absente : la tuile
  // se dit indisponible, elle n'invente pas un zero.
  if (req.method === 'GET' && req.query && req.query.stats === 'ia') {
    const brut = typeof req.query.depuis === 'string' ? req.query.depuis : ''
    const depuis = Number.isFinite(new Date(brut).getTime())
      ? brut : new Date(Date.now() - 7 * 86400000).toISOString()
    // Un perimetre vide compte ZERO — jamais la forme {conversations} d'une
    // autre reponse (revue de 658d758).
    if (filtreOr === '') return res.status(200).json({ messages_ia: 0, depuis })
    let q = supabase.from('messages').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('direction', 'outbound')
      .in('origine', ['ia_validee', 'ia_modifiee', 'ia_auto'])
      .gte('sent_at', depuis)
    if (filtreOr) q = q.or(filtreOr)
    const { count, error } = await q
    if (error) {
      if (/origine/.test(error.message || '')) return res.status(200).json({ indisponible: true })
      console.error('[messages] stats ia', error.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
    return res.status(200).json({ messages_ia: count || 0, depuis })
  }

  if (filtreOr === '') return res.status(200).json({ conversations: [] })

  // ─── Existence d'un fil pour UNE reservation ───────────────────────────────
  // Sert au bouton « Ouvrir la conversation » de la fiche du calendrier
  // (docs/kb/reservation-directe.md §12) : un bouton actif qui ouvre une liste
  // vide fait croire a une panne, donc la fiche a besoin de savoir AVANT.
  //
  // ⚠ UNE RESERVATION A LA FOIS, VOLONTAIREMENT. La version precedente demandait
  // toute la fenetre d'un coup a `api/calendar.js` : `messages` etant un journal,
  // le rendu depassait le plafond de 1000 lignes de PostgREST — silencieusement —
  // et la liste d'identifiants faisait exploser la longueur d'URL. Ici, `limit(1)`
  // sur un index (booking_id, sent_at) : exact, borne, et paye seulement quand
  // l'hote ouvre une fiche.
  //
  // Memes barrieres que la collection : compte cible ET filtre de perimetre — un
  // membre limite au bien A ne doit pas apprendre qu'un fil existe sur le bien B.
  if (req.method === 'GET' && req.query && req.query.booking_id) {
    const bookingId = String(req.query.booking_id)
    try {
      // ⚠ `.or()` SEULEMENT SI LE FILTRE EXISTE, comme les deux requetes de la
      // collection juste en dessous. `refsDuPerimetre` rend `null` — pas `''` —
      // pour un PROPRIETAIRE de compte (perimetre total), et `filtrePerimetreSql`
      // propage ce `null` : la garde `=== ''` ne l'attrape pas. Un `.or(null)`
      // inconditionnel partait en `or=(null)`, que PostgREST refuse — l'endpoint
      // rendait donc 500 pour le cas NORMAL, et le bouton « Ouvrir la
      // conversation » restait eteint sur « Fil indisponible » pour tout le monde.
      let q = supabase
        .from('messages')
        .select('booking_id')
        .eq('user_id', userId)
        .eq('booking_id', bookingId)
      if (filtreOr) q = q.or(filtreOr)
      const { data, error } = await q.limit(1)
      if (error) {
        console.error('[messages] existence conversation', error.message)
        return res.status(500).json({ error: 'Lecture impossible' })
      }
      return res.status(200).json({ booking_id: bookingId, has_conversation: (data || []).length > 0 })
    } catch (e) {
      console.error('[messages] existence conversation echec', e.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
  }

  try {
    // Fenetre 6 mois.
    const since = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString()

    // ── 2 SELECT (zero N+1) : messages recents + snapshots du user ──
    const [msgRes, snapRes] = await Promise.all([
      (async () => {
        const lire = (colonnes) => {
          let q = supabase
            .from('messages')
            .select(colonnes)
            .eq('user_id', userId)
            .gte('sent_at', since)
          if (filtreOr) q = q.or(filtreOr)
          return q
            .order('sent_at', { ascending: false })   // 2000 plus RECENTS (re-tri asc en memoire)
            .limit(2000)
        }
        // `origine` (dette 66) avec repli : migration pas encore posee.
        let r = await lire('booking_id, property_id, provider, ota, sender, direction, body, sent_at, kind, origine')
        if (r.error && /origine/.test(r.error.message || '')) {
          r = await lire('booking_id, property_id, provider, ota, sender, direction, body, sent_at, kind')
        }
        return r
      })(),
      (() => {
        let q = supabase
          .from('bookings_snapshot')
          .select('booking_id, snapshot')
          .eq('user_id', userId)
        // Le filtre messages suffirait (la jointure est pilotee par eux), mais
        // charger les reservations hors perimetre en memoire n'a aucun interet.
        if (filtreOr) q = q.or(filtreOr)
        return q
      })()
    ])

    if (msgRes.error) {
      // Le detail PostgREST (colonne, contrainte, fragment de requete) reste
      // dans les logs : la reponse ne porte qu'un libelle.
      console.error('[messages] select messages echec', msgRes.error.message)
      return res.status(500).json({ error: 'Erreur lecture messages' })
    }
    // ⚠ L'erreur du SECOND select doit remonter elle aussi. La laisser passer
    // rendait toutes les conversations « Voyageur », sans dates ni statut, sans
    // qu'aucune erreur ne soit visible — et le filtre de perimetre porte
    // desormais sur cette requete aussi.
    if (snapRes.error) {
      console.error('[messages] select bookings_snapshot echec', snapRes.error.message)
      return res.status(500).json({ error: 'Erreur lecture réservations' })
    }
    const messages = msgRes.data || []
    const snaps    = snapRes.data || []

    // Jointure memoire : snapshot par booking_id.
    const snapByBooking = {}
    snaps.forEach(s => { snapByBooking[String(s.booking_id)] = s.snapshot || {} })

    // ── Group-by booking_id (un seul passage) ──
    const convMap = {}
    let nullBookingCount = 0
    for (const m of messages) {
      if (m.booking_id == null || m.booking_id === '') { nullBookingCount++; continue }
      const bookId = String(m.booking_id)
      if (!convMap[bookId]) {
        convMap[bookId] = {
          bookId,
          propertyId: m.property_id != null ? String(m.property_id) : '',
          provider:   m.provider || '',
          _otaRaw:    null,
          messages:   []
        }
      }
      const conv = convMap[bookId]
      // fallback ota : 1ere ota non-null rencontree dans les messages
      if (!conv._otaRaw && m.ota) conv._otaRaw = m.ota
      conv.messages.push({
        sender:    m.sender,
        direction: m.direction,
        body:      m.body,
        sent_at:   m.sent_at,
        kind:      m.kind,
        origine:   m.origine || null
      })
    }

    if (nullBookingCount > 0) {
      console.log(`[messages] ${nullBookingCount} message(s) booking_id null ignore(s)`)
    }

    // ── Enrichissement snapshot + marque blanche ──
    const conversations = Object.values(convMap).map(conv => {
      const snap = snapByBooking[conv.bookId] || {}
      const guestName = [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim() || 'Voyageur'
      // ota : priorite snapshot.source, fallback 1ere ota messages, sinon 'direct'
      const otaRaw = snap.source || conv._otaRaw || 'direct'
      // re-tri chronologique ASC (la requete etait DESC pour capter les plus recents)
      conv.messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
      const lastTime = conv.messages.length ? conv.messages[conv.messages.length - 1].sent_at : null
      return {
        bookId:       conv.bookId,
        propertyId:   conv.propertyId,
        provider:     conv.provider,
        ota:          otaLabel(otaRaw),
        platform:     otaKey(otaRaw),
        displayLabel: displayLabel(conv.provider, otaRaw),
        guestName,
        firstNight:   snap.arrival   || null,
        lastNight:    snap.departure || null,
        // ⚠ PAR LE LECTEUR CANONIQUE : un statut absent VAUT `confirmed`
        // (`lib/bookings-snapshot-status.js` : « comportement historique des
        // 5 writers »), et le vocabulaire brut des providers (`inquiry`,
        // `black`) se traduit. `|| null` faisait sortir ces reservations du
        // filtre `arr && st && …` de `arriveesProches`, alors qu'elles sont
        // bien listees comme arrivees du jour par `api/menages.js`.
        status:       readStatus(snap, snap.provider || conv.provider),
        // Le telephone du voyageur, tel que le snapshot le porte (Channex comme
        // Beds24 le nomment `guestPhone`). L'ecran messagerie en fait un lien
        // d'appel : le jour de l'arrivee, c'est souvent le seul canal qui reste.
        guestPhone:   snap.guestPhone || null,
        lastTime,
        messages:     conv.messages
      }
    })

    // Tri conversations par lastTime desc (plus recentes d'abord).
    conversations.sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0))

    // Archivage (lot 7). Un echec ne prive personne de sa messagerie : les fils
    // restent tous en boite principale, et l'ecran ne propose pas l'archivage.
    let archivage = false
    try { archivage = await appliquerArchivage(userId, conversations, since) }
    catch (e) { console.error('[messages] archivage echec', e.message) }

    // Menage fait ? code transmis ? — pour les arrivees du jour et de demain.
    // Un echec ici ne prive personne de sa messagerie : les marques manquent, c'est tout.
    try { await etatsDArrivee(userId, conversations, snapByBooking) }
    catch (e) { console.error('[messages] etats d\'arrivee echec', e.message) }

    // ─── Pagination (lot 2 etape 2) ─────────────────────────────────────────
    // `limit` tronque la reponse APRES le tri par dernier message ; `before`
    // (un lastTime) demande la page suivante. Sans `limit`, la reponse reste
    // complete : l'ancienne messagerie et les autres lecteurs ne changent pas.
    // Les ARRIVEES du jour et de demain sont toujours servies dans la premiere
    // page (sans `before`) : l'ecran les met en tete, elles ne peuvent pas
    // attendre la page 2.
    const limite = Number.parseInt(req.query.limit, 10)
    if (Number.isInteger(limite) && limite > 0) {
      // ⚠ CURSEUR COMPOSITE (lastTime, bookId) — releve en review : deux fils
      // dont les derniers messages partagent la meme seconde (ecrits par le
      // meme passage de cron) rendaient le second INATTEIGNABLE avec un simple
      // `< before` ; et un lastTime nul a la frontiere rendait next_before
      // null avec has_more true, que le client lisait comme la fin.
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null
      const beforeId = typeof req.query.before_id === 'string' ? req.query.before_id : ''
      const cleTri = c => [c.lastTime || '', String(c.bookId)]
      const apresCurseur = c => {
        const [t, id] = cleTri(c)
        return t < before || (t === before && id < beforeId)
      }
      const aujourdHui = jourParis(0), demain = jourParis(1)
      const arrivee = c => {
        const arr = String(c.firstNight || '').slice(0, 10)
        const st = String(c.status || '').toLowerCase()
        return (arr === aujourdHui || arr === demain) && !STATUTS_SANS_ARRIVEE.has(st)
      }
      // Tri STABLE sur la cle du curseur (la liste arrive triee par lastTime,
      // on departage les ex aequo par bookId pour que le curseur soit sur).
      conversations.sort((a, b) => {
        const [ta, ia] = cleTri(a); const [tb, ib] = cleTri(b)
        return tb.localeCompare(ta) || ib.localeCompare(ia)
      })
      const fenetre = before ? conversations.filter(apresCurseur) : conversations
      const page = fenetre.slice(0, limite)
      if (!before) {
        for (const c of conversations) if (arrivee(c) && !page.includes(c)) page.push(c)
      }
      const hasMore = fenetre.length > limite
      const bord = hasMore ? fenetre[limite - 1] : null
      return res.status(200).json({
        conversations: page, archivage, has_more: hasMore,
        next_before: bord ? (bord.lastTime || '') : null,
        next_before_id: bord ? String(bord.bookId) : null
      })
    }

    return res.status(200).json({ conversations, archivage })

  } catch (e) {
    console.error('[messages] exception', e.message)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
