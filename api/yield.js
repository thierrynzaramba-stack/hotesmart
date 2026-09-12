// api/yield.js — LE SOCLE DE LECTURE DE L'APP YIELDFLOW (etape 4, lot 4.1).
// Spec : docs/specs/spec-yieldflow-v1.md §6 et §7.
//
// GET /api/yield?property_id=<uuid>&debut=&fin=&granularite=&pivot=
//   -> realise (vs N-1), « a date » (pickup), reference par segment,
//      courbe de delai, projection — et LEURS DRAPEAUX.
//
// ⚠ AUCUN CALCUL ICI. Tout vient des cinq modules PURS de l'etape 3
// (`lib/yield/`). Cet endpoint ne fait que trois choses : garder l'acces,
// CHARGER la matiere depuis le coeur, et composer la reponse. Un chiffre
// calcule ici serait un chiffre non teste — les modules purs ont 100 tests,
// un handler serverless n'en a aucun.
//
// ⚠ AUCUNE LECTURE PROVIDER. Regle d'architecture du depot : provider → coeur
// → apps. Tout vient de `bookings_snapshot`, `calendar_inventory`,
// `yield_exceptions` et `school_holidays`.
//
// ⚠ LECTURE SEULE. Cet endpoint n'ecrit RIEN. La suggestion (lot 4.4) et
// l'application d'un prix (lot 4.6) passeront par le chemin normal du
// calendrier, jamais par ici.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { peutEcrire } = require('../lib/permissions')
const { eclater, construirePontDemapped } = require('../lib/yield/eclatement')
const {
  calculerIndicateurs, comparerAN1, clePeriode, periodePrecedente
} = require('../lib/yield/indicateurs')
const { joursOuverts, estJourISO, joursDeLaPeriode } = require('../lib/yield/capacite')
const { joursExclus, exceptionsDuBien } = require('../lib/yield/exceptions')
const { pickup } = require('../lib/yield/pickup')
const { lireVacances, couverture, etendueSource } = require('../lib/yield/vacances')
const R = require('../lib/yield/reference')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ BORNE DURE. Une fenetre libre laisserait un appelant demander dix ans par
// jour : `joursDeLaPeriode` refuserait, mais la lecture du snapshot et les
// 3 650 appels de capacite seraient deja partis.
const JOURS_MAX = 800

// ⚠ ET UNE BORNE SUR LE NOMBRE DE PERIODES — releve en review.
// `JOURS_MAX` bornait les JOURS, pas les PERIODES. Avec la granularite « jour »
// et la fenetre par defaut, l'historique de trois ans fait 1 461 periodes :
// 1 461 appels a `joursOuverts` (une requete chacun, pour UN seul jour), et une
// reponse de 1,2 Mo. Mesure en review. Sur la fenetre maximale : 1 896 appels
// et 2,6 Mo, soit plus de 300 allers-retours reseau — au-dela du temps
// d'execution d'une fonction. L'ecran restait sur « Lecture… » puis tombait.
const PERIODES_MAX = 200

// ⚠ ET UNE BORNE SUR LA LECTURE DU SNAPSHOT. La colonne `raw` porte le payload
// provider integral : un compte a 20 000 reservations chargerait des dizaines
// de Mo a chaque clic. On refuse plutot que de tronquer — une mesure calculee
// sur un historique ampute serait fausse sans que rien ne le dise.
const RESERVATIONS_MAX = 20000
// Profondeur de l'historique de reference — arbitrage de Thierry : 3 ans.
const ANS_REFERENCE = 3

