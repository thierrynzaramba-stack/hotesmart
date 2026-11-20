// api/labo-ia.js — LE LABO IA (page pages/labo-ia.html)
// Chantier du 20 novembre 2026, doc docs/kb/labo-ia.md.
//
// ⚠ RÉSERVÉ AU FONDATEUR, ET C'EST UNE GARDE SERVEUR (règle absolue du
// dépôt : un masquage ne protège rien). Même porte que la carte « Coût du
// cron » de api/diagnostic.js : session vérifiée, puis e-mail = FOUNDER_EMAIL.
// ⚠ LES DONNÉES LUES SONT TOUJOURS CELLES DU COMPTE DE L'APPELANT
// (`garde.userId`) : un en-tête X-Compte (compte basculé) ne change rien,
// la garde `titulaire` sans ressource l'ignore et cet endpoint ne lit jamais
// `accountUserId`.
//
// GET  ?action=catalogue                      -> { ok, modeles: [...], cle, plafonds }
// GET  ?action=biens                          -> { ok, biens: [{ id, nom }] }
// GET  ?action=conversations&bien=<uuid>      -> { ok, conversations: [...] }
// GET  ?action=contexte&bien=<uuid>[&booking] -> { ok, systeme, tokensEstimes, messages }
// POST { action: 'question', modele, bien, booking?, question }
//   -> { ok, texte, modele, hebergeur, enChine, restrictionLevee, usage, coutUsd, dureeMs }
// POST { action: 'facture', modele, fichier (base64) }
//   -> { ok, lecture: { ok, lu } | { ok: false, motif }, texte, … même usage }
//
// ⚠ UN APPEL = UN MODÈLE. La page lance les modèles en parallèle et affiche
// chaque réponse à son arrivée : une fonction qui attendrait le plus lent de
// quinze modèles buterait sur son mur de durée.
//
// ⚠ RIEN N'EST ÉCRIT DANS LE PRODUIT, RIEN NE PART AU VOYAGEUR. Seul effet :
// la ligne de `ia_appels` (lib/ia/openrouter.js) et la dépense OpenRouter.
//
// Refus parlants, jamais silencieux :
//  - 403 : pas le fondateur, ou FOUNDER_EMAIL absent ;
//  - 400 : demande invalide, modèle hors catalogue, appel trop cher (le motif
//          est nommé) ;
//  - 404 : bien ou séjour introuvable SUR CE COMPTE ;
//  - 409 bien_sans_reference : le bien n'a pas de référence provider ;
//  - 429 garde_labo : plafond du jour atteint (dollars ou appels) ;
//  - 502 ia : le modèle a refusé ou n'a pas répondu (motif ET coût rendus) ;
//  - 503 : lecture impossible, catalogue illisible, ou clé OpenRouter absente.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { sansArchives } = require('../lib/biens-vivants')
const { replisDuBien } = require('../lib/balises')
const L = require('../lib/labo-ia')
const OR = require('../lib/ia/openrouter')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ LU À CHAQUE APPEL (même raison que api/diagnostic.js : une garde figée au
// démarrage à froid se trompe toute la vie de l'instance).
const fondateur = () => String(process.env.FOUNDER_EMAIL || '').trim().toLowerCase()
const cleOpenRouter = () => !!String(process.env.OPENROUTER_API_KEY || '').trim()

const ACTIONS_GET = ['catalogue', 'biens', 'conversations', 'contexte']
const ACTIONS_POST = ['question', 'facture']

module.exports = async function handler (req, res) {
  try {
    return await router(req, res)
  } catch (e) {
    console.error('[labo-ia] exception:', e && e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'Erreur serveur' })
  }
}

/** La porte : rend l'identifiant du fondateur, ou null (la réponse est partie). */
async function gardeFondateur (req, res) {
  const garde = await requirePermission(req, res, { domaine: 'titulaire' })
  if (!garde.ok) return null
  if (!fondateur()) {
    res.status(403).json({ error: 'Réservé au fondateur', motif: 'FOUNDER_EMAIL absent de la configuration' })
    return null
  }
  if (String(garde.email || '').trim().toLowerCase() !== fondateur()) {
    res.status(403).json({ error: 'Réservé au fondateur' })
    return null
  }
  // L'APPELANT, jamais `accountUserId` : voir l'en-tête.
  return garde.userId
}

