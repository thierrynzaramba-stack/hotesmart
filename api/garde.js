// api/garde.js — QUI EST DE GARDE, JOUR PAR JOUR (lot 3.4).
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// L'ecran « Planning de garde » (apps/menages/garde.html) : pour chaque jour et
// chaque bien, qui porte, qui remplace, et le menage pose dessus s'il y en a un.
//
// ⚠ LA GARDE EST CALCULEE ICI, JAMAIS STOCKEE (§12.2). Cet endpoint appelle
// `planningDeGarde` — la meme brique pure que le moteur d'assignation. Recopier
// sa regle cote ecran, c'etait garantir que les deux divergent : l'hote aurait
// lu un planning qui ne dit pas ce que le cron fait.
//
// ⚠ POURQUOI UN ENDPOINT SEPARE de `/api/menages`. Celui-la porte deja les
// biens, les reservations, les menages, l'annuaire et les liaisons ; y greffer le
// calcul de garde en aurait fait le point de contention de toute l'app, alors
// qu'un seul ecran en a besoin.
//
// DROITS — deux niveaux, et ils ne recouvrent pas la meme chose :
//   `menages: read`      -> voir la couverture (qui est couvert, ou il manque
//                           quelqu'un). C'est la garde d'entree.
//   `prestataires: read` -> voir les PRENOMS. Sans ce droit, l'ecran dit
//                           « quelqu'un » / « personne » : un proprietaire
//                           delegue voit que son bien est couvert, sans
//                           l'identite du personnel de menage.
//   `avis: read`         -> le RETOUR DE PROPRETE DU SEJOUR, sur les menages
//                           deja passes dont l'avis est rattache. Il vient des
//                           avis voyageurs, qui ont leur propre domaine.
//
// ⚠ AUCUN COMPTEUR GLOBAL DE PERSONNE ICI (decision du product owner,
// 4 septembre 2026). Les pouces d'une prestataire — son ratio de proprete —
// avaient ete poses a cote de son prenom : c'est la fiche QUALITE d'une
// personne, pas l'ecran des menages. Ils vivent sur /avis et dans sa PWA. Ce
// qu'on montre ici est attache a UN MENAGE : ce que le voyageur a dit de CE
// sejour-la, une fois qu'il est passe.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, verifierSession } = require('../lib/require-permission')
const { refsDuPerimetre, filtrePerimetreSql, peutLire } = require('../lib/permissions')
const { planningDeGarde } = require('../lib/cleaning/garde')
const { chargerLiaisons, chargerDisponibilites,
        dansLaFenetreDeProposition } = require('../lib/cleaning/assign')
const { extraitVerifie } = require('../lib/extrait-verifie')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ FENETRE BORNEE A 92 JOURS — le meme plafond que `planningDeGarde`, et pour
// la meme raison : il fait tourner la recurrence RRULE par (personne, jour), et
// une fenetre d'un an demandee par une URL bricolee ferait des dizaines de
// milliers d'evaluations pour un ecran que personne ne regarde.
// L'ecran propose 1 mois et 3 mois : au-dela, une garde n'a plus de sens — les
// regles de disponibilite auront change avant.
const MAX_JOURS = 92
const LOT_MENAGES = 500
const LOT_BIENS = 200

const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/

// ⚠ « PRIVE DES QU'IL N'EST PAS CERTAINEMENT PUBLIC » — meme regle, meme raison
// et meme code que `api/menages-public.js`. Un `content_private.includes(...)`
// ratait un cas reel : un extrait qui commence dans le public et finit dans le
// prive n'etait retrouve dans aucun des deux, et sortait comme public.
function extraitEstPrive (a) {
  const extrait = a && a.ai_clean_excerpt
  if (!extrait) return false
  if (!a.content_private) return false
  if (extraitVerifie(a.content_private, extrait)) return true
  if (a.content_public && extraitVerifie(a.content_public, extrait)) return false
  return true
}

// ⚠ « PASSE » SE JUGE EN HEURE DE PARIS. En UTC, entre minuit et 2 h du matin
// l'ete, le depart du jour compte encore pour demain : on afficherait un retour
// sur un sejour qui, pour l'hote, n'est pas termine.
function todayEnParis () {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
}

