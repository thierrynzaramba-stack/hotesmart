// lib/calendrier-writer.js — LE WRITER UNIQUE DU CALENDRIER (lot 4.6.1).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, section 2.
// DOC : docs/kb/coeur-de-donnees.md — docs/CALENDRIER_TECH.md
//
// Extrait de `api/calendar.js` (bloc `save`), a l'identique, pour etre appele
// par DEUX portes : l'endpoint HTTP (la main de l'hote) et le canal interne
// `lib/canal-calendrier.js` (la main du moteur). Un writer, deux portes, deux
// gardes — et rien de recopie. Chaque porte fait ses gardes AVANT d'appeler ;
// ce module fait ce qui vaut pour les deux : le plancher, la relecture des
// lignes existantes, la fusion, l'upsert de `calendar_inventory`, la poussee
// ARI, le plafonnement du stock, la reaffirmation du stop_sell, le journal des
// prix affiches, le verdict et l'alerte.
//
// ⚠ IL NE CONNAIT NI `req` NI `res`. Un refus est une VALEUR rendue —
// `{ refus: { status, body } }` — que la porte HTTP traduit en reponse et que
// le canal interne journalise. Aucune reference a la requete ne doit entrer
// ici : c'est ce qui le rend appelable par un cron.
//
// ⚠ `appel` EST FOURNI PAR LA PORTE, comme `pousserAri` le faisait deja. Ce
// module ne cree aucun client HTTP vers le canal : la regle du depot est que
// le code canal passe par lib/channels/, et chaque porte y a deja le sien.
//
// ⚠ TOUS LES COMMENTAIRES DE `api/calendar.js` ONT SUIVI LE CODE. Chacun
// raconte un incident date ; les deplacer sans eux aurait laisse le prochain
// lecteur devant des gardes dont il ne saurait plus ce qu'elles ferment.

const { buildOccupancyRates } = require('./channel-pricing')
const { canPushRates, estRelieAuCanal } = require('./rate-sync')
const {
  enregistrerPrixPousses, ouverturesDeDatesTarifees, nuitsAJournaliser
} = require('./price-log')
const { tarifAcceptable, messageRefus } = require('./yield/prix-plancher')
const { reaffirmerStopSell } = require('./channel-availability')

const toLocalISO = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

// Mapping jour JS (0=dim..6=sam) -> code channel (mo,tu,we,th,fr,sa,su)
const DOW_CODE = { 1:'mo', 2:'tu', 3:'we', 4:'th', 5:'fr', 6:'sa', 0:'su' }