async function router (req, res) {
  // ⚠ AVANT LE PREMIER REFUS, le 405 compris (dette 90) : la garde le repose,
  // mais un refus qui la précède partirait sans lui.
  res.setHeader('Cache-Control', 'private, no-store')
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const action = req.method === 'GET' ? String((req.query || {}).action || '') : String((req.body || {}).action || '')
  if (!(req.method === 'GET' ? ACTIONS_GET : ACTIONS_POST).includes(action)) return res.status(400).json({ error: 'Action inconnue' })

  const uid = await gardeFondateur(req, res)
  if (!uid) return

  if (action === 'catalogue') {
    const c = await OR.lireCatalogue()
    if (!c.ok) return res.status(502).json({ error: 'Catalogue indisponible', motif: c.motif })
    const p = L.plafonds()
    return res.status(200).json({
      ok: true, modeles: c.modeles, cle: cleOpenRouter(),
      plafonds: { usdJour: p.usdJour, usdAppel: p.usdAppel, tokensQuestion: L.MAX_TOKENS_QUESTION, tokensFacture: L.MAX_TOKENS_FACTURE }
    })
  }

  if (action === 'biens') {
    const { data, error } = await sansArchives(supabase.from('properties')
      .select('id, name, provider_property_id').eq('user_id', uid))
      .order('name', { ascending: true })
    if (error) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ ok: true, biens: (data || []).map(b => ({ id: b.id, nom: b.name || 'Logement' })) })
  }

  if (action === 'conversations') {
    const bien = await bienDuCompte(uid, req.query.bien)
    if (bien.statut) return res.status(bien.statut).json({ error: bien.erreur })
    const { data: msgs, error } = await supabase.from('messages')
      .select('booking_id, sent_at, direction')
      .eq('user_id', uid).in('property_id', bien.refs).not('booking_id', 'is', null)
      .order('sent_at', { ascending: false }).limit(1000)
    if (error) return res.status(503).json({ error: 'Lecture impossible' })
    const ids = [...new Set((msgs || []).map(m => String(m.booking_id)))].slice(0, L.MAX_CONVERSATIONS)
    let snaps = []
    if (ids.length) {
      const r = await supabase.from('bookings_snapshot').select('booking_id, snapshot')
        .eq('user_id', uid).in('booking_id', ids)
      if (r.error) return res.status(503).json({ error: 'Lecture impossible' })
      snaps = r.data || []
    }
    return res.status(200).json({ ok: true, conversations: L.resumerConversations(msgs, snaps) })
  }

  if (action === 'contexte') {
    const ctx = await chargerContexte(uid, req.query.bien, req.query.booking)
    if (ctx.statut) return res.status(ctx.statut).json({ error: ctx.erreur })
    const systeme = L.contexteSysteme(ctx.contexte)
    return res.status(200).json({ ok: true, systeme, tokensEstimes: L.estimerTokens(systeme), messages: ctx.contexte.fil.length })
  }

  // ── Les deux essais : un modèle par appel ─────────────────────────────────
  const corps = req.body || {}
  const idModele = String(corps.modele || '').trim()
  if (!OR.ID_MODELE.test(idModele)) return res.status(400).json({ error: 'modele_invalide' })
  if (!cleOpenRouter()) {
    return res.status(503).json({ error: 'cle_absente', message: 'La clé OpenRouter n’est pas encore posée dans Vercel (OPENROUTER_API_KEY).' })
  }
  // ⚠ LE MODÈLE DOIT ÊTRE DANS LE CATALOGUE (review du lot, constat 6) : la
  // forme laisse passer `:online` (recherche web payante, hors de
  // `data_collection`) et `openrouter/auto` (n'importe quel modèle). Et le
  // catalogue donne les PRIX, sans lesquels aucune garde de coût ne tient.
  const cat = await OR.lireCatalogue()
  if (!cat.ok) return res.status(503).json({ error: 'catalogue_indisponible', motif: cat.motif })
  const modele = cat.modeles.find(m => m.id === idModele)
  if (!modele) return res.status(400).json({ error: 'modele_inconnu', message: 'Ce modèle n’est pas dans le catalogue OpenRouter.' })
  const p = L.plafonds()
  const refus = await plafondAtteint(uid, p)
  if (refus) return res.status(refus.statut).json(refus.corps)
  // La liste des hébergeurs établis en Chine (repli codé si illisible).
  const heb = await OR.lireHebergeurs()
  const deps = { sb: supabase, hebergeurs: heb.ok ? heb.hebergeurs : null }

  if (action === 'question') {
    const q = L.validerQuestion(corps.question)
    if (!q.ok) return res.status(400).json({ error: q.erreur })
    const ctx = await chargerContexte(uid, corps.bien, corps.booking)
    if (ctx.statut) return res.status(ctx.statut).json({ error: ctx.erreur })
    const messages = L.messagesQuestion(ctx.contexte, q.question)
    const maxTokens = L.maxTokensPour(modele, L.MAX_TOKENS_QUESTION)
    const trop = tropCher(modele, L.estimerTokens(messages.map(m => m.content).join('\n')), maxTokens, p)
    if (trop) return res.status(400).json(trop)
    const r = await OR.appelerModele({
      modele: idModele, messages, maxTokens,
      journal: { fonction: L.FONCTION_QUESTION, userId: uid, propertyId: ctx.ref, bookingId: ctx.booking }
    }, deps)
    if (!r.ok) return res.status(r.motif === 'cle_absente' ? 503 : 502).json({ error: 'ia', ...echec(r) })
    return res.status(200).json({ ok: true, ...r })
  }

  // action === 'facture'
  const f = L.validerFichier(corps.fichier)
  if (!f.ok) return res.status(400).json({ error: f.erreur })
  if (f.type !== 'application/pdf' && !modele.image) {
    return res.status(400).json({ error: 'modele_sans_image', message: 'Ce modèle ne lit pas les images.' })
  }
  const maxTokens = L.maxTokensPour(modele, L.MAX_TOKENS_FACTURE)
  const trop = tropCher(modele, L.estimerTokensFichier(f) + L.estimerTokens(require('../lib/charges/lecture').CONSIGNE), maxTokens, p)
  if (trop) return res.status(400).json(trop)
  const r = await OR.appelerModele({
    modele: idModele, messages: L.messagesFacture(f), maxTokens,
    journal: { fonction: L.FONCTION_FACTURE, userId: uid }
  }, deps)
  if (!r.ok) return res.status(r.motif === 'cle_absente' ? 503 : 502).json({ error: 'ia', ...echec(r) })
  return res.status(200).json({ ok: true, ...r, texte: String(r.texte || '').slice(0, 6000), lecture: L.lectureDeFacture(r.texte) })
}