function jourLocal (d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ⚠ LE 29 FEVRIER N'EXISTE PAS TOUS LES ANS — releve en review.
// L'arithmetique de chaine rendait `2021-02-29` pour un debut au 29 fevrier
// 2024. `joursDeLaPeriode` rend alors `[]` — pas `null` — donc les gardes qui
// testaient `!jours` laissaient passer, les capacites partaient vides, et le
// traitement ne s'arretait que plus loin sur un 500 opaque. Une date de debut
// parfaitement legitime mettait l'app en panne sans motif lisible.
// On replie sur le 28, comme partout ailleurs dans ce depot.
// Jour precedent, en UTC : sert au regroupement des evenements consecutifs.
function veille (iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function reculerAns (iso, n) {
  const [a, m, j] = iso.split('-')
  const candidat = `${Number(a) - n}-${m}-${j}`
  if (estJourISO(candidat)) return candidat
  const repli = `${Number(a) - n}-${m}-28`
  return estJourISO(repli) ? repli : null
}

// Toutes les cles de periode couvertes par une fenetre, pour la capacite.
// ⚠ LEVE PLUTOT QUE DE RENDRE UN TABLEAU VIDE. `joursDeLaPeriode` rend `null`
// au-dela de sa borne : un `return []` silencieux aurait donne des capacites
// vides, donc « capacite_non_calculable » partout — un ecran entier de
// « je ne sais pas » sans qu'aucune erreur ne dise pourquoi.
function clesDePeriode (debut, fin, granularite) {
  const jours = joursDeLaPeriode(debut, fin)
  // ⚠ `[]` AUTANT QUE `null` — releve en review. `joursDeLaPeriode` rend un
  // tableau VIDE sur une date invalide et `null` seulement hors borne :
  // tester `!jours` laissait passer le premier cas.
  if (!jours || !jours.length) throw new Error(`fenêtre hors borne : ${debut} → ${fin}`)
  return [...new Set(jours.map(j => clePeriode(j, granularite)))].sort()
}

// Bornes d'une cle de periode ('2026-10' -> 1er au 31 octobre).
function bornesDePeriode (cle) {
  if (/^\d{4}$/.test(cle)) return [`${cle}-01-01`, `${cle}-12-31`]
  if (/^\d{4}-\d{2}$/.test(cle)) {
    const [a, m] = cle.split('-').map(Number)
    return [`${cle}-01`, new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10)]
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(cle)) return [cle, cle]
  return null
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  const propertyId = String(req.query.property_id || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'property_id requis' })

  // ─── GARDE ────────────────────────────────────────────────────────────────
  // ⚠ `bienRequis: true` : la service key contourne RLS, donc l'endpoint est
  // la SEULE barriere. Sans bien resolu, la garde retomberait sur le compte de
  // l'appelant et servirait des chiffres qui ne sont pas les siens.
  // Domaine `reservations` en LECTURE : le realise, le portefeuille et les
  // prix vendus sont de la donnee de reservation. Ecrire un prix relevera de
  // `reglages` (lot 4.6), et ce choix sera tranche avec Thierry a ce moment-la
  // (spec §8), pas ici.
  const garde = await requirePermission(req, res, {
    domaine: 'reservations',
    niveau: 'read',
    bien: propertyId,
    bienRequis: true
  })
  if (!garde.ok) return

  const compte = garde.accountUserId

  try {
    // ⚠ LA GARDE NE REND QUE SIX COLONNES — ET C'EST LE DEFAUT DU
    // 11 SEPTEMBRE 2026, A L'IDENTIQUE. `resoudreBien` selectionne
    // `id, user_id, name, provider, provider_property_id,
    // migration_target_property_id` : tout le reste vaut `undefined`.
    //
    // Constate a la premiere lecture reelle de cet endpoint, et les degats
    // etaient invisibles a l'oeil :
    //   - `zone_scolaire` absente → AUCUN jour ne tombait dans
    //     « vacances de la zone du bien », TOUT partait en « vacances d'une
    //     autre zone ». La reference rendait 143 EUR sur un segment dont la
    //     mesure dit qu'il ne porte aucun signal. Un chiffre faux et credible.
    //   - `base_price` absente → `joursOuverts` rend COLONNE_MANQUANTE (sa
    //     propre garde, qui a bien fonctionne), donc taux d'occupation,
    //     RevPAR et projection `null` sur TOUTE la fenetre.
    //   - `capacity` absente → occupation en personnes jamais calculable.
    //
    // On recharge donc le bien en entier, et on REFUSE si une colonne dont le
    // moteur depend manque — plutot que de servir des chiffres faux.
    const { data: bien, error: eBien } = await supabase
      .from('properties').select('*').eq('id', garde.bien.id).maybeSingle()
    if (eBien) throw new Error(`properties : ${eBien.message}`)
    if (!bien) return res.status(404).json({ error: 'Bien introuvable' })
    // Seules les colonnes dont le MOTEUR depend : `rate_sync_mode` n'est lu
    // par aucun chemin de lecture (`estRelieAuCanal` ne regarde que `provider`).
    const MANQUANTES = ['base_price', 'capacity', 'zone_scolaire', 'prix_minimum',
      'provider_property_id', 'provider']
      .filter(c => !Object.prototype.hasOwnProperty.call(bien, c))
    // ⚠ LA COLONNE PEUT EXISTER ET ETRE VIDE — releve en review.
    // Un bien cree mais pas encore raccorde au canal a
    // `provider_property_id = null` : aucune reservation ne lui correspond,
    // donc CA 0, nuitees 0, reference vide — et aucun motif. La verite est
    // « ce logement n'est pas raccorde », pas « il n'a rien vendu ».
    if (!bien.provider_property_id) {
      return res.status(409).json({
        error: 'Ce logement n’est pas encore raccordé à un canal : aucun indicateur n’est calculable.'
      })
    }
    if (MANQUANTES.length) {
      console.error('[yield] colonnes absentes de properties :', MANQUANTES.join(', '))
      return res.status(500).json({
        error: 'Configuration incomplète : le moteur ne peut pas calculer sans ' +
          MANQUANTES.join(', ')
      })
    }
    // ─── Fenetre demandee ───────────────────────────────────────────────────
    const auj = jourLocal(new Date())
    const debut = estJourISO(req.query.debut) ? req.query.debut : `${auj.slice(0, 4)}-01-01`
    const finDemandee = estJourISO(req.query.fin) ? req.query.fin : `${auj.slice(0, 4)}-12-31`
    if (finDemandee < debut) return res.status(400).json({ error: 'fin antérieure à debut' })
    const jours = joursDeLaPeriode(debut, finDemandee)
    if (!jours || jours.length > JOURS_MAX) {
      return res.status(400).json({ error: `fenêtre trop large (max ${JOURS_MAX} jours)` })
    }
    const granularite = ['jour', 'mois', 'annee'].includes(req.query.granularite)
      ? req.query.granularite : 'mois'
    // ⚠ LE PIVOT NE DEPASSE PAS AUJOURD'HUI. Un pivot dans le futur rendrait
    // un « a date » qui est en realite le realise final — le contraire de ce
    // que l'indicateur promet.
    const pivotDemande = estJourISO(req.query.pivot) ? req.query.pivot : auj
    const pivot = pivotDemande > auj ? auj : pivotDemande

    // ⚠ LA FENETRE DE LECTURE VA PLUS LOIN QUE LA FENETRE DEMANDEE.
    // Le N-1 du realise et le N-1 du pickup vivent un an plus tot ; la
    // reference remonte trois ans. Charger la seule fenetre demandee rendrait
    // « periode_n1_absente » partout — le faux negatif que tout ce chantier
    // evite. `comparerAN1` ne cherche que dans le tableau qu'on lui passe :
    // c'est un contrat, et c'est ici qu'il se respecte.
    const debutHistorique = reculerAns(debut, ANS_REFERENCE)
    const finRef = reculerAns(finDemandee, 1)
    if (!debutHistorique || !finRef) {
      return res.status(400).json({ error: 'dates de fenêtre invalides' })
    }
    // ⚠ LA FENETRE DE LECTURE DOIT TENIR DANS LA BORNE DES MODULES.
    // `joursExclus` LEVE au-dela de 2000 jours et `joursDeLaPeriode` rend
    // `null` : la garde du haut ne porte que sur la fenetre DEMANDEE, or c'est
    // la fenetre historique — trois ans de plus — qui est reellement lue. On
    // refuse a la porte plutot que de decouvrir le probleme au milieu.
    const joursLus = joursDeLaPeriode(debutHistorique, finDemandee)
    if (!joursLus || !joursLus.length) {
      return res.status(400).json({
        error: `fenêtre trop large : avec ${ANS_REFERENCE} ans d'historique elle dépasse la borne des modules`
      })
    }

    // ─── Le coeur : toutes les reservations du COMPTE ───────────────────────
    // ⚠ TOUT LE COMPTE, PAS LE SEUL BIEN — et c'est le pont demapped qui
    // l'exige : une ligne `demapped` d'un ancien provider porte la date de
    // vente d'origine de la meme reservation re-creee ailleurs. Restreindre au
    // bien la ferait disparaitre, et six mois de dates de vente avec elle.
    // Le filtre par `user_id` est la barriere de cloisonnement.
    let lignes = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('bookings_snapshot')
        // ⚠ `user_id` FAIT PARTIE DE LA CLE DU PONT DEMAPPED.
        // `construirePontDemapped` cle sur `${user_id}|${property_id}|${code}`
        // et `dateVenteFinale` relit `${user_id}|${booking_id}` : sans la
        // colonne, les deux cotes valaient `undefined` et ça ne « marchait »
        // que par symetrie. La defense que le module declare indispensable
        // etait silencieusement neutralisee (releve en review).
        .select('user_id, booking_id, property_id, snapshot, raw')
        .eq('user_id', compte)
        .order('booking_id')
        .range(from, from + 999)
      if (error) throw new Error(`bookings_snapshot : ${error.message}`)
      lignes = lignes.concat(data || [])
      if (!data || data.length < 1000) break
      if (lignes.length > RESERVATIONS_MAX) {
        // On REFUSE, on ne tronque pas : une mesure calculee sur un historique
        // ampute serait fausse sans que rien ne le dise.
        console.error(`[yield] compte ${compte} : plus de ${RESERVATIONS_MAX} reservations`)
        return res.status(413).json({
          error: `Historique trop volumineux (plus de ${RESERVATIONS_MAX} réservations)`
        })
      }
    }
    const { pont } = construirePontDemapped(lignes, bien.provider)

    // ⚠ `provider_property_id` (TEXT) pour le snapshot, `id` (UUID) pour les
    // tables que nous ecrivons nous-memes. Les confondre a deja rendu
    // « 500 nuits sans prix » sur des biens qui vendaient.
    const duBien = lignes.filter(l => l.property_id === bien.provider_property_id)
    // ⚠ UNE SEULE LECTURE POUR DEUX USAGES — releve en review : `joursExclus`
    // appelait deja `exceptionsDuBien` en interne, et on la rappelait juste
    // apres sur la MEME fenetre. Le commentaire voisin se felicitait de
    // « aucune lecture de plus » pour les evenements pendant que ce bloc en
    // ajoutait une.
    // L'ecran a besoin des periodes ELLES-MEMES (pour les lister et les
    // supprimer), le moteur des jours qu'elles excluent : on lit une fois, on
    // derive les deux.
    const exceptions = await exceptionsDuBien(supabase, bien.id, debutHistorique, finDemandee)
    const exclus = new Set()
    for (const p of exceptions) {
      for (const j of joursDeLaPeriode(p.date_debut, p.date_fin) || []) {
        if (j >= debutHistorique && j <= finDemandee) exclus.add(j)
      }
    }
    const eclatements = duBien.map(l => eclater(l, {
      pont, joursExclus: exclus, defaultProvider: bien.provider
    }))

    // ─── Capacites, periode par periode ─────────────────────────────────────
    // ⚠ EN PARALLELE, PAR LOTS. Trois ans en mois font 36 lectures de
    // `calendar_inventory` : en serie, la reponse mettait 7 secondes. Par lots
    // de 6, elle passe sous la seconde et demie sans ouvrir 36 connexions d'un
    // coup — ce qui ferait tomber le pool sur un compte a plusieurs biens.
    // ⚠ LES CAPACITES NE SERVENT QUE POUR LES PERIODES DEMANDEES ET LEURS N-1.
    // Premiere version : toutes les periodes de l'historique de trois ans. En
    // granularite « jour » cela faisait 1 096 lectures de `calendar_inventory`
    // pour afficher DEUX journees — et la borne posee en review fermait alors
    // un usage parfaitement legitime. La reference, elle, a besoin des
    // ECLATEMENTS sur trois ans, pas des capacites : ce sont deux matieres
    // differentes, et les confondre coutait cher pour rien.
    const clesVisees = clesDePeriode(debut, finDemandee, granularite)
    const cles = [...new Set(clesVisees.flatMap(c => {
      const prec = periodePrecedente(c)
      return prec ? [prec, c] : [c]
    }))].sort()
    if (cles.length > PERIODES_MAX) {
      return res.status(400).json({
        error: `trop de périodes (${cles.length}, max ${PERIODES_MAX})`
          + ` : réduisez la fenêtre ou choisissez un détail moins fin`
      })
    }
    const capacites = new Map()
    const LOT = 6
    for (let i = 0; i < cles.length; i += LOT) {
      const tranche = cles.slice(i, i + LOT).map(cle => {
        const b = bornesDePeriode(cle)
        if (!b) return null
        return joursOuverts(supabase, bien, b[0], b[1], {
          aujourdHui: auj, estimerLePasse: true
        }).then(r => [cle, r])
      }).filter(Boolean)
      for (const [cle, r] of await Promise.all(tranche)) capacites.set(cle, r)
    }

    // ─── Realise, et sa comparaison N-1 ─────────────────────────────────────
    const indicateurs = comparerAN1(calculerIndicateurs(eclatements, {
      granularite, capacites, capacitePersonnes: bien.capacity
    }))
    const clesDemandees = new Set(clesVisees)
    const realise = indicateurs.filter(i => clesDemandees.has(i.periode))

    // ─── « A date » : une entree par periode demandee ───────────────────────
    const aDate = [...clesDemandees].sort().map(cle => pickup(eclatements, {
      periode: cle, pivot, granularite, capacites, capacitePersonnes: bien.capacity
    }))

    // ─── Reference par segment, sur 3 ans ───────────────────────────────────
    // ⚠ LE CONTEXTE COUVRE LES PERIODES ENTIERES, PAS LA FENETRE DEMANDEE —
    // releve en review. `bornesDePeriode` projette sur le mois COMPLET : avec
    // une fenetre finissant le 12 septembre, les jours du 13 au 30 tombaient
    // hors du contexte et `segmenterJour` rendait « hors_fenetre_du_contexte ».
    // L'hote lisait « je ne sais pas » sur dix-huit jours dont la reference
    // existe. Meme trou a gauche, sur la premiere periode de l'historique.
    const bornesDerniere = bornesDePeriode(clesVisees[clesVisees.length - 1])
      || [finDemandee, finDemandee]
    const debutContexte = debutHistorique
    const finContexte = bornesDerniere[1] > finDemandee ? bornesDerniere[1] : finDemandee
    const vacances = await lireVacances(supabase, debutContexte, finContexte)
    // ⚠ LA COUVERTURE SE MESURE SUR LA SOURCE, PAS SUR UNE LECTURE FILTREE —
    // releve en review. `lireVacances` ne rend que les periodes qui CHEVAUCHENT
    // la fenetre : comparer leur min/max a cette meme fenetre exigeait que ses
    // deux bornes tombent DANS des vacances. Le bandeau « source incomplete »
    // criait donc faux des que la fenetre commencait hors vacances — avec une
    // table pourtant complete.
    const etendue = await etendueSource(supabase)
    const couvertureVacances = couverture(etendue, debutContexte, finContexte,
      bien.zone_scolaire)
    const contexte = R.construireContexte({
      zoneBien: bien.zone_scolaire, vacances, debut: debutContexte, fin: finContexte
    })
    const reference = R.construireReference(eclatements, {
      contexte, debut: debutHistorique, fin: finRef
    })
    const courbe = R.courbeDeDelai(eclatements, {
      contexte, debut: debutHistorique, fin: finRef
    })

    // ─── Projection : une par periode demandee ──────────────────────────────
    const projection = [...clesDemandees].sort().map(cle => {
      const b = bornesDePeriode(cle)
      const cap = capacites.get(cle)
      const pk = aDate.find(x => x.periode === cle)
      // ⚠ ON NE PROJETTE QUE LES JOURS OUVERTS. Le contrat de `projeter` est
      // explicite : il ne peut pas verifier ce qu'on lui passe.
      const joursDuMois = (cap && cap.detail) ? cap.detail : []
      const p = R.projeter({
        jours: joursDuMois,
        reference,
        courbe,
        contexte,
        delaiJours: pk ? pk.delai_jours : null,
        nuiteesVendues: pk && pk.a_date ? pk.a_date.nuitees : 0,
        capacite: cap,
        // L'occupation de reference est celle du N-1 REALISE, quand elle
        // existe : sans elle, `projeter` refuse de dire une avance ou un
        // retard plutot que d'en inventer un.
        occupationReference: (() => {
          const n1 = indicateurs.find(i => i.periode === (pk ? pk.periode_n1 : null))
          return n1 && n1.taux_occupation != null ? n1.taux_occupation : null
        })()
      })
      // Le detail jour par jour est volumineux et l'ecran ne l'affiche pas
      // encore : on le resume. Le lot 4.4 le redemandera par date.
      const { detail, ...sansDetail } = p
      return { periode: cle, ...sansDetail }
    })

    // ⚠ LE CONTEXTE EST DEJA EN MAIN — releve en review.
    // La premiere version rappelait `requirePermission` avec un FAUX objet
    // `res` : trois requetes Supabase de plus par affichage, et un pari sur le
    // fait que la garde n'appellerait jamais rien d'autre que `status().json()`.
    // Le jour ou quelqu'un y ajoute un `setHeader('Retry-After')`, le `catch`
    // avale et le formulaire disparait pour tout le monde, sans un mot.
    // `garde.contexte` porte deja les droits resolus.
    const droitsEcriture = garde.contexte
      ? peutEcrire(garde.contexte, 'reglages',
        { id: bien.id, ref: bien.provider_property_id })
      // Pas de contexte = titulaire du compte : il a tout.
      : true

    // ─── Evenements a venir : LECTURE SEULE ─────────────────────────────────
    // ⚠ AUCUNE LECTURE DE PLUS. Vacances, feries et ponts sont deja dans le
    // `contexte` charge pour la reference : les reservir coute zero requete.
    // L'hote a besoin de voir ce qui arrive — c'est ce qui explique pourquoi
    // un mois vaut plus qu'un autre, et ce sur quoi porteront les suggestions.
    const evenements = []
    for (const j of joursDeLaPeriode(auj, finContexte) || []) {
      const seg = R.segmenterJour(j, contexte)
      if (!seg || !seg.segment) continue
      if (seg.segment === R.SEGMENTS.HORS_VACANCES) continue
      const dernier = evenements[evenements.length - 1]
      // On regroupe les jours consecutifs de meme nature : une liste de 60
      // lignes « vacances d'ete » ne se lit pas, « du 4 juillet au 31 aout »
      // se lit.
      //
      // ⚠ LES ZONES FONT PARTIE DE L'IDENTITE DU GROUPE — releve en review.
      // `detail` vient du NOM des vacances, `zones_en_vacances` se calcule jour
      // par jour : les zones n'entrent ni ne sortent des vacances le meme jour,
      // donc le nom restait stable pendant que la liste changeait. Un groupe
      // « 20 fevrier → 8 mars » affichait « A, B, C » sur ses dix-sept jours
      // alors que du 2 au 8 mars seule C est en vacances — et c'est precisement
      // la colonne sur laquelle s'appuie l'explication du bloc.
      const memesZones = (a, b) =>
        JSON.stringify(a || null) === JSON.stringify(b || null)
      if (dernier && dernier.detail === seg.detail && dernier.fin === veille(j) &&
          memesZones(dernier.zones_en_vacances, seg.zones_en_vacances)) {
        dernier.fin = j
        dernier.jours++
        continue
      }
      evenements.push({
        debut: j, fin: j, jours: 1,
        segment: seg.segment, detail: seg.detail,
        libelle: seg.libelle || null,
        zones_en_vacances: seg.zones_en_vacances || null
      })
    }

    return res.status(200).json({
      bien: {
        id: bien.id,
        name: bien.name,
        provider: bien.provider,
        capacity: bien.capacity ?? null,
        zone_scolaire: bien.zone_scolaire ?? null,
        prix_minimum: bien.prix_minimum ?? null,
        base_price: bien.base_price ?? null
      },
      fenetre: { debut, fin: finDemandee, granularite, pivot, aujourdhui: auj },
      historique: { debut: debutHistorique, fin: finRef, ans: ANS_REFERENCE },
      realise,
      a_date: aDate,
      reference: {
        seuil: reference.seuil,
        seuil_reservations: reference.seuil_reservations,
        fenetre: reference.fenetre,
        nuits_vues: reference.nuits_vues,
        nuits_sans_prix: reference.nuits_sans_prix,
        nuits_hors_reference: reference.nuits_hors_reference,
        nuits_long_sejour: reference.nuits_long_sejour,
        // Le niveau « segment seul » suffit a l'ecran de synthese ; les cases
        // fines se lisent date par date au lot 4.4.
        par_segment: Object.fromEntries(reference.niveaux[2])
      },
      courbe: {
        paliers: courbe.paliers,
        nuits_sans_date_fiable: courbe.nuits_sans_date_fiable,
        par_segment: Object.fromEntries(courbe.par_segment)
      },
      projection,
      evenements,
      exceptions,
      // ⚠ LE DROIT D'ECRIRE EST TRANCHE PAR LE SERVEUR, JAMAIS DEDUIT PAR
      // L'ECRAN. La page s'en sert pour MONTRER ou CACHER le formulaire —
      // c'est du confort, pas une garde : `/api/yield-exceptions` revalide a
      // chaque ecriture. Une interface qui decide seule des droits finit par
      // les decider mal.
      droits_ecriture: droitsEcriture,
      // ⚠ LES DRAPEAUX DE SOURCE REMONTENT JUSQU'A L'ECRAN. La table des
      // vacances s'arrete a la derniere annee scolaire publiee : au-dela, tout
      // serait classe « hors vacances » — un ete entier en basse saison, sans
      // la moindre erreur.
      sources: {
        reservations: lignes.length,
        reservations_du_bien: duBien.length,
        jours_hors_reference: exclus ? (exclus.size ?? Object.keys(exclus).length) : 0,
        // ⚠ LA DETTE DATEE, VISIBLE. `school_holidays` s'arrete a la derniere
        // annee scolaire publiee : au-dela, chaque jour serait classe « hors
        // vacances » — un ete entier en basse saison, sans la moindre erreur.
        // L'ecran doit pouvoir le DIRE comme une limite connue, pas la subir.
        vacances: { ...couvertureVacances, horizon: couvertureVacances.fin }
      }
    })
  } catch (e) {
    // ⚠ ON DIT L'ERREUR, ON NE REND PAS UN ECRAN VIDE. Un 200 avec des
    // tableaux vides ferait lire « ce bien n'a rien vendu » — le faux negatif
    // que tout ce chantier combat, jusque dans sa gestion d'erreur.
    console.error('[yield] lecture echouee :', e.message)
    return res.status(500).json({ error: 'Lecture des indicateurs impossible' })
  }
}