// Les jours de la fenetre, bornes comprises. ⚠ A MIDI UTC : ajouter 24 h a un
// minuit local traverse un changement d'heure et rend deux fois le meme jour.
function joursEntre (du, au) {
  const d = Date.parse(`${du}T12:00:00Z`)
  const f = Date.parse(`${au}T12:00:00Z`)
  if (Number.isNaN(d) || Number.isNaN(f) || f < d) return null
  const jours = []
  for (let t = d; t <= f; t += 86400000) {
    jours.push(new Date(t).toISOString().slice(0, 10))
    if (jours.length > MAX_JOURS) return null
  }
  return jours
}

module.exports = async function handler (req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' })

  const appelant = await verifierSession(req, res)
  if (!appelant) return

  const garde = await requirePermission(req, res, {
    domaine: 'menages', niveau: 'read', userId: appelant, compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId

  const du = String(req.query.du || '')
  const au = String(req.query.au || '')
  if (!JOUR_RE.test(du) || !JOUR_RE.test(au)) {
    return res.status(400).json({ error: 'Fenêtre invalide' })
  }
  const jours = joursEntre(du, au)
  // ⚠ On REFUSE plutot que de tronquer : un ecran qui affiche six jours sur sept
  // sans le dire laisse croire que le septieme n'a pas de menage.
  if (!jours) return res.status(400).json({ error: `Fenêtre invalide (max ${MAX_JOURS} jours)` })

  // Les prenoms sont un droit A PART : voir la couverture n'est pas voir qui
  // compose l'equipe.
  const avecNoms = peutLire(garde.contexte, 'prestataires', null)
  const avecAvis = peutLire(garde.contexte, 'avis', null)

  try {
    // ===== LES BIENS DU PERIMETRE =====
    const filtreRef = filtrePerimetreSql(refsDuPerimetre(garde.contexte), 'provider_property_id')
    if (filtreRef === '') return res.status(200).json({ jours, biens: [], garde: [], menages: [] })

    let qProps = supabase.from('properties')
      .select('provider_property_id, name')
      .eq('user_id', userId).not('provider_property_id', 'is', null)
    if (filtreRef) qProps = qProps.or(filtreRef)
    const { data: propRows, error: errProps } = await qProps
      .order('name', { ascending: true }).limit(LOT_BIENS)
    if (errProps) {
      console.error('[garde] lecture biens echec', errProps.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    const biens = (propRows || []).map(p => ({
      id: String(p.provider_property_id), name: p.name || `Bien ${p.provider_property_id}`
    }))
    // ⚠ UNE TRONCATURE SE DIT. Elle efface precisement ce que cet ecran existe
    // pour montrer : un menage hors du lot rend son jour « sans menage », donc
    // gris au lieu de rouge — l'alerte devient un silence.
    const tronqueBiens = (propRows || []).length >= LOT_BIENS
    if (!biens.length) return res.status(200).json({ jours, biens: [], garde: [], menages: [] })

    // ===== LE CONTEXTE DE GARDE =====
    // ⚠ UNE PANNE COUPE. Rendre une garde calculee sur des liaisons ou des
    // disponibilites partielles afficherait « personne » sur des jours couverts —
    // ou l'inverse, quelqu'un qui est en conge. Un ecran faux est pire qu'un
    // ecran en panne : celui-la, on le rouvre.
    let liaisonsParBien, dispos
    try {
      liaisonsParBien = await chargerLiaisons(supabase,
        biens.map(b => ({ userId, propertyId: b.id })))
      dispos = await chargerDisponibilites(supabase, [userId], { du, au })
    } catch (e) {
      console.error('[garde]', e.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }

    const planning = planningDeGarde({
      du, au,
      biens: biens.map(b => ({
        userId, propertyId: b.id,
        liaisons: liaisonsParBien.get(`${userId}|${b.id}`) || [],
        regles: dispos.regles, exceptions: dispos.exceptions
      }))
    })

    // ===== LES MENAGES POSES DESSUS =====
    const { data: menagesRows, error: errMen } = await supabase.from('menages')
      .select('property_id, booking_id, departure_date, status, provider_id, offered_to, offer_expires_at, assignment_reason')
      .eq('user_id', userId)
      .in('property_id', biens.map(b => b.id))
      .gte('departure_date', du).lte('departure_date', au)
      // ⚠ Un menage ANNULE n'a plus d'objet : l'afficher ferait chercher a l'hote
      // une reservation qui n'existe plus.
      .neq('status', 'cancelled')
      .order('departure_date', { ascending: true })
      .limit(LOT_MENAGES)
    if (errMen) {
      console.error('[garde] lecture menages echec', errMen.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }

    // ===== L'ANNUAIRE, ET LES POUCES =====
    const prenoms = {}
    if (avecNoms) {
      const { data: pr, error: errPr } = await supabase.from('profiles')
        .select('id, first_name, active')
        .eq('account_user_id', userId).eq('access_mode', 'lien')
      // ⚠ Une panne ici ne coupe PAS l'ecran : sans prenoms, il reste juste et
      // lisible (« quelqu'un »). C'est la difference avec les liaisons, dont
      // l'absence rendrait la garde FAUSSE.
      if (errPr) console.error('[garde] lecture annuaire echec', errPr.message)
      for (const p of (pr || [])) prenoms[p.id] = { prenom: p.first_name, actif: p.active !== false }

    }

    // ===== LE RETOUR DE PROPRETE DU SEJOUR =====
    //
    // ⚠ ATTACHE A UN MENAGE, PAS A UNE PERSONNE. C'est ce que le voyageur a dit
    // de CE sejour-la — le seul retour qui aide a lire un planning.
    //
    // ⚠ SEULEMENT SUR UN MENAGE PASSE. Un avis ne peut pas concerner un sejour
    // qui n'a pas eu lieu : afficher quoi que ce soit sur un depart a venir
    // serait au mieux un avis d'un AUTRE sejour du meme bien, au pire un
    // rattachement faux qu'on presenterait comme un fait.
    //
    // ⚠ RATTACHEMENT PAR LE COUPLE (bien, reservation), avec le compte en tete :
    // ni `booking_uid` ni `property_id_ref` n'ont d'unicite globale (REVIEW.md
    // regle 1). Le rapprochement final se fait sur les DEUX, jamais sur le seul
    // booking.
    const avisParMenage = {}
    const passes = (menagesRows || []).filter(m => m.departure_date < todayEnParis())
    if (avecAvis && avecNoms && passes.length) {
      const { data: avis, error: errAvis } = await supabase.from('ota_reviews')
        // ⚠ NI `guest_name`, NI `content`, NI `raw`. `content_private` et
        // `content_public` servent UNIQUEMENT a decider de l'etiquette, ici, cote
        // serveur : ils ne partent jamais au front. C'est la meme regle que la
        // PWA prestataire.
        .select('booking_uid, property_id_ref, ai_clean_verdict, ai_clean_excerpt, content_private, content_public, verdict_source')
        .eq('user_id', userId)
        // ⚠ `statut = 'confirme'` : c'est la VALIDATION HUMAINE. Une detection en
        // attente n'est pas un fait, et l'afficher sur un planning en ferait un.
        .eq('statut', 'confirme')
        .in('property_id_ref', [...new Set(passes.map(m => String(m.property_id)))])
        .in('booking_uid', [...new Set(passes.map(m => String(m.booking_id)))])
        .limit(LOT_MENAGES)
      if (errAvis) {
        // ⚠ Ne COUPE PAS l'ecran : sans retour, le planning reste juste. C'est la
        // difference avec les liaisons, dont l'absence rendrait la garde FAUSSE.
        console.error('[garde] lecture des avis echec', errAvis.message)
      }
      for (const a of (avis || [])) {
        // ⚠ « rien_signale » et un verdict absent ne s'affichent PAS : un menage
        // sans retour n'affiche rien du tout — pas de « pas encore d'avis », qui
        // remplirait l'ecran de vide et ferait douter d'un travail correct.
        if (a.ai_clean_verdict !== 'positif' && a.ai_clean_verdict !== 'remarque') continue
        const cle = `${String(a.property_id_ref)}|${String(a.booking_uid)}`
        // ⚠ DEUX AVIS PEUVENT PORTER SUR LE MEME SEJOUR : un avis OTA et une
        // detection dans les messages entrants, tous deux confirmes. Ecraser sans
        // arbitrage laissait l'ordre de PostgREST decider — une « remarque »
        // pouvait etre remplacee par un « propreté saluée » d'un appel a l'autre.
        // La regle : une requalification HUMAINE prime (c'est une decision), et a
        // defaut la REMARQUE prime sur le compliment — on ne masque pas un
        // reproche par un eloge.
        const dejaLa = avisParMenage[cle]
        if (dejaLa) {
          const prime = (a.verdict_source === 'humain' && !dejaLa.humain) ||
                        (a.ai_clean_verdict === 'remarque' && dejaLa.verdict !== 'remarque' &&
                         !dejaLa.humain)
          if (!prime) continue
        }
        avisParMenage[cle] = {
          verdict: a.ai_clean_verdict,
          extrait: a.ai_clean_excerpt || null,
          // ⚠ « RETOUR PRIVE » DES QU'IL N'EST PAS CERTAINEMENT PUBLIC. Un extrait
          // a cheval entre le public et le prive sortait sinon comme public, et
          // l'hote lisait sur son planning une phrase que le voyageur n'avait pas
          // rendue publique. Meme regle et meme fonction que la PWA.
          prive: extraitEstPrive(a),
          // Une requalification humaine se voit : l'hote doit savoir qu'il lit sa
          // propre correction, pas le verdict de la machine.
          humain: a.verdict_source === 'humain'
        }
      }
    }

    // ===== LA REPONSE =====
    // ⚠ L'ECRAN NE RECOIT QUE CE QU'IL AFFICHE. Les identifiants de prestataires
    // sortent (l'ecran doit rapprocher garde et menages), mais aucune coordonnee,
    // aucun nom de voyageur, aucun extrait d'avis.
    // ⚠ `aRegler` : cette personne est de garde, mais le moteur ne la sollicitera
    // JAMAIS — elle doit confirmer et aucun jour ne lui est confié sur ce bien
    // (restriction du §12.9c). Sans ce drapeau, l'écran affichait « Marie est de
    // garde » juste au-dessus de « ménage — personne » : deux affirmations
    // contradictoires, et aucun indice que le problème est un réglage de jours.
    const aRegler = c => !!(c && c.requiresAck === true &&
                            !(Array.isArray(c.weekdays) && c.weekdays.length))

    const nommer = (id, candidate) => {
      if (!id) return null
      const base = { a_regler: aRegler(candidate) }
      // ⚠ SANS `prestataires: read`, PAS MEME L'IDENTIFIANT. L'ecran ne s'en sert
      // pas, et rendu jour par jour et bien par bien, un UUID stable suffit a
      // reconstituer le calendrier de presence et d'absence du personnel de
      // l'hote — c'est-a-dire exactement ce que `api/disponibilites.js` refuse a
      // `menages: read`. Un identifiant est une identite quand il est constant.
      if (!avecNoms) return { ...base, prenom: null }
      const p = prenoms[id]
      return { ...base, id, prenom: p ? p.prenom : null, actif: p ? p.actif : null }
    }

    const gardeParBien = planning.biens.map(b => {
      // ⚠ « CE BIEN N'EST PAS GERE » N'EST PAS « PERSONNE CE JOUR-LA ».
      // `deciderParGarde` sépare les deux depuis le lot 3.3, et le moteur
      // n'alerte QUE sur le second : un hôte qui fait son ménage lui-même, ou qui
      // n'a confié qu'un logement sur trois, verrait sinon un écran entièrement
      // rouge — le bruit permanent que la décision du 3 septembre écarte. Sans
      // cette information, l'écran contredisait le moteur.
      const gere = (liaisonsParBien.get(`${userId}|${b.propertyId}`) || []).length > 0
      return {
        propertyId: b.propertyId,
        gere,
        jours: b.jours.map(j => ({
          date: j.date,
          responsable: nommer(j.responsable && j.responsable.providerId,
                              j.responsable),
          remplacante: nommer(j.remplacante && j.remplacante.providerId,
                              j.remplacante),
          trou: j.trou
        }))
      }
    })

    // Qui est de garde, indexe par (bien, jour) : sert a distinguer un menage
    // qui attend sa proposition d'un menage que personne ne peut prendre.
    const responsableDuJour = {}
    for (const b of planning.biens) {
      for (const j of b.jours) {
        if (j.responsable) responsableDuJour[`${b.propertyId}|${j.date}`] = true
      }
    }

    const menages = (menagesRows || []).map(m => ({
      propertyId: String(m.property_id),
      bookingId: String(m.booking_id),
      date: m.departure_date,
      status: m.status,
      porteur: nommer(m.provider_id),
      proposeA: nommer(m.offered_to),
      expireLe: m.offered_to ? m.offer_expires_at : null,
      // ⚠ LA RAISON PORTE DES PRENOMS, et elle contournait donc la garde
      // `prestataires: read` : `assignment_reason` vaut « Refuse par Marie… »,
      // « reste chez Regina », « Propose a Marie par l'hote ». Rendue sans
      // condition, elle affichait a un proprietaire delegue exactement ce que
      // `nommer()` venait de lui masquer.
      // Sans le droit, le STATUT suffit : `orphaned` dit « refusé », et c'est
      // l'information qui commande une action.
      raison: avecNoms ? (m.assignment_reason || null) : null,
      // ⚠ ABSENT quand il n'y a rien à dire : un ménage sans retour n'affiche
      // rien, et surtout pas « pas encore d'avis ».
      retour: avisParMenage[`${String(m.property_id)}|${String(m.booking_id)}`] || null,
      // ⚠ « PERSONNE » ET « PAS ENCORE PROPOSE » NE SONT PAS LA MEME CHOSE.
      // Au-dela de la fenetre de proposition (§12.9b), un menage dont la
      // responsable doit confirmer reste `unassigned` SANS offre : le moteur dit
      // explicitement qu'il n'y a rien a signaler, la proposition partira quand
      // le depart approchera. L'ecran, lui, le peignait en rouge « ⚠ personne »
      // juste sous la pastille violette de sa responsable — deux affirmations
      // contradictoires, et un clic sur « semaine suivante » suffisait a rougir
      // tout l'ecran d'un compte dont personne n'est d'office.
      // ⚠ ET SEULEMENT DANS LE FUTUR. `dansLaFenetreDeProposition` est bornee des
      // DEUX cotes : un depart vieux de deux jours en sort aussi, et le menage
      // se decrivait alors « proposition a venir — le depart est encore loin »,
      // pour un depart PASSE que personne n'a fait. Depuis que la grille montre
      // les sept jours ecoulés, le cas n'est plus rare : il est garanti. Un
      // menage passe sans personne est exactement ce que l'hote doit voir.
      differe: !m.provider_id && !m.offered_to &&
               m.departure_date >= todayEnParis() &&
               !dansLaFenetreDeProposition(m.departure_date) &&
               !!(responsableDuJour[`${String(m.property_id)}|${m.departure_date}`])
    }))

    return res.status(200).json({
      jours, biens, garde: gardeParBien, menages,
      avec_noms: avecNoms,
      // ⚠ `avec_avis` DIT CE QUI SORT, pas ce que le droit autorise. Le retour de
      // propreté est une parole de voyageur rapportée à côté d'un nom : sans
      // `prestataires: read`, l'écran n'a personne à qui la rattacher, et la
      // montrer serait exposer un reproche sans dire à qui il se rapporte.
      avec_avis: avecNoms && avecAvis,
      // L'ecran le DIT a l'hote : mieux vaut « liste incomplete » qu'un jour
      // paisible qui cache un menage sans personne.
      tronque: tronqueBiens || (menagesRows || []).length >= LOT_MENAGES,
      // Les trous BRUTS, tels que la brique les rend — y compris les jours sans
      // ménage. L'écran ne met en rouge que ceux qui portent un ménage (§12.6),
      // mais il doit pouvoir montrer les autres en gris : c'est ce qui permet de
      // voir venir.
      trous: planning.trous
    })
  } catch (err) {
    console.error('[garde] erreur', err.message)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