/** Un échec rend son motif ET son coût : un échec facturé se compte. */
function echec (r) {
  return { motif: r.motif, message: r.message, dureeMs: r.dureeMs, coutUsd: r.coutUsd ?? null, usage: r.usage || null }
}

/** Le refus AVANT envoi d'un appel dont le coût maximal dépasse le plafond par appel. */
function tropCher (modele, tokensEntree, maxTokens, p) {
  const max = L.coutMaxEstime(modele, tokensEntree, maxTokens)
  if (max === null || max <= p.usdAppel) return null
  return {
    error: 'trop_cher',
    message: `Coût maximal estimé ${max.toFixed(2)} $ pour ce modèle, au-delà du plafond de ${p.usdAppel} $ par appel (LABO_IA_MAX_APPEL_USD).`,
    coutMaxUsd: Math.round(max * 10000) / 10000
  }
}

/**
 * Le bien désigné par le client, résolu SUR LE COMPTE de l'appelant (règle 11).
 * `refs` : ses références provider — celle du bien, et la cible d'une
 * migration en cours (lib/bien-du-provider.js) : un séjour peut porter l'une
 * ou l'autre.
 */
async function bienDuCompte (uid, idBien) {
  if (!L.estUuid(idBien)) return { statut: 400, erreur: 'bien_invalide' }
  const { data, error } = await supabase.from('properties').select('*')
    .eq('user_id', uid).eq('id', idBien).maybeSingle()
  if (error) return { statut: 503, erreur: 'Lecture impossible' }
  if (!data) return { statut: 404, erreur: 'Bien introuvable' }
  // ⚠ SANS RÉFÉRENCE, PAS DE CONTEXTE : `String(null)` lirait la base d'un
  // bien nommé « null » et l'écrirait au journal (review, constat 9).
  if (!data.provider_property_id) return { statut: 409, erreur: 'bien_sans_reference' }
  const refs = [data.provider_property_id, data.migration_target_property_id].filter(Boolean).map(String)
  return { ligne: data, refs: [...new Set(refs)] }
}

/**
 * Le contexte d'un essai : base de connaissance du bien (celle que lit
 * l'agent, « Hors IA » exclu, replis de la fiche compris), consignes de
 * l'hôte, et — si un séjour est choisi — les derniers messages de son fil.
 */