// Jour suivant en ISO (UTC, deterministe quel que soit le fuseau serveur)
function nextISO(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Objet restrictions canonique pour une ligne d'inventaire (ou {} si absente).
// min_stay_arrival/through couples (miroir) ; booleans en etat effectif (false=ouvert).
function restrictionObj(r) {
  r = r || {}
  const obj = {}
  if (r.rate != null) obj.rate = Math.round(Number(r.rate) * 100)   // euros -> cents
  const msa = (r.min_stay_arrival != null && r.min_stay_arrival > 0) ? r.min_stay_arrival : 0
  const mst = (r.min_stay_through != null && r.min_stay_through > 0) ? r.min_stay_through : 0
  if (msa || mst) {
    obj.min_stay_arrival = msa || mst
    obj.min_stay_through = mst || msa
  }
  if (r.max_stay != null && r.max_stay > 0) obj.max_stay = r.max_stay
  obj.closed_to_arrival = !!r.cta
  obj.closed_to_departure = !!r.ctd
  obj.stop_sell = !!r.stop_sell
  return obj
}

// Une restriction "vide" (aucun rate/min/max, tout ouvert) equivaut a "pas de restriction".
function isEmptyRestriction(obj) {
  return obj.rate == null && obj.min_stay_arrival == null && obj.max_stay == null
    && !obj.closed_to_arrival && !obj.closed_to_departure && !obj.stop_sell
}

// Signature de comparaison delta : 'NONE' si vide, sinon JSON stable.
function restChangeSig(obj) {
  return isEmptyRestriction(obj) ? 'NONE' : JSON.stringify(obj)
}

// Coalescence : regroupe les dates consecutives a signature identique en plages.
// items: [{ date:'YYYY-MM-DD', sig:string, value:object }] tries par date asc.
function coalesceRanges(items) {
  const out = []
  let cur = null
  for (const it of items) {
    if (cur && it.sig === cur.sig && nextISO(cur.date_to) === it.date) {
      cur.date_to = it.date
    } else {
      if (cur) out.push({ ...cur.value, date_from: cur.date_from, date_to: cur.date_to })
      cur = { sig: it.sig, date_from: it.date, date_to: it.date, value: it.value }
    }
  }
  if (cur) out.push({ ...cur.value, date_from: cur.date_from, date_to: cur.date_to })
  return out
}


// Materialise un segment en jours ISO LOCAUX, en respectant le filtre `days`.
function expandDays (date_from, date_to, days) {
  const out = []
  const d = new Date(date_from + 'T00:00:00')
  const last = new Date(date_to + 'T00:00:00')
  while (d <= last) {
    const dow = d.getDay()
    if (!days || !days.length || days.includes(dow)) out.push(toLocalISO(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

// ─── LA POUSSEE ARI D'UNE SAUVEGARDE DE CALENDRIER ────────────────────────
// Extraite pour etre EXECUTEE par un test avec un double de `appel` : c'est
// elle qui fait le lien entre la realite HTTP et `verdictPoussee`, et la review
// a montre qu'une mutation d'une seule de ses lignes (n'enregistrer le resultat
// que dans le `else` du succes) laissait treize tests verts en restaurant le
// silence complet.
//
// ⚠ `resultats` est MUTE, pas rendu : si `appel` leve, l'appelant doit garder
// ce qui a deja ete constate. Un objet rendu serait perdu avec l'exception.
//
// ⚠ ORDRE : AVAILABILITY D'ABORD, RESTRICTIONS ENSUITE. Un POST /availability
// leve le stop_sell des dates touchees (mesure du 7 septembre 2026). Pousser
// les restrictions en premier revenait a poser le stop-sell puis a l'effacer
// soi-meme dans la foulee. C'est l'ordre de lib/channel-fullsync.js.
async function pousserAri ({ availabilityValues, restrictionValues, pousserLesTarifs,
                             appel, resultats, warnings, taskIds }) {
  let pushed = false
  // Availability : TOUJOURS poussee (anti-surbooking, non negociable), quel que soit le mode.
  if (availabilityValues.length) {
    // ⚠ L'ECHEC EST POSE AVANT L'APPEL, ET C'EST LE POINT ENTIER.
    // Le `channelCall` de ce fichier ne protege pas son `fetch`. Une coupure
    // reseau (ECONNRESET, EAI_AGAIN, timeout) LEVE — le mode de panne le plus
    // probable en production — et la ligne qui enregistre le resultat n'etait
    // alors jamais atteinte : `resultats` restait vide, `verdictPoussee({})`
    // rendait « pas de panne », et l'incident du 11 septembre se reproduisait a
    // l'identique. En posant l'echec d'abord, une exception le LAISSE en place.
    resultats.availability = { tente: true, ok: false, status: 0 }
    const a = await appel('POST', '/availability', { values: availabilityValues })
    resultats.availability = { tente: true, ok: !!a.ok, status: a.status }
    if (!a.ok) { warnings.push('availability: HTTP ' + a.status) }
    else { pushed = true; taskIds.availability = a.json?.data?.[0]?.id || null }
  }
  if (restrictionValues.length) {
    // SCISSION dispo/tarifs : /restrictions porte le rate (+ conditions de sejour).
    // On ne le pousse qu'en mode 'managed'. En 'keep', tout est deja enregistre en
    // base (brouillon local) mais rien ne part : l'hote garde ses prix cote plateforme.
    if (pousserLesTarifs) {
      resultats.restrictions = { tente: true, ok: false, status: 0 }
      const r = await appel('POST', '/restrictions', { values: restrictionValues })
      resultats.restrictions = { tente: true, ok: !!r.ok, status: r.status }
      if (!r.ok) { warnings.push('restrictions: HTTP ' + r.status) }
      else {
        pushed = true
        taskIds.restrictions = r.json?.data?.[0]?.id || null
        const w = r.json?.meta?.warnings
        if (Array.isArray(w) && w.length) warnings.push('restrictions: ' + w.length + ' avertissement(s)')
      }
    } else {
      taskIds.restrictions_skipped = 'mode_keep'
      // ⚠ ET ON LE DIT A L'HOTE. `restrictions_skipped` est un drapeau pour le
      // code. Sans cette ligne, l'ecran affiche « Enregistre et publie » alors
      // que RIEN n'est parti aux plateformes.
      //
      // MESURE DU 10 SEPTEMBRE 2026. Thierry a rouvert le samedi 31 octobre
      // dans le calendrier, vu « Enregistre et publie », et attendu QUINZE
      // MINUTES devant une date restee fermee sur Booking et Airbnb. Le defaut
      // n'etait pas le mode — c'est un choix legitime — mais le SILENCE sur son
      // effet.
      warnings.push('Enregistré dans HôteSmart — ce logement est en '
        + '« je garde mes prix » : vos tarifs et vos réouvertures ne sont '
        + 'PAS envoyés aux plateformes. Passez-le en « HôteSmart gère mes '
        + 'prix » pour qu\'ils partent.')
    }
  }
  return pushed
}

// ─── VERDICT D'UNE POUSSEE DE CALENDRIER ──────────────────────────────────
// ⚠ INCIDENT DU 11 SEPTEMBRE 2026, AU SOIR. Thierry ouvre 50 dates sur un bien
// et 19 sur l'autre. Le coeur enregistre tout correctement. Les PRIX partent.
// La DISPONIBILITE, non — et chez Channex les dates restent `availability: 0`
// et `stop_sell: true` : **tarifees mais invendables**, sans le moindre signal.
// L'echec n'avait produit qu'un `pushWarnings.push('availability: HTTP ...')`,
// et le front n'affiche que `warnings[0]`.
//
// « Une erreur qui rend des dates tarifees mais invendables n'est pas un
// avertissement, c'est une panne » — la regle posee par Thierry, la meme que
// pour le cron qui rendait HTTP 200 en portant ses erreurs dans le corps.
//
// ⚠ ET LE CAS INVERSE CRIE AUSSI. Un `/restrictions` refuse pendant qu'un
// `/availability` passe est PIRE dans un sens : les dates s'ouvrent a la vente
// en gardant l'ANCIEN prix. C'est l'ecrasement du 10 septembre, par une autre
// porte. Les deux sens sont des pannes.
//
// ⚠ ET UNE FERMETURE QUI N'EST PAS PARTIE EST UNE SURRESERVATION EN ATTENTE :
// `/availability` porte aussi les mises a zero. Son echec n'est donc pas
// seulement « on ne vend pas », c'est aussi « on peut vendre deux fois ».
//
// Pure et exportee : c'est elle que le test tient.
function verdictPoussee (resultats) {
  const av = resultats.availability || null
  const re = resultats.restrictions || null
  const echecs = []
  if (av && av.tente && !av.ok) echecs.push({ appel: 'availability', status: av.status })
  if (re && re.tente && !re.ok) echecs.push({ appel: 'restrictions', status: re.status })
  if (!echecs.length) return { panne: false, echecs: [], type: null, message: null }

  const nomme = echecs.map(e => `${e.appel} (HTTP ${e.status})`).join(' et ')
  let consequence
  const availKO = echecs.some(e => e.appel === 'availability')
  const restKO = echecs.some(e => e.appel === 'restrictions')
  if (availKO && restKO) consequence = 'ni les disponibilites ni les tarifs ne sont arrives chez le canal'
  else if (availKO) consequence = 'les tarifs sont partis mais PAS les disponibilites : '
    + 'les dates ouvertes restent INVENDABLES, et une fermeture non partie peut laisser passer une surreservation'
  else consequence = 'les disponibilites sont parties mais PAS les tarifs : '
    + 'les dates peuvent s ouvrir a la vente A L ANCIEN PRIX'

  return {
    panne: true,
    echecs,
    type: 'poussee_calendrier_refusee',
    message: `Poussee refusee par le canal : ${nomme}. ${consequence}.`
  }
}

// ─── REACTION A UN REFUS ──────────────────────────────────────────────────
// Separee du handler pour etre tenue par un test : la lecon du 11 septembre au
// matin est qu'une fonction pure admirablement testee ne prouve rien si ce qui
// la CONSOMME ne l'est pas.
//
// `deps` permet au test d'injecter un double de `reportIncident` sans toucher
// au reseau. En production, l'import reel.
async function signalerPousseeRefusee (verdict, contexte, deps = {}) {
  if (!verdict || !verdict.panne) return { signale: false }
  const { warnings, userId, propertyId, propertyName, datesDisponibilite, datesTarifs } = contexte

  console.error(`[calendar] ${verdict.message} (bien ${propertyId})`)
  // EN TETE des avertissements : le front n'en montre qu'un, ce doit etre
  // celui-la et pas « 6 nuits deja vendues ».
  if (Array.isArray(warnings)) warnings.unshift(verdict.message)

  // ⚠ L'ALERTE NE DOIT PAS POUVOIR CASSER LA SAUVEGARDE. Les lignes sont deja
  // ecrites en base ; perdre la reponse HTTP ferait croire a l'hote que rien
  // n'a ete enregistre, et il recommencerait.
  try {
    const reporter = deps.reportIncident || require('./founder-notify').reportIncident
    await reporter(verdict.type, {
      userId,
      propertyId,
      propertyName,
      threshold: 1,
      detail: {
        message: verdict.message,
        echecs: verdict.echecs,
        dates_disponibilite: datesDisponibilite,
        dates_tarifs: datesTarifs
      }
    })
    return { signale: true }
  } catch (e) {
    console.error('[calendar] incident non remonte :', e.message)
    return { signale: false, erreur: e.message }
  }
}


// ─── L'ECRITURE D'UNE SAUVEGARDE DE CALENDRIER ────────────────────────────
// Ce que la porte a DEJA fait avant d'appeler : verifier les droits, resoudre
// le bien (avec TOUTES ses colonnes : rate_sync_mode, prix_minimum,
// inventory_units, provider_*, pilote_*), trier les segments (ceux de
// configuration du bien ne passent pas ici), et appliquer sa propre garde —
// pilote tarifaire cote hote, fenetre et fermetures cote moteur.
//
// @param dateSegments  [{ date_from, date_to, days?, rate?, avail?, stop_sell?,
//                        min_stay_arrival?, min_stay_through?, max_stay?, cta?, ctd? }]
//                      — `rate` en EUROS, comme le calendrier l'a toujours parle.
// @param origine       'host' | 'engine' — ce que le journal des prix retient.
// @param appel         (method, path, body) => { ok, status, json } — le canal.
// @returns { refus: { status, body } }
//        | { saved, pushed, localOnly, pushFailed, warnings, taskIds }
async function ecrireCalendrier ({ supabase, bien, compte, dateSegments, origine, appel }) {
  const bienId = bien.id
    const rowsByDate = {} // 'YYYY-MM-DD' -> partial fields (etat APRES fusion)
    // ⚠ L'ETAT *AVANT* ECRITURE, GARDE A PART.
    // `rowsByDate` est modifie juste apres par les segments : il portera l'etat
    // d'APRES. Pour savoir qu'une date vient de PASSER de fermee a ouverte —
    // donc que son tarif deja en base devient affiche — il faut les deux.
    const etatAvant = {}  // 'YYYY-MM-DD' -> ligne telle qu'elle etait EN BASE
    const gesteOuverture = {} // 'YYYY-MM-DD' -> { avail, stopSell } : ce que le geste touche

    // ─── PRIX PLANCHER : ON REFUSE A LA PORTE ────────────────────────────
    // ⚠ LA PREMIERE VERSION FERMAIT LA DATE, ET NE PROTEGEAIT RIEN.
    // Relevee en review : l'upsert de `calendar_inventory` a lieu AVANT la
    // construction de la charge ARI. Poser `stop_sell` dans cette charge
    // laissait donc la MEMOIRE d'intention a `false`, et `reaffirmerStopSell`
    // — qui relit cette memoire quelques lignes apres le push — repoussait
    // `stop_sell: false` dans la meme requete. La date se rouvrait sans tarif :
    // vente au prix de la GRILLE, exactement le defaut a fermer, pendant que
    // l'ecran affichait « ces dates sont fermees ». Un segment voisin portant
    // « Disponibilite : Ouvert » produisait le meme resultat, et le `continue`
    // faisait au passage tomber la disponibilite du segment refuse.
    //
    // Refuser AVANT toute ecriture supprime ces trois chemins d'un coup, et
    // respecte la regle du chantier stop_sell : la memoire d'intention
    // n'appartient qu'a l'hote — nous n'y ecrivons pas une fermeture qu'il n'a
    // pas demandee. Un tarif sous le plancher est une ERREUR DE SAISIE, pas un
    // etat a rattraper : on le dit, et rien ne bouge.
    const refuses = []
    let detailRefus = null
    for (const seg of dateSegments) {
      if (seg.rate == null) continue
      const cents = Math.round(Number(seg.rate) * 100)
      const verdict = tarifAcceptable(cents, bien)
      if (verdict.ok) continue
      refuses.push(...expandDays(seg.date_from, seg.date_to, seg.days))
      if (!detailRefus) detailRefus = { raison: verdict.raison, cents, plancher: verdict.plancher }
    }
    if (refuses.length) {
      console.log(`[calendar] REFUS prix plancher : ${refuses.length} date(s), ` +
        `${detailRefus.cents} centimes < ${detailRefus.plancher}`)
      // ⚠ LE MESSAGE LISIBLE VA DANS `error`, ET C'EST CE QUI COMPTE.
      // `shared/api-client.js` construit son exception avec `data.error` — pas
      // avec `data.message`. Mettre le code technique dans `error` affichait
      // « prix_sous_plancher » a l'hote, et mon explication restait dans un
      // champ que PERSONNE ne lit. Thierry a lu ce code et cru que sa saisie
      // avait abouti.
      return { refus: { status: 400, body: {
        error: messageRefus(detailRefus.raison, detailRefus.cents, detailRefus.plancher,
          refuses.length, 'saisie'),
        code: 'prix_sous_plancher',
        plancher_centimes: detailRefus.plancher,
        dates: refuses.slice(0, 20)
      } } }
    }

    const allDates = new Set()
    for (const seg of dateSegments) {
      for (const ds of expandDays(seg.date_from, seg.date_to, seg.days)) allDates.add(ds)
    }
    if (allDates.size) {
      // ⚠ CETTE LECTURE NE PEUT NI ECHOUER EN SILENCE, NI ETRE TRONQUEE.
      // Constat de review, 7 septembre 2026 — et c'est le plus dangereux des
      // deux foyers de cette journee.
      //
      // Les lignes relues ici sont la BASE de l'upsert plus bas. Si elles
      // manquent — erreur avalee, ou rendu tronque a 1000 lignes — chaque date
      // repart d'un objet nu `{ property_id, date }`, et l'upsert ECRIT NULL
      // par-dessus `stop_sell`, `rate`, `min_stay_*`, `cta`, `ctd`.
      //
      // Autrement dit : un hote qui ne modifie QUE le prix d'une periode
      // effacerait la fermeture qu'il avait memorisee dessus. C'est l'exact
      // contraire de la regle gravee au chantier audit — « seule une intention
      // volontaire de l'hote met a jour la memoire ». Un effacement silencieux
      // n'est pas une intention.
      //
      // On pagine ET on remonte l'erreur : mieux vaut un enregistrement refuse
      // qu'une intention perdue sans que personne ne le sache.
      const toutesDates = [...allDates]
      const PAGE = 500
      for (let i = 0; i < toutesDates.length; i += PAGE) {
        const { data: existingRows, error: exErr } = await supabase
          .from('calendar_inventory')
          .select('property_id, date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
          .eq('property_id', bienId)
          .in('date', toutesDates.slice(i, i + PAGE))
        if (exErr) {
          console.error('[calendar] relecture inventory echec', exErr.message)
          return { refus: { status: 503, body: { error: 'Enregistrement refuse : impossible de relire le calendrier existant' } } }
        }
        ;(existingRows || []).forEach(er => {
          rowsByDate[er.date] = { ...er }
          // Une COPIE, pas une reference : les segments modifient `rowsByDate`.
          etatAvant[er.date] = { ...er }
        })
      }
    }

    for (const seg of dateSegments) {
      const dates = expandDays(seg.date_from, seg.date_to, seg.days)
      for (const ds of dates) {
        if (!rowsByDate[ds]) rowsByDate[ds] = { property_id: bienId, date: ds }
        const r = rowsByDate[ds]
        if (seg.rate != null) r.rate = seg.rate
        // ⚠ « DISPONIBILITE : FERME » EST UNE INTENTION, PAS UN STOCK.
        // C'est le geste de fermeture le plus courant — et le SEUL disponible sur
        // le calendrier mobile, qui n'expose aucun controle « stop vente ». Il
        // n'ecrivait que `avail = 0`, donc la memoire d'intention restait a
        // `false` : la premiere annulation repoussait `availability: 1` et
        // reaffirmait activement `stop_sell: false`. La fermeture de l'hote
        // s'effacait toute seule.
        // `avail` reste ecrit — c'est la trace de la derniere valeur poussee — mais
        // la DECISION va desormais dans la colonne qui la porte.
        // ⚠ ON NOTE QUE CETTE DATE PORTE UNE DECISION DE DISPONIBILITE.
        // Le journal ne peut appeler « ouverture » qu'une date dont le geste
        // touche vraiment `avail` ou `stop_sell` : sans cela, regler un simple
        // sejour minimum sur une plage fabriquerait des « prix affiches » pour
        // des nuits que personne ne peut reserver (releve en review).
        if (seg.avail != null || seg.stop_sell != null) {
          const g = gesteOuverture[ds] || (gesteOuverture[ds] = { avail: false, stopSell: false })
          if (seg.avail != null) g.avail = true
          if (seg.stop_sell != null) g.stopSell = true
        }
        if (seg.avail != null) { r.avail = seg.avail; r.stop_sell = (seg.avail === 0) }
        // Un stop_sell explicite passe APRES : quand l'hote regle les deux, c'est
        // lui qui tranche.
        if (seg.stop_sell != null) r.stop_sell = seg.stop_sell
        if (seg.min_stay_arrival != null) r.min_stay_arrival = seg.min_stay_arrival
        if (seg.min_stay_through != null) r.min_stay_through = seg.min_stay_through
        if (seg.max_stay != null) r.max_stay = seg.max_stay
        if (seg.cta != null) r.cta = seg.cta
        if (seg.ctd != null) r.ctd = seg.ctd
      }
    }
    const rows = Object.values(rowsByDate).map(r => ({ ...r, updated_at: new Date().toISOString() }))

    if (rows.length) {
      const { error: upErr } = await supabase
        .from('calendar_inventory')
        .upsert(rows, { onConflict: 'property_id,date' })
      if (upErr) {
        console.error('[calendar] upsert error', upErr.message)
        return { refus: { status: 500, body: { error: 'Sauvegarde echouee' } } }
      }
    }

    // ---- 2) Push channel manager (ARI) ----
    // Necessite les ids channel. Si absents, on a quand meme sauve en base.
    const propId = bien.provider_property_id
    const ratePlanId = bien.provider_rate_plan_id
    const roomTypeId = bien.provider_room_type_id
    // ⚠ `echecConfig` est AJOUTE en fin de liste, pas en tete : les vues
    // n'affichent que warnings[0] dans le mode local_only, et le prendre en
    // premier faisait disparaitre l'explication « ce bien est gere par Beds24 ».
    let pushWarnings = []
    let pushed = false
    let localOnly = false
    // « Le canal a refuse quelque chose » : un drapeau, pas un texte a lire.
    let pousseeRefusee = false
    const taskIdsSave = {}

    // ⚠ `estRelieAuCanal` AVANT les ids : voir lib/rate-sync.js. Pendant la
    // migration, les ids sont ceux de la propriete CIBLE et `propId` la cle du
    // provider SOURCE — la poussee partirait avec une cle que la cible ignore.
    if (estRelieAuCanal(bien) && propId && ratePlanId) {
      // Push NATIVEMENT conforme ("only send changes" #13) : on source directement depuis
      // les segments edites, qui ne portent QUE les champs reellement touches. Aucun champ
      // non edite n'est emis. expandDays respecte le filtre jours -> la coalescence ne peut
      // pas reinclure de jour exclu. Pas de delta beforeByDate : l'intention utilisateur EST
      // le minimal a emettre. Accumulation PAR DATE (gere le chevauchement multi-segments).

      // 1) Accumulation par date des champs edites
      // extra_guest_fee stocke en unite majeure sur properties -> cents.
      const feeCentsCal = Math.round((Number(bien.extra_guest_fee) || 0) * 100)
      // Ce que la poussee a REELLEMENT donne — la matiere du verdict. Declare
      // ici parce que le plafonnement du stock, plus bas, peut deja constater
      // qu'une disponibilite ne partira pas.
      const resultatsPoussee = {}
      const restByDate = {}   // date -> objet restriction partiel (champs presents uniquement)
      // ⚠ LE PRIX EST CAPTE ICI, PAS RELU DANS `restByDate`.
      // Quand le bien a une tarification par occupation, `buildOccupancyRates`
      // pose `o.rates` (un tableau) et NE pose PAS `o.rate`. Relire `o.rate`
      // plus bas journaliserait donc `undefined` sur tous ces biens — soit
      // exactement ceux qui ont la tarification la plus fine, et sans la
      // moindre erreur. On retient le centime de base au moment ou on le
      // calcule. Journal des prix affiches : docs/kb/price-log.md.
      const prixParNuit = {}  // date -> rate en CENTIMES (prix de base)
      const availByDate = {}  // date -> availability (room_type)
      for (const seg of dateSegments) {
        const hasRest = seg.rate != null || seg.min_stay_arrival != null || seg.min_stay_through != null
          || seg.max_stay != null || seg.cta != null || seg.ctd != null || seg.stop_sell != null
        for (const ds of expandDays(seg.date_from, seg.date_to, seg.days)) {
          if (hasRest) {
            const o = restByDate[ds] || (restByDate[ds] = {})
            if (seg.rate != null) {
              const rateCents = Math.round(Number(seg.rate) * 100)
              // euros -> cents
              const occRates  = buildOccupancyRates(rateCents, bien.capacity, bien.included_guests, feeCentsCal)
              // occRates non-null -> rates[] par occupation ; null -> rate singulier (inchange).
              if (occRates) o.rates = occRates
              else          o.rate  = rateCents
              prixParNuit[ds] = rateCents
            }
            // ⚠ UNE NUIT FERMEE N'A JAMAIS ETE AFFICHEE.
            // L'hote peut poser un tarif ET fermer la date dans le meme geste.
            // Et juste apres, `reaffirmerStopSell` repousse l'intention
            // memorisee : une date deja fermee EN BASE repart fermee, meme si
            // le segment courant ne parle que de tarif. Journaliser son prix
            // ferait croire au moteur a une nuit proposee a 120 EUR pendant
            // trois mois, alors qu'aucun voyageur ne pouvait la reserver.
            //
            // ⚠ ON LIT L'ETAT EFFECTIF, PAS LE SEGMENT.
            // La premiere version ne regardait que `seg.stop_sell` / `seg.avail` :
            // changer le seul tarif d'une date DEJA fermee journalisait donc un
            // prix que personne ne pouvait voir. `rowsByDate` porte l'etat
            // fusionne — la ligne relue en base, plus les modifications du
            // segment — donc la verite de ce qui sera pousse.
            const etat = rowsByDate[ds]
            if (etat && (etat.stop_sell === true || etat.avail === 0)) delete prixParNuit[ds]
            if (seg.min_stay_arrival != null || seg.min_stay_through != null) {            // couplage miroir
              o.min_stay_arrival = seg.min_stay_arrival != null ? seg.min_stay_arrival : seg.min_stay_through
              o.min_stay_through = seg.min_stay_through != null ? seg.min_stay_through : seg.min_stay_arrival
            }
            if (seg.max_stay != null) o.max_stay = seg.max_stay
            if (seg.cta != null) o.closed_to_arrival = !!seg.cta
            if (seg.ctd != null) o.closed_to_departure = !!seg.ctd
            if (seg.stop_sell != null) o.stop_sell = !!seg.stop_sell
          }
          if (seg.avail != null) availByDate[ds] = seg.avail
        }
      }

      // 2) Restrictions : items tries par date -> coalescence (sig = champs+valeurs exacts)
      const restItems = Object.keys(restByDate).sort().map(d => ({
        date: d, sig: JSON.stringify(restByDate[d]),
        value: { property_id: propId, rate_plan_id: ratePlanId, ...restByDate[d] }
      }))

      // ⚠ OUVRIR UNE DATE DEJA TARIFEE, C'EST L'AFFICHER — lacune du
      // 12 septembre 2026, trouvee en verifiant le journal de Coeur de vie 23.
      //
      // Le point de capture ne voyait que les POUSSEES DE PRIX. Or une date
      // peut devenir affichee sans qu'un prix soit pousse : elle portait deja
      // un tarif en base — ecrit par un `runFullSync` ou une saisie
      // anterieure — et l'hote se contente de l'OUVRIR. Le prix devient alors
      // visible du voyageur (il etait deja dans la grille du provider) sans
      // qu'une ligne de journal existe.
      //
      // Constate : 14 nuits de week-end d'octobre et novembre portaient 110 ou
      // 130 EUR depuis le 10 septembre, etaient fermees lors de l'amorcage —
      // donc legitimement non amorcees, « une nuit fermee n'a jamais ete
      // affichee » — puis ont ete ouvertes le 12 au matin par un segment qui
      // ne portait que la disponibilite. Pour le moteur, ces nuits n'avaient
      // jamais eu de prix.
      //
      // Le journal ne se rattrape pas : chaque ouverture non captee est une
      // donnee perdue pour toujours.
      // La detection vit dans `lib/price-log.js` : c'est une regle du journal,
      // pas une regle du calendrier, et elle y est testable sans HTTP.
      const ouverturesTarifees = ouverturesDeDatesTarifees(etatAvant, rowsByDate, {
        gestes: gesteOuverture,      // sans geste explicite, rien n'est retenu
        dejaPousses: prixParNuit,
        basePrice: bien.base_price,
        bien                         // pour le plancher : sous `prix_minimum`,
      })                             // le full sync FERME la date, rien n'est affiche
      if (Object.keys(ouverturesTarifees).length) {
        console.log(`[calendar] journal des prix : ${Object.keys(ouverturesTarifees).length}`
          + ` date(s) ouverte(s) avec un tarif deja en base`)
      }

      // 3) Availability : items tries par date -> coalescence (room_type uniquement)
      //
      // ⚠ LE STOCK EST PLAFONNE ICI AUSSI, ET POUR LA MEME RAISON QU'AU FULL SYNC.
      // L'hote peut ouvrir une date depuis le calendrier (« Disponibilite :
      // Ouvert »). Si la nuit est deja vendue, la pousser ouverte ecrase la
      // decrementation du canal et produit une surreservation — que Channex
      // accepte. Le geste de l'hote reste respecte partout ailleurs : le
      // plafond ne peut que RETIRER du stock, jamais en ajouter.
      // Regle unique : docs/kb/synchronisation.md §8.
      // ─── TARIFER N'EST PAS OUVRIR — ET ON NE LE SUPPOSE PAS ──────────────
      // ⚠ REGLE CHANNEX « only send changes » (#13 de la certification),
      // rappelee par Thierry le 12 septembre 2026 : seuls les elements
      // REELLEMENT MODIFIES sont emis.
      //
      // J'avais d'abord complete `availability` pour toute date tarifee dont
      // l'intention etait ouverte. C'etait deux fautes en une : emettre un
      // champ non touche, et SUPPOSER que tarifer une nuit signifie vouloir la
      // vendre — alors qu'un hote prepare souvent ses prix a l'avance. C'est
      // le principe meme que ce chantier defend ailleurs : la memoire
      // d'intention n'appartient qu'a l'hote.
      //
      // On ne pousse donc rien de plus. Mais on le DIT : une nuit tarifee qui
      // reste fermee est invendable, et rien ne le signalait — l'ecran
      // affichait « Enregistre et publie » sur des dates que personne ne peut
      // reserver. L'hote ouvre lui-meme, d'un geste explicite.
      const tarifeesMaisFermees = []
      for (const ds of Object.keys(restByDate)) {
        if (prixParNuit[ds] == null) continue          // pas de tarif touche
        if (availByDate[ds] != null) continue          // l'hote a tranche
        const etat = rowsByDate[ds]
        if (etat && etat.stop_sell !== true && etat.avail !== 0) continue
        tarifeesMaisFermees.push(ds)
      }
      if (tarifeesMaisFermees.length) {
        const n = tarifeesMaisFermees.length
        pushWarnings.push(`${n} nuit${n > 1 ? 's' : ''} ${n > 1 ? 'ont' : 'a'} bien recu `
          + `${n > 1 ? 'leur' : 'son'} tarif mais reste${n > 1 ? 'nt' : ''} FERMEE${n > 1 ? 'S' : ''} `
          + `a la vente (${tarifeesMaisFermees.slice(0, 3).join(', ')}${n > 3 ? '…' : ''}). `
          + `Pour ${n > 1 ? 'les' : 'la'} mettre en vente, passez la disponibilite sur « Ouvert ».`)
      }

      const datesAvail = Object.keys(availByDate).sort()
      // ⚠ SANS room_type, LA DISPONIBILITE NE PEUT PAS PARTIR — et l'hote en a
      // demande une. Silence total avant la review : ni avertissement, ni
      // incident, alors que ses dates restent invendables chez le canal.
      if (datesAvail.length && !roomTypeId) {
        resultatsPoussee.availability = { tente: true, ok: false, status: 0 }
        pushWarnings.push('Disponibilites NON envoyees : ce logement n\'a pas de type de chambre '
          + 'chez le canal de distribution.')
      }
      // Sans room_type, `availItems` sera vide : rien ne partira, inutile de lire.
      if (datesAvail.length && roomTypeId) {
        const { nuitsOccupees } = require('./nuits-occupees')
        const unites = Math.max(1, Number(bien.inventory_units) || 1)
        try {
          const vendues = await nuitsOccupees(supabase, bien.provider_property_id,
            datesAvail[0], datesAvail[datesAvail.length - 1], { userId: bien.user_id })
          const plafonnees = []
          for (const d of datesAvail) {
            const stock = Math.max(0, unites - ((vendues[d] || []).length))
            if (availByDate[d] > stock) { availByDate[d] = stock; plafonnees.push(d) }
          }
          // Un avertissement PAR DATE noierait les autres : les vues n'affichent
          // que `warnings[0]`, et l'explication « ce bien est gere par Beds24 »
          // disparaitrait derriere trente lignes. Un compte agrege suffit.
          if (plafonnees.length) {
            pushWarnings.push(`${plafonnees.length} nuit(s) deja vendue(s) : leur stock n'a pas ete rouvert`
              + ` (${plafonnees.slice(0, 3).join(', ')}${plafonnees.length > 3 ? '…' : ''}).`)
          }
        } catch (e) {
          // ⚠ ON NE RETIRE QUE LES OUVERTURES, JAMAIS LES FERMETURES.
          // Ne pas savoir ce qui est vendu interdit d'OUVRIR, mais une fermeture
          // (`avail = 0`) ne peut produire aucune surreservation : la retirer
          // aussi ferait qu'une nuit fermee par l'hote ne partirait pas — et,
          // `datesTouchees` etant construit sur ces memes dates, `reaffirmerStopSell`
          // ne serait pas appele non plus. C'est la regression du 7 septembre.
          console.error('[calendar] stock non verifiable :', e.message)
          let retirees = 0
          for (const d of datesAvail) {
            if (availByDate[d] > 0) { delete availByDate[d]; retirees++ }
          }
          if (retirees) {
            // ⚠ UNE OUVERTURE RETIREE EST UNE POUSSEE QUI N'ARRIVE PAS.
            // Releve en review : ce repli produit EXACTEMENT l'etat redoute —
            // les prix partent, les ouvertures non, donc des dates tarifees et
            // invendables — sans qu'aucun POST n'ait ete refuse. Le verdict ne
            // jugeait que les appels partis : il ne voyait rien.
            resultatsPoussee.availability = { tente: true, ok: false, status: 0 }
            pushWarnings.push(`${retirees} ouverture(s) non poussee(s) : impossible de verifier les nuits deja vendues.`
              + ' Les fermetures, elles, sont bien parties.')
          }
        }
      }

      const availItems = roomTypeId
        ? Object.keys(availByDate).sort().map(d => ({
            date: d, sig: String(availByDate[d]),
            value: { property_id: propId, room_type_id: roomTypeId, availability: availByDate[d] }
          }))
        : []

      const restrictionValues = coalesceRanges(restItems)
      const availabilityValues = coalesceRanges(availItems)

      try {
        // ⚠ ORDRE : AVAILABILITY D'ABORD, RESTRICTIONS ENSUITE.
        // Un POST /availability leve le stop_sell des dates touchees (mesure du
        // 7 septembre 2026). Pousser les restrictions en premier, comme on le
        // faisait, revenait a poser le stop-sell puis a l'effacer soi-meme dans
        // la foulee. C'est l'ordre de lib/channel-fullsync.js, et le seul correct.
        // Availability : TOUJOURS poussee (anti-surbooking, non negociable), quel que soit le mode.
        if (await pousserAri({
          availabilityValues,
          restrictionValues,
          pousserLesTarifs: canPushRates(bien),
          appel,
          resultats: resultatsPoussee,
          warnings: pushWarnings,
          taskIds: taskIdsSave
        })) pushed = true

        // ⚠ RESTITUTION DE L'INTENTION MEMORISEE, quel que soit le mode.
        // Le bloc ci-dessus ne suffit pas : en mode 'keep' il ne part rien, et meme
        // en 'managed' il ne porte que les dates dont l'hote a touche une
        // restriction. Une edition de la seule ligne « Disponibilite » sur des
        // dates fermees les rouvrirait donc en silence — le geste exact qui a
        // rendu quatre nuits vendables le 7 septembre. Les lignes viennent d'etre
        // ecrites en base : la memoire porte deja la nouvelle volonte de l'hote.
        // Sur l'UNION des dates touchees, pas seulement celles qui portent une
        // disponibilite : en mode `keep` le bloc restrictions ne part pas du tout,
        // et fermer des dates y laissait l'hote devant un « enregistre » alors que
        // rien n'etait parti aux plateformes.
        const datesTouchees = [...new Set([...Object.keys(availByDate), ...Object.keys(restByDate)])].sort()
        if (datesTouchees.length && ratePlanId) {
          await reaffirmerStopSell(
            { id: bienId, user_id: compte, provider_rate_plan_id: ratePlanId },
            propId, datesTouchees[0], datesTouchees[datesTouchees.length - 1], 'calendar',
            new Set(datesTouchees)
          )
        }

      } catch (e) {
        console.error('[calendar] push channel error', e.message)
        pushWarnings.push('push: ' + e.message)
      }

      // ─── JOURNAL DES PRIX AFFICHES (YieldFlow etape 1) ────────────────────
      // docs/specs/spec-yieldflow-v1.md §4 — docs/kb/price-log.md
      //
      // ⚠ HORS DU `try` DE LA POUSSEE, ET C'EST LE POINT.
      // Releve en review : ce bloc etait dans le meme `try` que
      // `reaffirmerStopSell`, qui fait un appel reseau non protege (l'en-tete
      // de `pousserAri` le dit : « le channelCall de ce fichier ne protege pas
      // son fetch »). Un ECONNRESET pendant la reaffirmation sautait au `catch`
      // et le journal n'etait jamais ecrit — alors que `/restrictions` avait
      // rendu ok et que les prix ETAIENT partis aux plateformes. L'echec d'une
      // etape ulterieure ne doit pas effacer la mesure d'une etape reussie.
      //
      // ⚠ SEULEMENT SI LES TARIFS SONT REELLEMENT PARTIS.
      //   - mode « HoteSmart gere mes prix » : en `keep`, rien ne part ;
      //   - `/restrictions` ok : un refus laisse l'ANCIEN prix chez l'OTA ;
      //   - au moins un prix a journaliser.
      // Le journal dit ce que le VOYAGEUR a vu, pas ce que l'hote a voulu.
      // ⚠ DIAGNOSTIC PERMANENT, ET IL N'EST PAS DE TROP.
      // Le 12 septembre 2026, trois prix reels sont partis aux plateformes sans
      // que le journal n'ecrive une ligne. Writer, lecture des nuits occupees,
      // deploiement : tout a ete verifie bon. Impossible de trancher a distance
      // QUEL terme de la condition etait faux — parce qu'aucun des trois
      // n'etait journalise. Un `if` muet sur un chemin non retroactif est une
      // perte definitive : on dit desormais pourquoi on n'ecrit pas.
      // ⚠ UN `if` MUET SUR UN CHEMIN NON RETROACTIF EST UNE PERTE DEFINITIVE.
      // Le journal ne se rattrape pas : une non-ecriture silencieuse perd le
      // prix pour toujours. On dit donc POURQUOI on n'ecrit pas, a chaque fois.
      // ⚠ CHAQUE ORIGINE CONTRE LE FLUX QUI LA PORTE, ET CONTRE CE QUI EST
      // REELLEMENT PARTI. La composition vit dans `lib/price-log.js` : c'est
      // une regle du journal, et elle y est testable sans HTTP.
      //
      // `availByDate` est passe APRES le plafonnement : c'est la que les
      // ouvertures retirees (nuit deja vendue, ou stock non verifiable)
      // disparaissent. Sans ce filtre, `availability.ok` — qui est vrai des
      // qu'un appel HTTP aboutit, meme s'il ne portait qu'une FERMETURE —
      // faisait journaliser des nuits restees fermees chez le provider.
      const aJournaliser = nuitsAJournaliser({
        prixPousses: prixParNuit,
        ouvertures: ouverturesTarifees,
        resultats: resultatsPoussee,
        availEnvoyees: availByDate
      })

      if (!(Object.keys(aJournaliser).length && canPushRates(bien))) {
        console.log('[calendar] journal des prix NON ecrit :', JSON.stringify({
          tarifs_pousses: Object.keys(prixParNuit).length,
          ouvertures_tarifees: Object.keys(ouverturesTarifees).length,
          gestes_disponibilite: Object.keys(gesteOuverture).length,
          retenues: Object.keys(aJournaliser).length,
          managed: canPushRates(bien),
          restrictions: resultatsPoussee.restrictions || null,
          availability: resultatsPoussee.availability || null
        }))
      }

      if (Object.keys(aJournaliser).length && canPushRates(bien)) {
        try {
          // ⚠ UNE NUIT DEJA VENDUE N'EST PLUS AFFICHEE — releve en review.
          // L'index unique partiel autorise une ligne courante A COTE d'une
          // ligne vendue. Sans ce filtre, modifier le tarif d'une plage
          // englobant une nuit vendue ouvrirait une courante neuve, et la nuit
          // redeviendrait « affichee, jamais vendue » pour le moteur — alors
          // qu'elle est occupee et que son stock est a zero.
          // Lecture propre : `vendues`, calcule plus haut, est local au bloc de
          // plafonnement et ne couvre que les dates portant une disponibilite.
          const datesPrix = Object.keys(aJournaliser).sort()
          const unitesBien = Math.max(1, Number(bien.inventory_units) || 1)
          const { nuitsOccupees: occupees } = require('./nuits-occupees')
          // ⚠ `compte`, PAS `bien.user_id` — LE DEFAUT DU 12 SEPTEMBRE 2026.
          // `bien` vient d'un SELECT qui ne porte pas `user_id` : la valeur
          // etait `undefined`, `nuitsOccupees` levait « userId requis », et mon
          // `catch` avalait l'exception dans un `console.error` invisible. Trois
          // prix reels sont partis aux plateformes sans etre journalises, et il
          // a fallu remonter l'erreur dans la reponse HTTP pour la voir.
          // `compte` est le compte PROPRIETAIRE resolu par la garde — c'est
          // celui que la ligne suivante utilise deja pour ecrire.
          const dejaVendues = await occupees(supabase, bien.provider_property_id,
            datesPrix[0], datesPrix[datesPrix.length - 1], { userId: compte })
          let retirees = 0
          for (const d of datesPrix) {
            if ((dejaVendues[d] || []).length >= unitesBien) { delete aJournaliser[d]; retirees++ }
          }
          if (retirees) console.log(`[calendar] journal des prix : ${retirees} nuit(s) vendue(s) ecartee(s)`)
          if (!Object.keys(aJournaliser).length) throw new Error('__rien_a_journaliser__')

          const bilanJournal = await enregistrerPrixPousses(supabase, {
            userId: compte,
            propertyId: bienId,          // UUID : le journal est cle sur properties.id
            nuits: aJournaliser,
            source: origine              // 'host' par la porte HTTP, 'engine' par le canal interne
          })
          console.log('[calendar] journal des prix', JSON.stringify(bilanJournal))
        } catch (e) {
          if (e.message === '__rien_a_journaliser__') {
            console.log('[calendar] journal des prix : aucune nuit a journaliser apres filtrage')
          } else {
          // Le journal ne fait JAMAIS echouer la poussee : le prix EST parti,
          // c'est la mesure qui a manque. Rendre une erreur ferait croire a
          // l'hote que ses prix ne sont pas partis, donc les repousser, donc
          // ecraser. On perd une ligne de journal, jamais une vente — mais on
          // le dit fort, parce qu'un journal muet est un journal faux.
          console.error('[calendar] JOURNAL DES PRIX NON ECRIT :', e.message)
          }
        }
      }

      // ⚠ UN REFUS DU CANAL EST UNE PANNE, PAS UN AVERTISSEMENT.
      // Voir l'en-tete de `verdictPoussee`. Le 11 septembre 2026, un
      // `/availability` refuse n'a produit qu'une ligne dans `pushWarnings`,
      // le front n'affiche que `warnings[0]`, et 69 dates sont restees
      // tarifees mais INVENDABLES sans que personne ne le sache.
      const verdict = verdictPoussee(resultatsPoussee)
      if (verdict.panne) pousseeRefusee = true
      await signalerPousseeRefusee(verdict, {
        warnings: pushWarnings,
        userId: compte,
        propertyId: propId,
        propertyName: bien.name,
        // ⚠ PAS `datesTouchees` : il est declare avec `const` DANS le `try`,
        // donc hors de portee ici. Ces deux tableaux-la sont declares avant.
        datesDisponibilite: availabilityValues.length,
        datesTarifs: restrictionValues.length
      })
    } else {
      // Aucun id canal (rate plan) -> rien n'est pousse. Message hote explicite : pour un
      // bien Beds24, l'hote doit editer ses prix/sejours min DANS Beds24 (source cote OTA).
      localOnly = true
      if (bien.provider === 'beds24') {
        // Ce message redevient atteignable pour les biens en cours de migration :
        // ils portent des ids de canal, mais leurs prix vivent encore chez Beds24.
        pushWarnings.push('Enregistré dans HôteSmart — ce bien est géré par Beds24 : modifiez prix et séjour minimum directement dans Beds24, ils ne sont pas envoyés aux plateformes depuis ici.')
      } else {
        pushWarnings.push('Bien non connecté au canal de distribution — modifications enregistrées dans HôteSmart uniquement, non envoyées aux plateformes.')
      }
    }


  return {
    saved: rows.length,
    pushed,
    localOnly,
    pushFailed: pousseeRefusee,
    warnings: pushWarnings,
    taskIds: taskIdsSave
  }
}

module.exports = {
  ecrireCalendrier,
  expandDays,
  toLocalISO,
  coalesceRanges,
  pousserAri,
  verdictPoussee,
  signalerPousseeRefusee
}
