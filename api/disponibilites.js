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
const { lireRrule, cleJour } = require('../lib/cleaning/availability')
// ⚠ LA REGLE RECURRENTE EST VALIDEE EN UN SEUL ENDROIT, partage avec la PWA
// (`api/menages-public.js`) depuis le 15 septembre 2026.
const { validerRegle, libelle } = require('../lib/cleaning/regles')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Plafonds de lecture. Une prestataire qui declare ses conges de l'annee tient
// tres largement dedans ; au-dela, c'est une anomalie qu'on veut voir.
const LOT_REGLES = 200
const LOT_EXCEPTIONS = 500
// Un conge est une PLAGE : il en faut beaucoup moins pour couvrir une annee.
const LOT_CONGES = 200
// L'ecran regle jusqu'a un an devant (decision du 15 septembre 2026) : une plage
// au-dela n'est pas un conge, c'est une saisie qui a derape.
const HORIZON_JOURS = 400

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Le jour de calendrier d'il y a N jours. ⚠ A MIDI UTC, comme partout dans ce
// domaine : a minuit, le moindre decalage de fuseau fait basculer la date.
function jourMoins (n) {
  const d = new Date(Date.now() - n * 86400000)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12))
    .toISOString().slice(0, 10)
}

// Le jour de calendrier dans N jours. Meme normalisation, meme raison.
function jourPlus (n) {
  const d = new Date(Date.now() + n * 86400000)
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
    // ⚠ `rrule` EST LUE ICI, ET NE SORT PAS D'ICI. L'ecran a besoin des JOURS et
    // de la CADENCE pour recocher ses cases — pas de la chaine, qui reste une
    // affaire de serveur (§2 de la spec). On la relit, on en extrait la forme,
    // et on jette la chaine avant de repondre.
    .select('id, label, active, created_at, rrule')
    .eq('user_id', userId).eq('provider_id', providerId)
    // ⚠ LES INACTIVES NE REMONTENT PAS, ET CE N'EST PAS UN CONFORT.
    // Une regle « retiree » est DESACTIVEE, pas supprimee — elle porte la raison
    // pour laquelle des menages passes ont ete attribues comme ils l'ont ete. Le
    // calendrier, lui, desactive et repose a CHAQUE changement de case : les
    // lignes mortes s'accumulent vite. Sans ce filtre, le plafond de 200 finissait
    // par ne rendre QUE des inactives (tri par date croissante), et alors :
    // l'ecran annoncait « aucune regle, disponible tous les jours » pendant que le
    // moteur appliquait les vraies, et l'enregistrement ne pouvait plus retirer
    // des regles qu'il ne voyait plus — chaque geste AJOUTAIT au lieu de
    // remplacer. Exactement l'addition definitive que ce code dit empecher.
    .eq('active', true)
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

  // ⚠ BORNEE SUR `fin`, PAS SUR `debut`. Un conge commence en juin et couvre
  // juillet : le filtrer sur sa date de DEBUT le ferait disparaitre de l'ecran
  // des le 1er juillet, alors qu'il verrouille encore des jours. On garde tout ce
  // qui n'est pas termine, plus un mois d'historique pour comprendre le passe
  // recent — meme plancher que les exceptions, meme raison.
  const { data: conges, error: errC } = await supabase.from('conges_plages')
    .select('id, debut, fin, motif, source')
    .eq('user_id', userId).eq('provider_id', providerId)
    .gte('fin', plancher)
    .order('debut', { ascending: true }).limit(LOT_CONGES)
  if (errC) {
    console.error('[disponibilites] lecture conges echec', errC.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  // ⚠ LA CHAINE NE PART PAS. `lireRrule` en tire ce que l'ecran doit recocher ;
  // une regle qu'on ne sait pas relire sort sans `jours` — l'ecran affiche alors
  // son libelle sans pouvoir la modifier, ce qui est degrade mais honnete.
  const reglesLisibles = (regles || []).map(r => {
    const forme = lireRrule(r.rrule)
    return {
      id: r.id, label: r.label, active: r.active, created_at: r.created_at,
      jours: forme ? forme.jours : null,
      cadence: forme ? forme.cadence : null,
      ancre: forme ? forme.ancre : null
    }
  })

  return res.status(200).json({
    regles: reglesLisibles,
    exceptions: exceptions || [],
    conges: conges || [],
    // ⚠ Le compte se voit a l'ecran : c'est ce qui permet a l'hote de comprendre
    // « aucune regle = disponible » sans avoir a le deviner.
    aucune_regle: !reglesLisibles.some(r => r.active !== false)
  })
}

// ─── ECRITURE ───────────────────────────────────────────────────────────────
async function ecrire (req, res, userId, providerId) {
  const { action } = req.body || {}

  if (action === 'poserRegle')      return await poserRegle(req, res, userId, providerId)
  if (action === 'retirerRegle')    return await retirerRegle(req, res, userId, providerId)
  if (action === 'poserException')  return await poserException(req, res, userId, providerId)
  if (action === 'retirerException') return await retirerException(req, res, userId, providerId)
  if (action === 'poserConge')      return await poserConge(req, res, userId, providerId)
  if (action === 'retirerConge')    return await retirerConge(req, res, userId, providerId)
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
  // ⚠ LA VALIDATION VIT DANS `lib/cleaning/regles.js`, PARTAGEE AVEC LA PWA.
  // Depuis le 15 septembre 2026, la prestataire regle aussi ses jours depuis
  // `api/menages-public.js` : recopier la validation ici aurait produit deux
  // regles pour la meme chose, et la copie finit toujours par etre la plus
  // permissive des deux.
  const v = validerRegle(req.body || {}, cleJour)
  if (v.erreur) return res.status(400).json({ error: v.erreur })

  const { data, error } = await supabase.from('provider_availability_rules')
    .insert({ user_id: userId, provider_id: providerId, rrule: v.rrule,
              label: v.label, active: true })
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

// Un CONGE : une PLAGE de dates, posee et retiree d'un geste (15 septembre 2026).
//
// ⚠ POURQUOI PAS DES EXCEPTIONS EN SERIE. Huit lignes isolees ne disent pas
// qu'elles formaient un conge : ni lesquelles verrouiller a l'ecran, ni quoi
// supprimer ensemble. La plage est l'objet, pas ses jours.
//
// ⚠ IL PRIME SUR TOUT, exception « disponible » comprise (etage 1 de la
// precedence). C'est pour ca que l'ecran verrouille les jours couverts : gratter
// un jour au milieu laisserait une plage qui dit une chose et un calendrier qui
// en montre une autre.
async function poserConge (req, res, userId, providerId) {
  const { debut, fin, motif } = req.body || {}
  const d = cleJour(debut), f = cleJour(fin)
  if (!d || !f) return res.status(400).json({ error: 'Dates invalides' })
  // ⚠ ON NE CORRIGE PAS L'ORDRE EN SILENCE. Inverser pour l'hote ferait
  // enregistrer une plage qu'il n'a pas demandee — il croirait avoir pose un
  // conge d'un jour et en aurait pose un de trois semaines.
  if (d > f) return res.status(400).json({ error: 'La date de fin précède la date de début' })
  // Le plafond protege la lecture autant que la saisie : une plage de dix ans
  // verrouillerait tout le calendrier sans qu'on voie ou elle commence.
  const jours = Math.round((Date.parse(f + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / 86400000) + 1
  if (jours > HORIZON_JOURS) {
    return res.status(400).json({ error: `Un congé ne peut pas dépasser ${HORIZON_JOURS} jours` })
  }

  // ⚠ UN CONGE ENTIEREMENT PASSE S'ECRIRAIT SANS JAMAIS POUVOIR SE RELIRE.
  // `lire()` borne sur `gte('fin', jourMoins(30))` : une plage terminee avant
  // J-30 est inseree avec succes, n'apparait dans aucune reponse, et son `id`
  // devient introuvable — donc `retirerConge` est inatteignable depuis l'ecran.
  // Une ligne indelebile, creee par un geste qui annonce « enregistre ».
  // Le chemin prestataire avait deja cette garde ; celui-ci ne l'avait pas.
  if (f < jourMoins(30)) {
    return res.status(400).json({ error: 'Ces dates sont trop anciennes pour être enregistrées' })
  }

  // ⚠ ET LA DISTANCE, PAS SEULEMENT LA DUREE. `HORIZON_JOURS` bornait la LONGUEUR
  // de la plage : un conge de cinq jours en 2099 passait, alors que le
  // commentaire de cette constante annonce « l'ecran regle jusqu'a un an devant ».
  // Une plage hors de portee de l'ecran est une ligne qu'on ne pourra ni voir ni
  // retirer — le meme defaut que ci-dessus, par l'autre bout.
  if (d > jourPlus(HORIZON_JOURS)) {
    return res.status(400).json({ error: 'Ce congé est trop loin dans le futur' })
  }

  const { data, error } = await supabase.from('conges_plages')
    .insert({ user_id: userId, provider_id: providerId, debut: d, fin: f,
              motif: motif ? String(motif).slice(0, 200) : null, source: 'hote' })
    .select('id, debut, fin, motif, source')
    .maybeSingle()
  if (error) {
    console.error('[disponibilites] insert conge echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  return res.status(200).json({ success: true, conge: data })
}

// ⚠ UN CONGE SE SUPPRIME, il ne se desactive pas — contrairement a une REGLE.
// Une regle supprimee emporterait la raison pour laquelle des menages passes ont
// ete attribues comme ils l'ont ete ; un conge, lui, ne decide de rien
// retroactivement : il rend simplement ses jours a la recurrence.
async function retirerConge (req, res, userId, providerId) {
  const { id } = req.body || {}
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: 'Congé inconnu' })
  // ⚠ Les trois filtres comptent : l'identifiant vient du CLIENT, et sans
  // `user_id` + `provider_id` il designerait le conge de n'importe qui.
  const { data, error } = await supabase.from('conges_plages')
    .delete()
    .eq('id', String(id)).eq('user_id', userId).eq('provider_id', providerId)
    .select('id')
  if (error) {
    console.error('[disponibilites] suppression conge echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  if (!data || !data.length) return res.status(404).json({ error: 'Congé introuvable' })
  return res.status(200).json({ success: true })
}

// Le libelle lisible, construit UNE FOIS a l'ecriture et stocke : l'ecran ne
// doit jamais avoir a relire une RRULE pour dire ce qu'elle veut dire.

// ⚠ REEXPORTE, PAS REDEFINI. Des tests et des scripts l'importent d'ici ; la
// definition, elle, vit dans `lib/cleaning/regles.js` avec le reste de la regle.
module.exports.libelle = libelle