async function chargerContexte (uid, idBien, bookingBrut) {
  const b = await bienDuCompte(uid, idBien)
  if (b.statut) return b
  const vb = L.validerBooking(bookingBrut)
  if (!vb.ok) return { statut: 400, erreur: vb.erreur }
  const bien = b.ligne
  // ⚠ PIÈGE N°1 DU DÉPÔT (règle 10) : knowledge, messages et agent_prompting
  // sont clés sur la RÉFÉRENCE PROVIDER, jamais l'UUID.
  const ref = String(bien.provider_property_id)
  const { buildKnowledgeText, loadPromptingInstructions } = require('../lib/cron-classify')

  const { data: knowledge, error: eK } = await supabase.from('knowledge')
    .select('*').eq('user_id', uid).eq('property_id', ref)
  if (eK) return { statut: 503, erreur: 'Lecture impossible' }
  const connaissance = buildKnowledgeText(knowledge || [], { replis: replisDuBien(bien) })
  const lues = await loadPromptingInstructions(uid, ref)
  const consignes = [lues.global, lues.propertyOverride].filter(Boolean).join('\n')

  let fil = []
  let voyageur = null
  let arrivee = null
  let depart = null
  if (vb.booking) {
    // Le séjour doit appartenir à CE bien de CE compte : sinon 404, jamais le
    // fil ni le nom d'un autre.
    const { data: snap, error: eS } = await supabase.from('bookings_snapshot')
      .select('booking_id, property_id, snapshot')
      .eq('user_id', uid).eq('booking_id', vb.booking).maybeSingle()
    if (eS) return { statut: 503, erreur: 'Lecture impossible' }
    if (snap && !b.refs.includes(String(snap.property_id))) return { statut: 404, erreur: 'Séjour introuvable' }
    const { data: msgs, error: eM } = await supabase.from('messages')
      .select('direction, kind, body, sent_at')
      .eq('user_id', uid).in('property_id', b.refs).eq('booking_id', vb.booking)
      .order('sent_at', { ascending: false }).limit(L.MESSAGES_DU_FIL)
    if (eM) return { statut: 503, erreur: 'Lecture impossible' }
    if (!snap && !(msgs || []).length) return { statut: 404, erreur: 'Séjour introuvable' }
    fil = L.filDepuisMessages(msgs)
    const s = (snap && snap.snapshot) || {}
    voyageur = [s.firstName, s.lastName].filter(Boolean).join(' ').trim() || null
    arrivee = s.arrival || null
    depart = s.departure || null
  }
  return {
    ref,
    booking: vb.booking,
    contexte: { bienNom: bien.name, connaissance, consignes, voyageur, arrivee, depart, fil }
  }
}

/**
 * Garde de coût du labo, lue dans le journal `ia_appels` : 24 h glissantes,
 * fonctions du labo SEULES (les appels de l'agent sur le même compte ne
 * comptent pas), échecs compris. ⚠ UN COMPTE ILLISIBLE NE DIT PAS « OUI »
 * (même règle que la lecture des charges) : sans le compte, on ne dépense pas.
 */
async function plafondAtteint (uid, p) {
  const depuis = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  // Une ligne par tentative ; au plus deux tentatives par appel : la borne de
  // lecture couvre le plafond d'appels, et une lecture PLEINE se dit pleine.
  const borne = p.appelsJour * 2 + 1
  const { data, error } = await supabase.from('ia_appels').select('cout_usd')
    .eq('user_id', uid).in('fonction', [L.FONCTION_QUESTION, L.FONCTION_FACTURE])
    .gte('created_at', depuis).limit(borne)
  if (error || !Array.isArray(data)) return { statut: 503, corps: { error: 'Lecture impossible' } }
  if (data.length >= p.appelsJour) {
    return { statut: 429, corps: { error: 'garde_labo', message: `Plafond du labo atteint : ${p.appelsJour} appels en 24 h.` } }
  }
  const depense = data.reduce((s, l) => s + (Number.isFinite(Number(l.cout_usd)) ? Number(l.cout_usd) : 0), 0)
  if (depense >= p.usdJour) {
    return { statut: 429, corps: { error: 'garde_labo', message: `Plafond du labo atteint : ${depense.toFixed(2)} $ dépensés en 24 h (plafond ${p.usdJour} $, LABO_IA_PLAFOND_USD).` } }
  }
  return null
}

module.exports.gardeFondateur = gardeFondateur
module.exports.chargerContexte = chargerContexte
