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
const { requirePermission, posterEnTetesPrives } = require('../lib/require-permission')
const { peutEcrire } = require('../lib/permissions')
const { eclater, construirePontDemapped } = require('../lib/yield/eclatement')
const {
  calculerIndicateurs, comparerAN1, clePeriode, periodePrecedente
} = require('../lib/yield/indicateurs')
const { joursOuverts, lignesDuCalendrier, estJourISO, joursDeLaPeriode } = require('../lib/yield/capacite')
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
//
// ⚠ DEPUIS LE 20 OCTOBRE 2026, CE N'EST PLUS LE RESEAU QUI BORNE, c'est la
// taille de la REPONSE et le classement en memoire : la lecture du calendrier
// est hissee, donc 1 461 periodes ne font plus 1 461 requetes mais une seule.
// La borne reste — 1,2 Mo de reponse et 1 461 classements restent de trop —
// mais sa justification par les allers-retours ne vaut plus.
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
  // ⚠ DETTE 90 : AVANT LE PREMIER REFUS, pas seulement avant la garde. Les refus
  // qui precedent `requirePermission` — methode, bien absent — partaient avec le
  // defaut de Vercel, `public, max-age=0, must-revalidate`. Le pourquoi et les
  // trois garde-fous : `tests/cache-prive-endpoints.test.js`, section dette 90.
  posterEnTetesPrives(res)
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
    // ⚠ LA FENETRE DES EXCLUSIONS VA JUSQU'A LA FIN DE LA DERNIERE PERIODE,
    // PAS JUSQU'A `finDemandee` — releve en review, et c'est la moitie du
    // correctif de la dette 78 qui manquait. `bornesDePeriode` DEPASSE la
    // fenetre demandee des que la granularite est « mois » ou « annee » :
    // debut=2026-06-01 fin=2026-06-20 en mois donne une borne au 2026-06-30.
    // Or `joursExclus` borne son Set a la fenetre qu'on lui donne. Mesure :
    // avec `fin=2026-06-12` et une exception couvrant tout juin, la derniere
    // periode rendait `jours_ouverts: 18` et un TO de 22,2 % sur des jours que
    // l'hote avait declares fermes, `calculable: true`, sans aucun motif — le
    // defaut d'origine, intact, et le compte des jours declares (12)
    // contredisait la declaration (30). Le perimetre du calcul dependait d'un
    // parametre de requete.
    // `api/yield.js` avait deja appris cette lecon pour `finContexte` (« LE
    // CONTEXTE COUVRE LES PERIODES ENTIERES, PAS LA FENETRE DEMANDEE ») ;
    // `exclus` n'avait pas eu le meme traitement.
    const finPeriodes = (() => {
      const bs = clesDePeriode(debut, finDemandee, granularite)
        .flatMap(c => { const p = periodePrecedente(c); return p ? [p, c] : [c] })
        .map(bornesDePeriode)
        .filter(b => b && estJourISO(b[0]) && estJourISO(b[1]))
      const max = bs.map(b => b[1]).sort().slice(-1)[0]
      return max && max > finDemandee ? max : finDemandee
    })()
    const exceptions = await exceptionsDuBien(supabase, bien.id, debutHistorique, finPeriodes)
    // ⚠ PAR `joursExclus`, PAS PAR UN Set MAISON : c'est lui qui sait que les
    // FERMETURES de l'hote (lot 4.6.2) sortent aussi de la reference. Les
    // exceptions deja lues lui sont passees — une lecture, deux usages.
    const exclus = await joursExclus(supabase, bien.id, debutHistorique, finPeriodes, { exceptions })
    const eclatements = duBien.map(l => eclater(l, {
      pont, joursExclus: exclus, defaultProvider: bien.provider
    }))

    // ─── Capacites, periode par periode ─────────────────────────────────────
    // ⚠ LE LOT DE 6 A DISPARU LE 20 OCTOBRE 2026, et ce commentaire disait le
    // contraire. Il justifiait des lectures PARALLELES par la taille du pool de
    // connexions — or il n'y a plus qu'une lecture a faire. Le laisser en tete
    // de section, c'est inviter la prochaine session a « restaurer » un
    // LOT = 6 qui n'a plus rien a borner.
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
    // ⚠ UNE SEULE LECTURE DU CALENDRIER POUR TOUTES LES PERIODES.
    //
    // `joursOuverts` porte cette facilite depuis le lot 4.6 (`options.lignes`)
    // et la documente avec sa mesure — « le radar douze mois appelle cette
    // fonction 24 fois […] 2 673 ms de requetes […] avec les lignes fournies,
    // c'est UNE lecture et 24 classifications en memoire ». Cet endpoint ne
    // s'en servait pas : il appelait la fonction une fois par periode, chacune
    // avec sa propre requete, par paquets de 6.
    //
    // Mesure du 20 octobre 2026, accueil connecte sur le compte de production
    // (4 biens raccordes), comptee en instrumentant le code d'avant :
    // l'appel quotidien demande 60 jours, et `cles` y ajoute la periode
    // PRECEDENTE de chacun — **120** periodes, donc 120 requetes en 20 vagues
    // de 6 ; l'appel mensuel (douze mois complets) en demande **24**, soit
    // 4 vagues. Par bien : 144 requetes en 24 allers-retours series. Pour la
    // page : 4 x (120 + 24) = **576 requetes** sur `calendar_inventory`.
    // Releve par Thierry dans son navigateur : /api/yield de 1,6 s a 5,6 s par
    // appel, le dernier fini a ~15,7 s apres l'ouverture.
    //
    // ⚠ CHAQUE JOUR VISE APPORTE EXACTEMENT UN N-1 DISTINCT, donc le compte est
    // toujours PAIR : une premiere version de ce commentaire disait « 121 », un
    // nombre arithmetiquement impossible, et « 580 » s'en deduisait.
    //
    // ⚠ LA REGLE NE BOUGE PAS D'UN IOTA, et ce n'est pas une promesse : c'est
    // le contrat que `lib/yield/capacite.js` ecrit en tete de son chemin
    // `fournies` — il REFILTRE sur la fenetre ET sur le bien, et un test du
    // module compare les deux chemins sur les memes donnees. Seule la SOURCE
    // des lignes change.
    //
    // ⚠ ET UNE LECTURE EN ECHEC SE PROPAGE, elle ne rend pas une plage vide.
    // Un tableau vide ferait tomber chaque jour en « sans ligne », donc ferme :
    // un denominateur faux, credible et silencieux — exactement ce que le
    // module refuse de deviner (« un denominateur invente est pire qu'un trou
    // declare »). Le `throw` rejoint le `catch` de l'enveloppe, qui rend 500.
    // ⚠ LES BORNES SONT FILTREES PAR `estJourISO`, ET C'EST UNE REGRESSION QUE
    // CE FILTRE FERME. `periodePrecedente` fait de l'arithmetique de CHAINE :
    // `periodePrecedente('2024-02-29')` rend « 2023-02-29 », qui n'existe pas,
    // et `bornesDePeriode` ne verifie que la FORME, donc la laisse passer. Comme
    // c'est le minimum lexicographique, elle devenait le debut de la plage et
    // partait telle quelle dans le `.gte('date', …)` — Postgres refuse
    // (`date NOT NULL`, 22008), la lecture leve, et TOUTE la reponse tombe en
    // 500. L'ancien chemin par periode ne l'emettait jamais : `joursOuverts`
    // ecartait cette cle avant toute lecture (`estJourISO` faux -> aucun jour).
    //
    // Atteignable a la main en permanence depuis « Exploration » (date libre +
    // « Par jour »), et TOUT SEUL depuis l'accueil, qui demande
    // `debut = aujourd'hui - 60` : le 29 avril 2028, `debut` vaut 2028-02-29 et
    // la periode precedente « 2027-02-29 ». Les tuiles des quatre biens
    // seraient tombees en erreur ce jour-la.
    const bornes = cles.map(bornesDePeriode)
      .filter(b => b && estJourISO(b[0]) && estJourISO(b[1]))
    let lignesCalendrier = []
    if (bornes.length) {
      // ⚠ LA LECTURE VIENT DE `lib/yield/capacite.js`, elle n'est pas recopiee
      // ici : c'est le module qui definit la projection (dont `property_id`,
      // qui ARME le refus d'une ligne d'un autre bien dans son chemin
      // `fournies`) et la pagination. Sept copies de cette requete existaient
      // dans le seul chemin yield, avec trois ordres de colonnes.
      lignesCalendrier = await lignesDuCalendrier(supabase, bien.id,
        bornes.map(b => b[0]).sort()[0],
        bornes.map(b => b[1]).sort().slice(-1)[0])
    }
    // ⚠ DEUX CARTES DE CAPACITES, ET C'EST LE POINT LE PLUS IMPORTANT DE CE
    // LOT — releve en review. `joursExclus` repond a « faut-il compter cette
    // nuit dans la REFERENCE ? ». Il ne repond PAS a « cette nuit etait-elle
    // ouverte a la vente ? ». Ce sont deux questions, et une seule carte les
    // confondait : la meme `capacites` nourrit `calculerIndicateurs` (ou l'on
    // veut l'exclusion, c'est la dette 78), `pickup` et `R.projeter` (ou on ne
    // la veut pas).
    //
    // Ce que la carte unique produisait, dans UNE SEULE reponse HTTP :
    //  - `pickup` voyait `jours_ouverts: 0` sur un mois entierement declare et
    //    levait `periode_n1_fermee_a_la_vente`, qui DISQUALIFIE tout le N-1 du
    //    « a date ». L'ecran affichait « +0 % » dans un bloc et « l'an dernier,
    //    le logement ne POUVAIT pas vendre » dans l'autre, a propos d'un mois
    //    ouvert qui avait vendu 400 EUR. Et l'alerte de haut de page invitait
    //    l'hote a rouvrir les jours qu'il venait de declarer fermes.
    //  - `R.projeter` recevait un numerateur BRUT (`pk.a_date.nuitees`) et un
    //    denominateur retreci : le taux extrapole montait jusqu'a son plafond,
    //    et la cellule « Avance / retard » basculait de -1 (rouge) a +6 (vert).
    //    C'est litteralement le defaut du lot 3.3 (« 3 nuits vendues dont 2 en
    //    exception, 1 jour ouvert -> 300 % ») reouvert une fonction plus loin.
    //
    // Les deux cartes sortent de la MEME lecture de calendrier : classer deux
    // fois est du calcul en memoire, pas un aller-retour de plus.
    const capacites = new Map()        // reference : les jours declares fermes RETIRES
    const capacitesVente = new Map()   // vente : ce que le canal savait, sans declaration
    const classer = (cle, options) => {
      const b = bornesDePeriode(cle)
      if (!b) return null
      return joursOuverts(supabase, bien, b[0], b[1], options).then(r => [cle, r])
    }
    const communes = {
      aujourdHui: auj, estimerLePasse: true, lignes: lignesCalendrier
    }
    const classees = await Promise.all(cles.map(cle => classer(cle, {
      ...communes,
      // ⚠ DETTE 78 : LE DENOMINATEUR SUIT LE NUMERATEUR. `eclater` retire deja
      // des nuits de REFERENCE celles qu'une exception ou une fermeture
      // declaree couvre (`nuitees_hors_reference`), et `calculerIndicateurs`
      // fait `nuiteesRef = nuitees - hors_reference` puis divise par
      // `jours_ouverts` — sous le commentaire « ce qui DIVISE se calcule des
      // deux cotes sur le meme perimetre ». Les deux moities n'etaient pas
      // branchees sur le meme perimetre.
      //
      // Mesure du 20 octobre 2026 sur les 4 biens reels : la dette ne mord que
      // la ou un jour declare ferme est PAR AILLEURS compte ouvert — le passe
      // ancien sans memoire d'intention. Coeur de vie 23, 20 septembre au
      // 15 octobre 2025 (exception de 17 jours) : TO 23,1 % au lieu de 66,7 %,
      // RevPAR 21,77 EUR au lieu de 62,88 EUR, denominateur 26 au lieu de 9.
      joursExclus: exclus
    })).filter(Boolean))
    for (const [cle, r] of classees) capacites.set(cle, r)
    const classeesVente = await Promise.all(cles.map(cle => classer(cle, communes)).filter(Boolean))
    for (const [cle, r] of classeesVente) capacitesVente.set(cle, r)

    // ─── Realise, et sa comparaison N-1 ─────────────────────────────────────
    const indicateurs = comparerAN1(calculerIndicateurs(eclatements, {
      granularite, capacites, capacitePersonnes: bien.capacity
    }))
    const clesDemandees = new Set(clesVisees)
    const realise = indicateurs.filter(i => clesDemandees.has(i.periode))

    // ─── « A date » : une entree par periode demandee ───────────────────────
    const aDate = [...clesDemandees].sort().map(cle => pickup(eclatements, {
      // ⚠ LES DEUX CARTES, ET C'EST LE CORRECTIF DE LA RE-REVIEW. `pickup` pose
      // deux questions distinctes et il lui faut les deux perimetres :
      //   - « que faut-il DIVISER ? »  -> la carte de REFERENCE. Son numerateur
      //     est deja net (`nuitees - nuitees_hors_reference`), donc un
      //     denominateur de vente remettait l'asymetrie que ce lot corrige :
      //     mesure, `realise` a 20 % et `a_date` a 13,33 % pour le MEME mois
      //     dans la MEME reponse.
      //   - « la periode etait-elle OUVERTE A LA VENTE ? » -> la carte de
      //     VENTE, pour les drapeaux seulement, sinon `periode_n1_fermee` se
      //     levait sur un mois qui avait vendu 400 EUR.
      // Une seule carte ne pouvait donc PAS le servir : c'est ce que la
      // premiere version de ce lot avait manque, dans les deux sens.
      periode: cle, pivot, granularite, capacitePersonnes: bien.capacity,
      capacites, capacitesVente
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
      // ⚠ LES QUATRE ENTREES DE `projeter` SUR LE MEME PERIMETRE — releve en
      // re-review, et c'etait le constat le plus couteux du lot.
      // `reference.js` fait `nuitees_de_reference = capacite.jours_ouverts x
      // occupationReference`, puis `avance_retard = extrapolees -
      // nuitees_de_reference`. Avec `capacite` pris dans la carte de VENTE et
      // `occupationReference` lu dans `indicateurs` — bati sur la carte de
      // REFERENCE —, le produit multipliait un taux de reference par une
      // capacite de vente : sur le temoin du lot (TO N-1 23,1 % -> 66,7 %) le
      // facteur est 2,9. L'ecran colore « Avance / retard » sur le SIGNE : un
      // mois a l'heure affichait un retard de plusieurs nuits, en rouge, sans
      // aucun motif. C'est le miroir exact du defaut que le commentaire de la
      // ligne precedente disait avoir ferme.
      // Donc : capacite, jours, numerateur et occupation de reference viennent
      // TOUS de la reference. Et `jours` surtout : le contrat de `projeter` dit
      // qu'il ne projette que des jours ouverts, et la carte de vente lui
      // faisait tarifer des nuits que l'hote a declarees fermees.
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
        // ⚠ LE NUMERATEUR NET, PAS LE BRUT. `pk.a_date.nuitees` compte les
        // nuits vendues y compris celles qu'une declaration retire de la
        // reference : sur un denominateur de reference, le brut faisait monter
        // le taux extrapole jusqu'a son plafond — le defaut du lot 3.3
        // (« 3 nuits vendues dont 2 en exception, 1 jour ouvert -> 300 % »)
        // rouvert une fonction plus loin.
        nuiteesVendues: pk && pk.a_date
          ? (pk.a_date.nuitees || 0) - (pk.a_date.nuitees_exclues_du_taux || 0)
          : 0,
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
        // ⚠ BORNE A LA FENETRE DEMANDEE — releve en re-review. `exclus` est
        // desormais lu jusqu'a `finPeriodes`, qui DEPASSE la fenetre des que la
        // granularite est « mois » ou « annee ». Mesure, memes donnees du 1er
        // au 12 juin, en ne changeant que la granularite : 12, 30, 30 — et
        // l'ecran affiche ce chiffre en tete de page, « 30 jour(s) hors
        // reference. Periodes que vous avez declarees exceptionnelles ».
        // 30 jours exclus dans une fenetre de 12 est arithmetiquement
        // impossible pour qui recoupe, et l'hote cherche une declaration de
        // 18 jours qu'il n'a pas faite. En granularite « annee », le compteur
        // absorbait jusqu'a 364 jours que l'appelant n'avait pas demandes.
        jours_hors_reference: (() => {
          if (!exclus) return 0
          const tous = exclus.keys ? [...exclus] : Object.keys(exclus)
          return tous.filter(j => j >= debut && j <= finDemandee).length
        })(),
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

// ⚠ EXPORTES POUR ETRE EPROUVES, PAS POUR ETRE RECOPIES.
// `scripts/verifier-parite-capacites.js` doit construire EXACTEMENT les memes
// periodes que cet endpoint pour comparer l'ancien chemin (une requete par
// periode) au nouveau (une lecture, puis `options.lignes`). Les recopier dans
// le script aurait prouve la copie, pas le chemin — regle du depot. Meme forme
// que `module.exports.outilsAutoValidation` dans api/avis.js.
module.exports.outilsPeriodes = { clesDePeriode, bornesDePeriode, JOURS_MAX, PERIODES_MAX }
