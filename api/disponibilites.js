// api/disponibilites.js — QUAND UNE PRESTATAIRE EST LA (lot 3.5).
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Les regles recurrentes (`provider_availability_rules`) et les exceptions
// ponctuelles (`provider_availability_exceptions`) posees au lot 3.1, cote HOTE.
// La prestataire, elle, declare ses indisponibilites depuis sa PWA
// (`api/menages-public.js`) : elle DECLARE, l'hote VOIT TOUT ET CORRIGE.
//
// ⚠ NE PAS CONFONDRE LES DEUX FILTRES (§12.1, docs/kb/menage.md) :
//   `weekdays` (sur la LIAISON) = quels jours l'hote lui CONFIE ce bien ;
//   ces regles                  = quels jours elle EST LA, tous biens confondus.
// Se declarer disponible un mardi ne rend pas attitree le mardi — sinon une
// prestataire du week-end recevrait des menages en semaine.
//
// ⚠ AUCUNE CHAINE RRULE NE REMONTE A L'ECRAN, ET AUCUNE N'EN DESCEND. L'hote
// regle des cases (des jours, une cadence) ; `construireRrule` produit le
// standard. C'est la decision gravee au §2 de la spec : jamais de recurrence
// codee a la main, jamais de RRULE saisie a la main non plus.
//
// DOMAINE `prestataires` : quand quelqu'un travaille releve de sa gestion, pas
// de la consultation du planning. Un membre `menages: read` voit les menages, il
// n'a pas a savoir quand une prestataire est en conge — c'est exactement le
// choix fait par la RLS de ces deux tables (migration du 4 septembre).

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, verifierSession } = require('../lib/require-permission')
const { construireRrule, cleJour } = require('../lib/cleaning/availability')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Plafonds de lecture. Une prestataire qui declare ses conges de l'annee tient
// tres largement dedans ; au-dela, c'est une anomalie qu'on veut voir.
const LOT_REGLES = 200
const LOT_EXCEPTIONS = 500

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Le jour de calendrier d'il y a N jours. ⚠ A MIDI UTC, comme partout dans ce
// domaine : a minuit, le moindre decalage de fuseau fait basculer la date.
function jourMoins (n) {
  const d = new Date(Date.now() - n * 86400000)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12))
    .toISOString().slice(0, 10)
}

// Le prestataire designe par le client appartient-il A CE COMPTE ?
//
// ⚠ REVIEW.md regle 11 : une donnee client qui designe une ressource ne se
// valide pas, elle ne s'utilise pas. Sans cette verification, un hote pourrait
// lire — et poser — les conges d'une prestataire d'un AUTRE compte en changeant
// un identifiant dans la requete.
async function prestataireDuCompte (userId, providerId) {
  if (!providerId || !UUID_RE.test(String(providerId))) return { erreur: 400 }
  const { data, error } = await supabase.from('profiles')
    .select('id, first_name, active')
    .eq('id', String(providerId))
    .eq('account_user_id', userId)
    .eq('access_mode', 'lien')
    .maybeSingle()
  // ⚠ Une panne n'est pas un prestataire inconnu : rendre 400 ferait croire a
  // l'hote qu'il s'est trompe de personne.
  if (error) { console.error('[disponibilites] lecture profil echec', error.message); return { erreur: 503 } }
  if (!data) return { erreur: 400 }
  return { profil: data }
}

module.exports = async function handler (req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  // Session d'abord — elle seule repond 401 — puis les droits.
  const appelant = await verifierSession(req, res)
  if (!appelant) return

  const lecture = req.method === 'GET'
  const garde = await requirePermission(req, res, {
    domaine: 'prestataires', niveau: lecture ? 'read' : 'write',
    userId: appelant, compteDelegue: true
  })
  if (!garde.ok) return
  const userId = garde.accountUserId

  const providerId = lecture ? req.query.provider_id : (req.body || {}).provider_id
  const qui = await prestataireDuCompte(userId, providerId)
  if (qui.erreur === 400) return res.status(400).json({ error: 'Prestataire inconnu' })
  if (qui.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })

  if (lecture) return await lire(res, userId, providerId)
  return await ecrire(req, res, userId, providerId)
}

