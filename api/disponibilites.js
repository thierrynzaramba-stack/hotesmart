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
const { lireRrule, cleJour, estDisponible, congeCouvrant } = require('../lib/cleaning/availability')
const { apresChangementDeRegles } = require('../lib/cleaning/apres-changement-regles')
// ⚠ LA REGLE RECURRENTE EST VALIDEE EN UN SEUL ENDROIT, partage avec la PWA
// (`api/menages-public.js`) depuis le 15 septembre 2026.
const { validerRegle, libelle, remplacerRegles,
        MAX_REGLES_ACTIVES } = require('../lib/cleaning/regles')

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

  if (lecture) {
    // ⚠ LE MOIS EST VALIDE ICI, et il est le SEUL parametre de fenetre : un
    // `mois=` libre ferait calculer des annees de calendrier pour rien.
    // ⚠ LE MOIS EST BORNE A 01-12 (constat de la revue de ac28b1f) : `2026-13`
    // passait le motif, produisait une date invalide, et la boucle du
    // calendrier ne tournait pas — 200 avec `jours: []`, que l'ecran lisait
    // comme « elle n'a aucun jour ». Un mois illisible retombe sur le mois
    // courant, comme avant, mais il ne fabrique plus un calendrier vide.
    const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.mois || '')) ? String(req.query.mois) : null
    return await lire(res, userId, providerId, m)
  }
  return await ecrire(req, res, userId, providerId, appelant)
}