// ─── LECTURE ────────────────────────────────────────────────────────────────
//
// Rend les regles telles que l'ECRAN les manipule — des jours et une cadence —
// pas la chaine RRULE. `label` porte le libelle construit a l'ecriture ; la
// chaine elle-meme ne sort jamais.
async function lire (res, userId, providerId) {
  const { data: regles, error: errR } = await supabase.from('provider_availability_rules')
    .select('id, label, active, created_at')
    .eq('user_id', userId).eq('provider_id', providerId)
    .order('created_at', { ascending: true }).limit(LOT_REGLES)
  if (errR) {
    console.error('[disponibilites] lecture regles echec', errR.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  // ⚠ BORNEE PAR LE BAS, ET C'EST UNE GARDE, PAS UN CONFORT. Triee par date
  // croissante et plafonnee, une lecture sans plancher finit par ne rendre QUE
  // du passe des qu'une prestataire a accumule assez d'exceptions : les conges A
  // VENIR tombent hors du lot, l'hote croit qu'elle n'en a declare aucun, et il
  // lui confie des menages sur ses jours d'absence. On garde un mois d'historique
  // — de quoi comprendre ce qui vient de se passer — et tout le futur.
  const plancher = jourMoins(30)
  const { data: exceptions, error: errE } = await supabase.from('provider_availability_exceptions')
    .select('id, date, available, reason, source')
    .eq('user_id', userId).eq('provider_id', providerId)
    .gte('date', plancher)
    .order('date', { ascending: true }).limit(LOT_EXCEPTIONS)
  if (errE) {
    console.error('[disponibilites] lecture exceptions echec', errE.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  return res.status(200).json({
    regles: regles || [],
    exceptions: exceptions || [],
    // ⚠ Le compte se voit a l'ecran : c'est ce qui permet a l'hote de comprendre
    // « aucune regle = disponible » sans avoir a le deviner.
    aucune_regle: !(regles || []).some(r => r.active !== false)
  })
}

// ─── ECRITURE ───────────────────────────────────────────────────────────────
async function ecrire (req, res, userId, providerId) {
  const { action } = req.body || {}

  if (action === 'poserRegle')      return await poserRegle(req, res, userId, providerId)
  if (action === 'retirerRegle')    return await retirerRegle(req, res, userId, providerId)
  if (action === 'poserException')  return await poserException(req, res, userId, providerId)
  if (action === 'retirerException') return await retirerException(req, res, userId, providerId)
  return res.status(400).json({ error: 'Action inconnue' })
}

// Une regle de RECURRENCE : « le week-end, une semaine sur deux ».
//
// ⚠ L'HOTE N'ECRIT JAMAIS DE RRULE. Il envoie des jours (0 = dimanche … 6),
// une cadence et une date d'ancrage ; `construireRrule` produit la chaine. Une
// chaine acceptee depuis le client serait une expression executee par la lib
// `rrule` sur des donnees d'un autre compte, et un `COUNT=100000` suffirait a
// faire tourner le moteur d'assignation pour rien a chaque cycle.
async function poserRegle (req, res, userId, providerId) {
  const { jours, toutes_les_n_semaines, depuis } = req.body || {}
  if (!Array.isArray(jours) || !jours.length) {
    return res.status(400).json({ error: 'Choisissez au moins un jour' })
  }
  const lus = jours.map(v =>
    typeof v === 'number' ? v
      : (typeof v === 'string' && /^[0-6]$/.test(v.trim()) ? Number(v) : NaN))
  if (lus.some(j => !Number.isInteger(j) || j < 0 || j > 6)) {
    return res.status(400).json({ error: 'Jours invalides' })
  }
  const cadence = toutes_les_n_semaines === undefined ? 1 : Number(toutes_les_n_semaines)
  // Au-dela de 4, ce n'est plus une cadence de menage : c'est une saisie qui a
  // derape, et la recurrence deviendrait illisible a l'ecran.
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > 4) {
    return res.status(400).json({ error: 'Cadence invalide' })
  }
  // ⚠ L'ANCRAGE DECIDE QUELLE SEMAINE EST « ON ». Une date illisible retombe sur
  // aujourd'hui plutot que d'echouer : c'est le comportement de
  // `construireRrule`, et l'ecran envoie toujours une date.
  const ancre = depuis && cleJour(depuis) ? cleJour(depuis) : null
  // ⚠ DEDUPLIQUE AVANT LE LIBELLE. `construireRrule` deduplique de son cote, si
  // bien qu'un corps `{jours:[1,1,2]}` produisait une RRULE correcte mais un
  // libelle « Tous les lundi, lundi et mardi » — affiche tel quel dans les deux
  // ecrans, et stocke pour toujours.
  const joursUniques = [...new Set(lus)].sort((a, b) => a - b)
  const rrule = construireRrule({ jours: joursUniques, toutesLesNSemaines: cadence, depuis: ancre })
  if (!rrule) return res.status(400).json({ error: 'Règle impossible' })

  const { data, error } = await supabase.from('provider_availability_rules')
    .insert({ user_id: userId, provider_id: providerId, rrule,
              label: libelle(joursUniques, cadence), active: true })
    .select('id, label, active, created_at')
    .maybeSingle()
  if (error) {
    console.error('[disponibilites] insert regle echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  return res.status(200).json({ success: true, regle: data })
}

// ⚠ ON DESACTIVE, ON NE SUPPRIME PAS. Une regle supprimee emporterait la raison
// pour laquelle des menages passes ont ete attribues comme ils l'ont ete.
async function retirerRegle (req, res, userId, providerId) {
  const { id } = req.body || {}
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: 'Règle inconnue' })
  // ⚠ Les trois filtres comptent : l'identifiant vient du CLIENT, et sans
  // `user_id` + `provider_id` il designerait la regle de n'importe qui.
  const { data, error } = await supabase.from('provider_availability_rules')
    .update({ active: false })
    .eq('id', String(id)).eq('user_id', userId).eq('provider_id', providerId)
    .select('id')
  if (error) {
    console.error('[disponibilites] retrait regle echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  if (!data || !data.length) return res.status(404).json({ error: 'Règle introuvable' })
  return res.status(200).json({ success: true })
}

// Une EXCEPTION : « pas ce samedi-la », ou au contraire « exceptionnellement
// disponible ce jour-la ». Elle prime toujours sur les regles (§12).
async function poserException (req, res, userId, providerId) {
  const { date, available, reason } = req.body || {}
  const jour = cleJour(date)
  if (!jour) return res.status(400).json({ error: 'Date invalide' })
  if (typeof available !== 'boolean') return res.status(400).json({ error: 'Sens de l\'exception manquant' })

  // ⚠ UNE SEULE DECISION PAR PERSONNE ET PAR JOUR (contrainte SQL). L'upsert
  // remplace : reposer « pas ce samedi » sur un jour deja marque disponible doit
  // corriger, pas echouer — l'hote corrige ce que la prestataire a declare, et
  // c'est le sens meme de ce reglage.
  const { data, error } = await supabase.from('provider_availability_exceptions')
    .upsert({ user_id: userId, provider_id: providerId, date: jour,
              available, reason: reason ? String(reason).slice(0, 200) : null,
              source: 'hote' }, { onConflict: 'provider_id,date' })
    .select('id, date, available, reason, source')
    .maybeSingle()
  if (error) {
    console.error('[disponibilites] upsert exception echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  return res.status(200).json({ success: true, exception: data })
}

// ⚠ Une exception, elle, se SUPPRIME : ce n'est pas une regle mais une
// correction ponctuelle, et la retirer rend simplement la journee a sa
// recurrence. La contrainte d'unicite interdirait d'ailleurs d'en empiler.
async function retirerException (req, res, userId, providerId) {
  const { id } = req.body || {}
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: 'Exception inconnue' })
  const { data, error } = await supabase.from('provider_availability_exceptions')
    .delete()
    .eq('id', String(id)).eq('user_id', userId).eq('provider_id', providerId)
    .select('id')
  if (error) {
    console.error('[disponibilites] suppression exception echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  if (!data || !data.length) return res.status(404).json({ error: 'Exception introuvable' })
  return res.status(200).json({ success: true })
}

// Le libelle lisible, construit UNE FOIS a l'ecriture et stocke : l'ecran ne
// doit jamais avoir a relire une RRULE pour dire ce qu'elle veut dire.
const NOMS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
function libelle (jours, cadence) {
  const tries = [...jours].sort((a, b) => a - b)
  const noms = tries.map(j => NOMS[j])
  const liste = noms.length > 1
    ? `${noms.slice(0, -1).join(', ')} et ${noms[noms.length - 1]}`
    : noms[0]
  if (cadence === 1) return `Tous les ${liste}`
  if (cadence === 2) return `${liste.charAt(0).toUpperCase()}${liste.slice(1)}, une semaine sur deux`
  return `${liste.charAt(0).toUpperCase()}${liste.slice(1)}, toutes les ${cadence} semaines`
}

module.exports.libelle = libelle