// ─── LECTURE ────────────────────────────────────────────────────────────────
//
// Rend les regles telles que l'ECRAN les manipule — des jours et une cadence —
// pas la chaine RRULE. `label` porte le libelle construit a l'ecriture ; la
// chaine elle-meme ne sort jamais.
async function lire (res, userId, providerId, moisDemande = null) {
  const { data: regles, error: errR } = await supabase.from('provider_availability_rules')
    // ⚠ `rrule` EST LUE ICI, ET NE SORT PAS D'ICI. L'ecran a besoin des JOURS et
    // de la CADENCE pour recocher ses cases — pas de la chaine, qui reste une
    // affaire de serveur (§2 de la spec). On la relit, on en extrait la forme,
    // et on jette la chaine avant de repondre.
    .select('id, label, active, created_at, rrule, source')
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
    // ⚠ `created_at` SORT AUSSI : la fiche en fait une trace lisible, comme
    // pour les regles. « Reglé par vous le … » a cote de « Reglé par elle
    // le … » — meme en-tete, deux sources. L'hote qui decouvre une absence
    // doit pouvoir dire si elle vient d'elle ou de son propre geste.
    .select('id, date, available, reason, source, created_at')
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
      // ⚠ QUI L'A POSEE. La fiche en fait une trace lisible (« jours modifies
      // par elle le … ») : une notification se rate — SMS non lu, e-mail
      // classe — mais la trace reste. L'hote qui decouvre un trou de garde dans
      // trois semaines doit pouvoir remonter a la cause sans dependre d'un
      // message qu'il n'a plus.
      // ⚠ `|| 'hote'` : le seul writer d'avant ce lot etait l'hote, et une
      // valeur absente ne doit pas se lire « elle ».
      source: r.source || 'hote',
      jours: forme ? forme.jours : null,
      cadence: forme ? forme.cadence : null,
      ancre: forme ? forme.ancre : null
    }
  })

  // ⚠ CE QU'ELLE VOIT DES AUTRES (2 octobre 2026, spec visibilite). Absence de
  // ligne = rien, comme avant. Une panne de lecture coupe (503) : afficher
  // « elle ne voit rien » sur une panne ferait croire a l'hote qu'il peut
  // cocher une case deja cochee — ou l'inverse.
  const { data: vis, error: errV } = await supabase.from('menage_visibilite')
    .select('par_bien, profils_vus, updated_at, updated_by')
    .eq('user_id', userId).eq('profile_id', providerId).maybeSingle()
  if (errV) {
    console.error('[disponibilites] lecture visibilite echec', errV.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  // QUI a regle (demande de Thierry, 2 octobre 2026) : « Reglé le … par [nom] ».
  // Le titulaire comme le delegue ont un profil de CE compte dont
  // `member_user_id` est leur identifiant de session. Une panne ici ne coupe
  // rien : on dit la date sans le nom.
  let reglePar = null
  if (vis && vis.updated_by) {
    const { data: qui } = await supabase.from('profiles')
      .select('first_name, last_name')
      .eq('account_user_id', userId).eq('member_user_id', String(vis.updated_by)).maybeSingle()
    if (qui) reglePar = [qui.first_name, qui.last_name].filter(Boolean).join(' ').trim() || null
  }

  // ─── LE CALENDRIER, CALCULE PAR LE MOTEUR LUI-MEME ────────────────────────
  //
  // ⚠ LA REGLE DE PRECEDENCE NE SE RECOPIE PAS DANS UN NAVIGATEUR. Conge >
  // exception > regle > « aucune regle = disponible », plus « une regle
  // illisible rend INDISPONIBLE » : c'est `estDisponible` de
  // `lib/cleaning/availability.js` — le MEME code que celui qui decide a qui
  // un menage est attribue. Une seconde implementation cote ecran divergerait
  // le jour ou le moteur change, et l'hote lirait un calendrier qui n'est pas
  // celui du moteur.
  //
  // ⚠ ON NE REND QUE DEUX MOIS, a partir du premier du mois demande : c'est ce
  // que la fenetre de configuration affiche. Le client ne choisit pas une
  // fenetre arbitraire — un `mois=` libre ferait calculer des annees pour rien.
  const debutCal = moisDemande ? `${moisDemande}-01` : `${cleJour(new Date()).slice(0, 7)}-01`
  const jours = []
  {
    const d = new Date(debutCal + 'T12:00:00Z')
    const fin = new Date(d); fin.setUTCMonth(fin.getUTCMonth() + 2)
    const ctx = { regles: regles || [], exceptions: exceptions || [], conges: conges || [] }
    while (d < fin) {
      const iso = d.toISOString().slice(0, 10)
      const conge = congeCouvrant(iso, conges || [])
      const exc = (exceptions || []).find(e => cleJour(e.date) === iso)
      const dispo = estDisponible(iso, ctx)
      jours.push({
        date: iso,
        dispo,
        // ⚠ CE QUE LE JOUR VAUDRAIT SI ON RETIRAIT SON EXCEPTION, calcule par
        // le MEME `estDisponible`. C'est ce qui permet a l'ecran de choisir
        // entre RETIRER l'exception et en poser une contraire, sans recopier
        // la regle de precedence dans un navigateur.
        //
        // ⚠ ET CE N'EST PAS UN CONFORT. Sans lui, un clic pose toujours une
        // exception : basculer un jour puis le rebasculer laissait une
        // exception redondante — un jour fige que plus rien n'explique, et qui
        // survit au retrait de la recurrence. C'est le defaut que l'ancien
        // ecran evitait en recalculant la precedence cote client.
        //
        // Les conges comptent : ils priment sur tout, exception comprise. Un
        // jour sous conge vaut donc `false` ici aussi — l'ecran le laisse
        // inerte, et c'est la verite du moteur.
        sans_exception: exc ? estDisponible(iso, { ...ctx, exceptions: [] }) : dispo,
        // CE QUI a tranche, pour la legende : un conge se verrouille, une
        // exception porte un point (« regle a la main »), une regle n'a pas
        // besoin d'etre dite.
        conge: conge ? { motif: conge.motif || null, source: conge.source || 'hote' } : null,
        // ⚠ L'IDENTIFIANT SORT : c'est par lui que l'ecran la retire
        // (`retirerException` n'accepte qu'un id). Sans lui, le second clic ne
        // pouvait que poser une exception contraire.
        exception: exc ? { id: exc.id, source: exc.source || 'hote', created_at: exc.created_at || null } : null
      })
      d.setUTCDate(d.getUTCDate() + 1)
    }
  }

  return res.status(200).json({
    mois: debutCal.slice(0, 7),
    jours,
    regles: reglesLisibles,
    exceptions: exceptions || [],
    conges: conges || [],
    visibilite: vis
      ? { par_bien: vis.par_bien === true, profils_vus: vis.profils_vus || [], regle_le: vis.updated_at,
          regle_par: reglePar }
      : { par_bien: false, profils_vus: [], regle_le: null, regle_par: null },
    // ⚠ Le compte se voit a l'ecran : c'est ce qui permet a l'hote de comprendre
    // « aucune regle = disponible » sans avoir a le deviner.
    aucune_regle: !reglesLisibles.some(r => r.active !== false)
  })
}

// ─── ECRITURE ───────────────────────────────────────────────────────────────
async function ecrire (req, res, userId, providerId, appelant) {
  const { action } = req.body || {}

  if (action === 'reglerVisibilite') return await reglerVisibilite(req, res, userId, providerId, appelant)
  if (action === 'reglerJours')     return await reglerJours(req, res, userId, providerId)
  if (action === 'poserRegle')      return await poserRegle(req, res, userId, providerId)
  if (action === 'retirerRegle')    return await retirerRegle(req, res, userId, providerId)
  if (action === 'poserException')  return await poserException(req, res, userId, providerId)
  if (action === 'retirerException') return await retirerException(req, res, userId, providerId)
  if (action === 'poserConge')      return await poserConge(req, res, userId, providerId)
  if (action === 'retirerConge')    return await retirerConge(req, res, userId, providerId)
  return res.status(400).json({ error: 'Action inconnue' })
}

// ─── CE QU'ELLE VOIT DES MENAGES DES AUTRES (2 octobre 2026) ───────────────
// Spec : docs/specs/spec-visibilite-menages-autrui.md. Deux portees qui se
// CUMULENT : `par_bien` (les biens dont elle recoit les propositions) et
// `profils_vus` (les prestataires designees). Rien sans ligne.
//
// ⚠ WRITER UNIQUE DE `menage_visibilite`, ET C'EST ICI, PAS DANS /api/membres.
// Un membre DELEGUE avec les droits menage doit pouvoir regler cette
// visibilite comme l'hote : la garde de ce fichier est le domaine
// `prestataires` (`compteDelegue: true`). `/api/membres` exige `equipe`.
//
// ⚠ REVIEW.md regle 11 : chaque profil designe se VERIFIE (profil `lien` de CE
// compte) — un identifiant venu du client ne s'utilise pas tel quel, sinon un
// hote ferait voir a sa prestataire les menages d'une personne d'un autre compte.
const PLAFOND_PROFILS_VUS = 20
async function reglerVisibilite (req, res, userId, providerId, appelant) {
  const { par_bien: parBien, profils_vus: brut } = req.body || {}
  if (typeof parBien !== 'boolean') return res.status(400).json({ error: 'Réglage invalide' })
  if (!Array.isArray(brut)) return res.status(400).json({ error: 'Réglage invalide' })
  const profils = [...new Set(brut.map(String))]
  if (profils.length > PLAFOND_PROFILS_VUS) return res.status(400).json({ error: 'Trop de prestataires désignées' })
  if (profils.some(id => !UUID_RE.test(id))) return res.status(400).json({ error: 'Prestataire inconnue' })
  if (profils.includes(String(providerId))) return res.status(400).json({ error: 'Elle voit déjà ses propres ménages' })

  if (profils.length) {
    const { data: connus, error: errP } = await supabase.from('profiles')
      .select('id')
      .in('id', profils)
      .eq('account_user_id', userId)
      .eq('access_mode', 'lien')
    if (errP) {
      console.error('[disponibilites] verification profils vus echec', errP.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if ((connus || []).length !== profils.length) return res.status(400).json({ error: 'Prestataire inconnue' })
  }

  const { data, error } = await supabase.from('menage_visibilite')
    .upsert({ user_id: userId, profile_id: providerId, par_bien: parBien, profils_vus: profils,
              updated_at: new Date().toISOString(), updated_by: appelant || null },
            { onConflict: 'user_id,profile_id' })
    .select('par_bien, profils_vus, updated_at')
    .maybeSingle()
  if (error) {
    console.error('[disponibilites] reglage visibilite echec', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  return res.status(200).json({ success: true,
    visibilite: { par_bien: data ? data.par_bien === true : parBien,
                  profils_vus: data ? data.profils_vus || [] : profils,
                  regle_le: data ? data.updated_at : null } })
}

// Une regle de RECURRENCE : « le week-end, une semaine sur deux ».
//
// ⚠ L'HOTE N'ECRIT JAMAIS DE RRULE. Il envoie des jours (0 = dimanche … 6),
// une cadence et une date d'ancrage ; `construireRrule` produit la chaine. Une
// chaine acceptee depuis le client serait une expression executee par la lib
// `rrule` sur des donnees d'un autre compte, et un `COUNT=100000` suffirait a
// faire tourner le moteur d'assignation pour rien a chaque cycle.
// TOUS SES JOURS HABITUELS EN UN SEUL ALLER-RETOUR (fiche V5, 16 octobre 2026).
//
// ⚠ POURQUOI CETTE ACTION EXISTE A COTE DE `poserRegle`. L'ancien ecran reglait
// la recurrence en N appels : un `retirerRegle` par regle active, puis un
// `poserRegle` par ligne. Le reseau qui lache au milieu — un telephone, un
// ascenseur — laissait ZERO regle active, c'est-a-dire « disponible tous les
// jours » : le moteur lui attribue alors des menages n'importe quel jour, et
// personne ne l'a demande. C'est l'inverse exact de ce que l'hote venait de
// faire, et rien a l'ecran ne le disait.
//
// L'ordre juste — inserer PUIS desactiver — vit dans `lib/cleaning/regles.js`,
// avec la PWA, parce que c'est une REGLE et non une mecanique d'ecran. Les deux
// endpoints l'appellent ; ils ne different que par leurs gardes et par la
// `source` ecrite en base.
//
// ⚠ `source: 'hote'` : c'est ce qui permet a sa page de distinguer ce qu'elle a
// regle elle-meme de ce que son hote a regle pour elle.
async function reglerJours (req, res, userId, providerId) {
  const lots = Array.isArray((req.body || {}).lots) ? req.body.lots : null
  if (!lots) return res.status(400).json({ error: 'Rien à enregistrer' })
  // Une ligne en semaine simple, deux en quinzaine : au-dela, c'est un corps
  // forge — l'ecran n'en produit jamais trois.
  if (lots.length > 2) return res.status(400).json({ error: 'Trop de lignes' })
  const cadence = Number((req.body || {}).toutes_les_n_semaines) || 1

  // ⚠ LA BORNE VIENT DU MODULE, PAS DE L'ECRAN. `LOT_REGLES` (200) est la
  // borne de LECTURE de cet endpoint : elle dit combien de regles on accepte
  // d'AFFICHER, pas combien on accepte d'en remplacer. Les confondre faisait
  // qu'une prestataire reglable ici etait refusee depuis sa page.
  const r = await remplacerRegles(supabase, {
    userId, providerId, lots, cadence, source: 'hote', maxActives: MAX_REGLES_ACTIVES })

  // ⚠ IL N'Y A PLUS D'ETAT INTERMEDIAIRE A ANNONCER. Tant que le remplacement
  // se faisait en deux ecritures, cette branche disait « les nouveaux jours
  // sont enregistres, mais les anciens n'ont pas pu etre retires » — une phrase
  // qui existait parce que le cas existait. La fonction Postgres est une
  // transaction : soit tout est pose, soit rien n'a bouge, et l'ecran n'a plus
  // qu'un seul refus a dire.
  if (r.erreur === 'rpc_absente') {
    console.error('[disponibilites] migration 2026-10-16-regles-atomiques NON APPLIQUEE', r.detail)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  // ⚠ LE PLAFOND N'EST PAS UNE PANNE, ET IL NE DOIT PAS SE LIRE COMME UNE PANNE
  // (demande de Thierry, 16 octobre 2026 : « un message clair a l'ecran, jamais
  // un echec silencieux »). « Service temporairement indisponible » ferait
  // reessayer indefiniment un geste qui echouera toujours. On dit le nombre,
  // la borne, et quoi faire.
  if (r.erreur === 'plafond') {
    console.error('[disponibilites] plafond de regles actives atteint', r.detail || '')
    // ⚠ UN CODE ET UN MAXIMUM, PAS UNE PHRASE (16 octobre 2026). La fiche est
    // traduite (fr/en/es) : lui envoyer du francais en dur rendrait l'ecran
    // bilingue au premier refus. `error` reste en repli, pour les chemins qui
    // affichent la phrase du serveur telle quelle.
    return res.status(409).json({
      code: 'trop_de_regles', max: MAX_REGLES_ACTIVES,
      error: `Ses jours habituels n'ont pas pu être remplacés : elle a plus de ` +
             `${MAX_REGLES_ACTIVES} règles de récurrence actives. ` +
             `Prévenez-nous, il faut en retirer avant.` })
  }
  if (r.erreur) {
    if (r.status === 400) return res.status(400).json({ error: r.erreur })
    console.error('[disponibilites] reglage des jours echec', r.erreur, r.detail || '')
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  // ⚠ LES MENAGES DEJA PROPOSES SUR LES JOURS RETIRES REVIENNENT AU MOTEUR
  // (constat de la revue de 70f805d). Ce rattrapage existait pour la PWA
  // seulement : quand la prestataire se retirait du samedi, les propositions
  // du samedi lui etaient reprises. L'hote remplace desormais les memes jours
  // depuis la fiche, et c'est devenu le chemin le plus frequent — sans ce
  // bloc, il retirait le samedi et une proposition du samedi suivant restait
  // chez quelqu'un dont il venait de dire qu'elle ne vient plus ce jour-la.
  //
  // ⚠ ON REPREND, MAIS ON N'ANNONCE PAS. L'alerte dit a l'hote ce que la
  // prestataire a change ; la lui envoyer apres SON PROPRE geste serait a la
  // fois faux et bruyant. La raison ecrite sur le menage, elle, nomme le bon
  // auteur.
  //
  // ⚠ ET ON L'ATTEND, comme sa page : une fonction serverless qui a repondu
  // peut etre gelee avant d'avoir fini son travail de fond.
  const prenom = await prenomDuProfil(userId, providerId)
  await apresChangementDeRegles({
    userId, providerId, prenom,
    avant: (r.avant || []).map(x => lireRrule(x.rrule)).filter(Boolean),
    apres: r.formes,
    annoncer: false,
    raison: 'Ce jour a ete retire de ses jours habituels depuis sa fiche : ' +
            'proposition reprise, a reattribuer.'
  })
  return res.status(200).json({ success: true, poses: r.poses })
}

// Le prenom sert aux phrases du rattrapage. ⚠ IL NE FAIT PAS ECHOUER LE GESTE :
// les jours sont deja enregistres quand on arrive ici.
async function prenomDuProfil (userId, providerId) {
  const { data, error } = await supabase.from('profiles')
    .select('first_name').eq('id', providerId).eq('account_user_id', userId).maybeSingle()
  if (error || !data) return null
  return data.first_name || null
}

async function poserRegle (req, res, userId, providerId) {
  // ⚠ LA VALIDATION VIT DANS `lib/cleaning/regles.js`, PARTAGEE AVEC LA PWA.
  // Depuis le 15 septembre 2026, la prestataire regle aussi ses jours depuis
  // `api/menages-public.js` : recopier la validation ici aurait produit deux
  // regles pour la meme chose, et la copie finit toujours par etre la plus
  // permissive des deux.
  const v = validerRegle(req.body || {})
  if (v.erreur) return res.status(400).json({ error: v.erreur })

  const { data, error } = await supabase.from('provider_availability_rules')
    // ⚠ `source: 'hote'` — ici c'est l'hote qui pose, depuis la fiche. C'est ce
    // qui permet a la fiche de distinguer ses propres reglages de ceux qu'elle a
    // faits depuis sa PWA.
    .insert({ user_id: userId, provider_id: providerId, rrule: v.rrule,
              label: v.label, active: true, source: 'hote' })
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

  // ⚠ LES MEMES DEUX BORNES QUE `poserConge`, ET POUR LA MEME RAISON.
  // `lire()` ne rend les exceptions que depuis `gte('date', jourMoins(30))` :
  // une exception posee plus tot est inseree avec succes, n'apparait dans aucune
  // reponse, son `id` n'est jamais rendu — et `retirerException`, qui n'accepte
  // qu'un id, devient inatteignable. Une ligne indelebile, creee par un geste
  // qui annonce « enregistre ». Par l'autre bout, une date hors de l'horizon de
  // l'ecran a le meme defaut.
  // ⚠ LA GARDE ETAIT COTE ECRAN SEULEMENT (un bouton `disabled` sur le passe),
  // et l'ecran borne en heure LOCALE du navigateur : un hote a UTC-8 a 18 h est
  // deja le lendemain a Paris. Le serveur, lui, borne en heure de Paris comme
  // tout ce domaine.
  if (jour < jourMoins(30)) {
    return res.status(400).json({ error: 'Cette date est trop ancienne pour être enregistrée' })
  }
  if (jour > jourPlus(HORIZON_JOURS)) {
    return res.status(400).json({ error: 'Cette date est trop loin dans le futur' })
  }

  // ⚠ UNE SEULE DECISION PAR PERSONNE ET PAR JOUR (contrainte SQL). L'upsert
  // remplace : reposer « pas ce samedi » sur un jour deja marque disponible doit
  // corriger, pas echouer — l'hote corrige ce que la prestataire a declare, et
  // c'est le sens meme de ce reglage.
  const { data, error } = await supabase.from('provider_availability_exceptions')
    // ⚠ `created_at` EST REPOSE A CHAQUE ECRITURE. La ligne porte UNE decision,
    // et la trace affiche sa date : sans cela, corriger aujourd'hui une absence
    // declaree par elle le 2 octobre faisait dire a l'ecran « regle par vous le
    // 2 octobre » — la source changeait, la date restait celle de l'autre.
    .upsert({ user_id: userId, provider_id: providerId, date: jour,
              available, reason: reason ? String(reason).slice(0, 200) : null,
              source: 'hote', created_at: new Date().toISOString() },
            { onConflict: 'provider_id,date' })
    .select('id, date, available, reason, source, created_at')
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
