// lib/cron-overbooking.js
// DOC : docs/kb/reservation-directe.md (modif = MEME COMMIT)
//
// Detection des surreservations et ALARME RECURRENTE.
// Spec : docs/specs/spec-reservation-manuelle.md §4 (amendement du 6 sept 2026).
//
// Le verrou (lib/reservation-directe.js) est la defense ; ceci est le FILET.
// Il attrape ce que le verrou ne peut pas voir :
//   - deux OTA qui vendent la meme nuit avant que la fermeture ne se propage,
//   - une reservation entree par un chemin qui ignore le verrou,
//   - une modification de dates qui recouvre un sejour existant.
// TOUTES ORIGINES, donc : la detection lit le cœur, pas un provider.
//
// ⚠ POURQUOI UNE ALARME QUI NE SE TAIT PAS TOUTE SEULE
// Tout le reste de l'alerting porte un anti-spam (1 alerte par type et par bien
// toutes les 6 h) : une alerte qui se repete lasse, et une alerte qui lasse finit
// ignoree. La surreservation est le SEUL incident du produit qui ne se rattrape
// pas apres coup — deux voyageurs devant la meme porte le meme soir. Elle a donc
// la semantique inverse : elle reemet jusqu'a ce qu'un humain l'acquitte
// explicitement. C'est reserve a cette gravite, precisement pour que le jour ou
// elle crie, on la lise.

const { supabase } = require('./cron-shared')
const { envoyerAlerteBrute } = require('./founder-notify')
const { sendPlatformEmail } = require('./platform-notify')
const { sendSms } = require('../api/sms')
const { nuits } = require('./reservation-directe')
const { readStatus, STATUS } = require('./bookings-snapshot-status')

// Periode de reemission de l'alarme tant qu'elle n'est pas acquittee.
const RELANCE_MS = Number(process.env.OVERBOOKING_RELANCE_MS ?? 45 * 60 * 1000)  // 45 min

// Fenetre examinee : le passe lointain n'interesse personne (le mal est fait et
// le sejour est termine), mais on garde une marge arriere pour attraper un
// chevauchement qui commence aujourd'hui.
const JOURS_ARRIERE = 2
const JOURS_AVANT = 365

// Profondeur de lecture des incidents : au-dela, un acquittement est trop ancien
// pour valoir consentement — si le conflit dure encore, il merite qu'on le
// redise. Large, car un sejour se reserve des mois a l'avance.
const FENETRE_INCIDENTS_MS = 120 * 24 * 60 * 60 * 1000   // 120 jours

const jour = (decalage) => {
  const d = new Date()
  d.setDate(d.getDate() + decalage)
  return d.toISOString().slice(0, 10)
}

// ─── Detection ───────────────────────────────────────────────────────────────
// Rend une liste de conflits : { userId, propertyId, nuit, occupants, unites }.
// Un conflit par NUIT surchargee — c'est la granularite de la regle.
async function detecterSurreservations () {
  const debut = jour(-JOURS_ARRIERE)
  const fin = jour(JOURS_AVANT)

  // ⚠ PAGINE. PostgREST plafonne a 1 000 lignes : au-dela, les biens manquants
  // tomberaient dans le `console.warn('bien inconnu')` plus bas et leurs
  // surreservations ne seraient JAMAIS detectees — un echec silencieux sur
  // precisement l'alarme qui ne doit pas etre ratee.
  let biens = []
  let deB = 0
  for (;;) {
    const { data, error: eBiens } = await supabase
      .from('properties')
      .select('user_id, provider_property_id, name, inventory_units')
      .order('id')
      .range(deB, deB + 999)
    if (eBiens) throw new Error(`lecture properties : ${eBiens.message}`)
    biens = biens.concat(data || [])
    if (!data || data.length < 1000) break
    deB += 1000
  }

  // ⚠ Indexe sur user_id|property_id : `provider_property_id` n'a aucune unicite
  // globale, deux hotes peuvent porter le meme identifiant provider.
  const parBien = {}
  for (const b of biens || []) {
    parBien[`${b.user_id}|${String(b.provider_property_id)}`] = b
  }

  let snaps = []
  let de = 0
  for (;;) {
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('user_id, property_id, booking_id, snapshot')
      .gte('snapshot->>departure', debut)
      .lte('snapshot->>arrival', fin)
      // ⚠ TRI SUR LA CLE COMPLETE : l'unicite est (user_id, booking_id), pas
      // booking_id seul (cf. onConflict du writer). Sur une egalite en frontiere
      // de page, Postgres pourrait rendre deux fois la meme ligne — un snapshot
      // duplique compterait deux fois sur ses nuits et fabriquerait un conflit
      // FANTOME, donc une alarme qui ne s'eteint jamais d'elle-meme.
      .order('user_id').order('booking_id')
      .range(de, de + 999)
    if (error) throw new Error(`lecture bookings_snapshot : ${error.message}`)
    snaps = snaps.concat(data || [])
    if (!data || data.length < 1000) break
    de += 1000
  }

  // Occupation par bien et par nuit.
  const occupation = {}
  for (const s of snaps) {
    const snap = s.snapshot || {}
    if (readStatus(snap, snap.provider) !== STATUS.CONFIRMED) continue
    const cle = `${s.user_id}|${String(s.property_id)}`
    for (const n of nuits(snap.arrival, snap.departure)) {
      if (n < debut || n > fin) continue
      occupation[cle] = occupation[cle] || {}
      occupation[cle][n] = occupation[cle][n] || []
      occupation[cle][n].push(String(s.booking_id))
    }
  }

  const conflits = []
  for (const [cle, nuitsBien] of Object.entries(occupation)) {
    const bien = parBien[cle]
    // Un snapshot sans bien correspondant ne peut pas etre juge : on ne connait
    // pas son nombre d'unites. On le signale plutot que de deviner 1.
    if (!bien) { console.warn(`[overbooking] bien inconnu pour ${cle}, ignore`); continue }
    const unites = Math.max(1, Number(bien.inventory_units) || 1)
    for (const [nuit, bookings] of Object.entries(nuitsBien)) {
      if (bookings.length > unites) {
        conflits.push({
          userId: bien.user_id,
          propertyId: String(bien.provider_property_id),
          propertyName: bien.name,
          nuit,
          occupants: bookings.sort(),
          unites
        })
      }
    }
  }
  return conflits
}

// ─── Regroupement ────────────────────────────────────────────────────────────
// Une alarme par BIEN, pas par nuit : cinq nuits qui se chevauchent sur le meme
// bien sont un seul probleme, et cinq SMS repetes toutes les 45 minutes seraient
// exactement le bruit qu'on veut eviter.
function regrouper (conflits) {
  const par = {}
  for (const c of conflits) {
    const cle = `${c.userId}|${c.propertyId}`
    par[cle] = par[cle] || { ...c, nuits: [], bookings: new Set() }
    par[cle].nuits.push(c.nuit)
    c.occupants.forEach(b => par[cle].bookings.add(b))
  }
  return Object.values(par).map(g => ({
    ...g,
    nuits: g.nuits.sort(),
    bookings: [...g.bookings].sort()
  }))
}

// ─── Signature d'un conflit ──────────────────────────────────────────────────
// « J'ai vu CE conflit-la » : l'acquittement porte sur un etat precis, pas sur le
// bien en general. Si les nuits ou les reservations en cause changent, c'est un
// probleme NOUVEAU et l'alarme doit repartir. Signature stable : nuits et
// reservations triees.
function signature (g) {
  return `${g.nuits.slice().sort().join(',')}|${g.bookings.slice().sort().join(',')}`
}

// ─── Alarme recurrente ───────────────────────────────────────────────────────
// Un incident par bien. Tant qu'il est OUVERT (acquitted_at IS NULL) :
//   - il n'est PAS duplique (on met a jour celui qui existe),
//   - il RELANCE toutes les RELANCE_MS,
//   - seul un acquittement manuel l'arrete.
// Quand la surreservation disparait (annulation, dates deplacees), l'incident est
// referme automatiquement : le probleme n'existe plus, l'alarme n'a plus d'objet.
//
// ⚠ L'ACQUITTEMENT DOIT FAIRE TAIRE, PAS ACCELERER.
// Premiere version : on ne chargeait que les incidents ouverts. Une fois acquitte,
// le bien n'avait plus d'incident « existant » — le cycle suivant (5 min) en
// creait donc un neuf et CRIAIT immediatement. Cliquer « J'ai vu » faisait
// arriver le SMS suivant en 5 minutes au lieu de 45 : l'exact inverse du besoin,
// et le contraire de ce que promettaient le bouton et toute la documentation.
// On charge donc AUSSI les incidents acquittes recents : tant que le conflit
// garde la meme signature, on se tait.
async function traiterAlarmes (groupes, results = null) {
  const bilan = { conflits: groupes.length, ouverts: 0, relances: 0, refermes: 0, tus: 0, erreurs: 0 }
  const maintenant = Date.now()

  // ⚠ TOUS les incidents OUVERTS sont charges, sans borne de date : un conflit sur
  // un sejour reserve des mois a l'avance et jamais acquitte doit rester connu,
  // sinon on inserait un doublon et l'ancien resterait ouvert pour toujours (deux
  // bandeaux au dashboard, deux lignes jamais refermees). Seuls les ACQUITTES
  // sont bornes dans le temps : au-dela, un acquittement est trop ancien pour
  // valoir consentement.
  const incidents = []
  let deI = 0
  for (;;) {
    const { data, error } = await supabase
      .from('automation_incidents')
      .select('id, user_id, property_id, detail, last_alerted_at, created_at, acquitted_at, acquitted_by')
      .eq('type', 'overbooking')
      .or(`acquitted_at.is.null,created_at.gte.${new Date(maintenant - FENETRE_INCIDENTS_MS).toISOString()}`)
      .order('created_at')
      .range(deI, deI + 999)
    if (error) throw new Error(`lecture automation_incidents : ${error.message}`)
    incidents.push(...(data || []))
    if (!data || data.length < 1000) break
    deI += 1000
  }

  // Ouverts d'un cote, acquittes de l'autre : les premiers relancent, les seconds
  // font taire tant que le conflit n'a pas change.
  const parCle = {}
  const acquittes = {}
  for (const i of incidents || []) {
    const cle = `${i.user_id}|${String(i.property_id)}`
    if (i.acquitted_at) {
      // ⚠ SEUL UN ACQUITTEMENT HUMAIN FAIT TAIRE (`acquitted_by` renseigne).
      // La fermeture automatique (conflit disparu) pose aussi `acquitted_at`,
      // mais sans auteur. La confondre avec un « vu » rendrait l'alarme
      // DEFINITIVEMENT muette sur ce scenario : conflit detecte -> reservation
      // annulee -> incident auto-ferme -> l'annulation revient en `confirmed`
      // (modification OTA) -> meme signature -> silence, alors que personne n'a
      // jamais rien vu.
      if (!i.acquitted_by) continue
      // On garde le plus RECENT : c'est lui qui dit ce que l'humain a vu en dernier.
      const p = acquittes[cle]
      if (!p || new Date(i.acquitted_at) > new Date(p.acquitted_at)) acquittes[cle] = i
    } else {
      // Le plus ANCIEN ouvert fait foi : s'il en existe deux (doublon d'une
      // version anterieure), on relance sur celui-la et on laisse l'autre etre
      // referme par la boucle de nettoyage.
      if (!parCle[cle]) parCle[cle] = i
    }
  }

  for (const g of groupes) {
    const cle = `${g.userId}|${g.propertyId}`
    const existant = parCle[cle]

    // Deja acquitte, et RIEN N'A CHANGE depuis : on se tait. L'humain a vu ce
    // conflit-la. Une nuit de plus ou une reservation differente rouvre l'alarme.
    if (!existant) {
      const vu = acquittes[cle]
      if (vu && vu.detail?.signature === signature(g)) {
        bilan.tus++
        delete parCle[cle]
        continue
      }
    }

    const detail = {
      message: `SURRESERVATION sur « ${g.propertyName} » : ${g.nuits.length} nuit(s) au-dela de ${g.unites} unite(s) — ${g.nuits.join(', ')}. Reservations en cause : ${g.bookings.join(', ')}.`,
      nuits: g.nuits, bookings: g.bookings, unites: g.unites,
      signature: signature(g)
    }

    // ⚠ RETIRE DE `parCle` AVANT le try. Si le traitement echoue (coupure DB),
    // laisser la cle dedans ferait fermer l'alarme par la boucle de nettoyage
    // ci-dessous — une erreur transitoire eteindrait une surreservation bien
    // vivante. Ce qui reste dans `parCle` doit signifier « conflit disparu », et
    // rien d'autre.
    delete parCle[cle]

    try {
      if (!existant) {
        // Premiere detection : on cree l'incident ET on alerte.
        const { error: eIns } = await supabase
          .from('automation_incidents')
          .insert({
            type: 'overbooking', user_id: g.userId, property_id: g.propertyId,
            detail, alerted: true, last_alerted_at: new Date(maintenant).toISOString()
          })
        if (eIns) throw new Error(eIns.message)
        await crier(g, detail, 'nouvelle')
        bilan.ouverts++
      } else {
        // Deja ouvert : on relance si le delai est ecoule. `alerted` reste vrai,
        // et surtout l'anti-spam habituel ne s'applique PAS ici.
        const dernier = existant.last_alerted_at ? new Date(existant.last_alerted_at).getTime() : 0
        if (maintenant - dernier >= RELANCE_MS) {
          // ⚠ L'ERREUR EST TESTEE : supabase-js ne jette pas, il rend { error }.
          // Si `last_alerted_at` n'est pas ecrit apres l'envoi, la relance repart
          // a CHAQUE tick de 5 min au lieu de 45 — un SMS toutes les cinq minutes
          // jusqu'a ce que la base reponde.
          const { error: eMaj } = await supabase.from('automation_incidents')
            .update({ detail, last_alerted_at: new Date(maintenant).toISOString() })
            .eq('id', existant.id)
          if (eMaj) throw new Error(eMaj.message)
          await crier(g, detail, 'relance')
          bilan.relances++
        } else {
          // Toujours ouvert, pas encore l'heure de relancer : on rafraichit le
          // detail (les nuits ont pu changer) sans crier.
          const { error: eDet } = await supabase.from('automation_incidents')
            .update({ detail }).eq('id', existant.id)
          if (eDet) throw new Error(eDet.message)
        }
      }
    } catch (e) {
      bilan.erreurs++
      console.error('[overbooking] traitement echec', cle, e.message)
    }
  }

  // Ce qui reste dans parCle : des incidents ouverts dont la surreservation a
  // disparu. On les referme — l'alarme n'a plus d'objet, et la laisser crier
  // apprendrait a l'ignorer.
  for (const [cle, inc] of Object.entries(parCle)) {
    const { error: eMaj } = await supabase.from('automation_incidents')
      .update({ acquitted_at: new Date(maintenant).toISOString(), acquitted_by: null })
      .eq('id', inc.id)
    if (eMaj) { bilan.erreurs++; console.error('[overbooking] fermeture echec', cle, eMaj.message) }
    else { bilan.refermes++; console.log(`[overbooking] resolu, alarme eteinte : ${cle}`) }
  }

  if (results) results.overbooking = bilan
  return bilan
}

// ⚠ ON N'UTILISE PAS `reportIncident` ICI, ET C'EST ESSENTIEL.
// Il insere une ligne a CHAQUE appel — il dupliquerait donc l'incident que ce
// module tient deja ouvert — et il se tait si une alerte du meme (type, bien) est
// partie dans l'heure, ce qui eteindrait exactement la relance qu'on veut voir
// insister. `envoyerAlerteBrute` n'envoie que le message : la persistance et le
// cycle de vie restent ici, ou ils sont visibles.
//
// ⚠ ON PREVIENT L'HOTE, PAS SEULEMENT LE FONDATEUR.
// Premiere version : l'alarme ne partait qu'au canal fondateur, alors que le
// bouton d'acquittement est filtre sur le proprietaire du bien. Le fondateur
// recevait donc un SMS toutes les 45 minutes sans pouvoir l'eteindre, et l'hote
// avait le bouton sans jamais etre averti : le cycle « crier jusqu'a
// acquittement » ne pouvait pas se boucler.
// L'hote est prevenu EN PREMIER — c'est lui qui agit, lui qui acquitte — et le
// fondateur reste en copie, pour la supervision.
// ⚠ LE TITULAIRE SE RECONNAIT A `is_owner`, PAS A UN `member_user_id` NUL.
// Premiere version : `.is('member_user_id', null)`. C'est FAUX et dangereux — un
// `member_user_id` nul designe un acces PAR LIEN (une prestataire de menage) ou
// une invitation non acceptee. Le SMS de surreservation, qui porte le nom du bien
// et les identifiants des reservations en cause, serait donc parti chez la
// prestataire toutes les 45 minutes, tandis que l'hote — seul a pouvoir
// acquitter — n'aurait jamais rien recu.
// Le titulaire porte `member_user_id = account_user_id` ET `is_owner = true`
// (migration 2026-09-01-profils-et-droits-structures.sql), et c'est le filtre
// utilise partout ailleurs dans le depot.
async function contactHote (userId) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('first_name, phone, email')
      .eq('account_user_id', userId)
      .eq('is_owner', true)
      .limit(1)
      .maybeSingle()
    // ⚠ L'erreur est TESTEE : une lecture en echec rendrait `null`, indiscernable
    // de « cet hote n'a pas de contact » — et l'alarme partirait en silence au
    // seul fondateur, qui ne peut pas l'acquitter.
    if (error) { console.error('[overbooking] lecture profil titulaire echec', error.message); return null }
    return data || null
  } catch (e) {
    console.error('[overbooking] contact hote illisible', e.message)
    return null
  }
}

async function crier (g, detail, phase) {
  const prefixe = phase === 'relance' ? 'RELANCE — ' : ''
  const texte = `HoteSmart ALERTE — ${prefixe}SURRESERVATION\n${g.propertyName}\n${detail.message}\nOuvrez HoteSmart pour arreter cette alerte.`.slice(0, 300)

  // 1. L'hote : c'est lui qui peut acquitter.
  //
  // ⚠ SMS SUR LA CLE DE L'HOTE (`sendSms`), PAS SUR LA CLE PLATEFORME.
  // lib/platform-notify.js est reserve au canal FONDATEUR ; docs/kb/alertes.md
  // rappelle qu'aucun SMS n'est inclus ni facture par HoteSmart. Repete toutes
  // les 45 minutes, par conflit et par hote, un envoi plateforme serait un cout
  // non borne — et ce module en aurait ete le premier appelant du depot.
  // L'email, lui, reste plateforme : c'est le canal de service, sans coût unitaire.
  try {
    const hote = await contactHote(g.userId)
    if (hote?.phone) await sendSms(hote.phone, texte, g.propertyId, 'overbooking', g.userId)
    if (hote?.email) {
      await sendPlatformEmail(hote.email, `[HôteSmart] ${prefixe}Surréservation — ${g.propertyName}`,
        `<h3>Surréservation détectée</h3><p><strong>${g.propertyName}</strong></p><p>${detail.message}</p>`
        + `<p style="color:#c0392b">Cette alerte se répète jusqu'à ce que vous l'acquittiez depuis votre tableau de bord.</p>`)
    }
    if (!hote?.phone && !hote?.email) {
      console.warn('[overbooking] aucun contact pour l\'hote', g.userId, '— seul le fondateur est prevenu')
    }
  } catch (e) {
    console.error('[overbooking] alerte hote non envoyee', e.message)
  }

  // 2. Le fondateur, en supervision.
  try {
    await envoyerAlerteBrute('overbooking', {
      propertyId: g.propertyId,
      propertyName: g.propertyName,
      detail,
      prefixe
    })
  } catch (e) {
    console.error('[overbooking] alerte fondateur non envoyee', e.message)
  }
}

// ─── Cadence ─────────────────────────────────────────────────────────────────
// ⚠ PAS A CHAQUE TICK DE 5 MIN. Cette sonde scanne bookings_snapshot en entier
// (plus toutes les properties), avec un filtre sur `snapshot->>departure` que
// AUCUN index ne sert : 288 scans complets par jour, places avant le dispatch
// dont ils mangeraient le budget des 60 s. Meme mecanique que checkTableGrowth
// (1x/h) : un marqueur dans cron_logs porte la cadence.
//
// 15 minutes : une surreservation ne se resout pas en cinq minutes, et l'alarme
// relance de toute facon toutes les 45. Trois passages par relance suffisent
// largement a ne rien manquer.
const CADENCE_MS = Number(process.env.OVERBOOKING_CADENCE_MS ?? 15 * 60 * 1000)
const MARQUEUR = 'overbooking_probe'

async function cadenceEcoulee () {
  const { data } = await supabase
    .from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
  if (data?.last_run && (Date.now() - new Date(data.last_run).getTime()) < CADENCE_MS) return false
  // ⚠ Les colonnes annexes sont passees explicitement (comme tous les autres
  // marqueurs du depot) pour couvrir un eventuel NOT NULL, et l'erreur est TESTEE :
  // un upsert en echec non vu ferait tourner le scan complet a CHAQUE tick de
  // 5 minutes au lieu de 15 — precisement le cout que cette cadence evite, et
  // sans aucune trace.
  const { error } = await supabase.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date().toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (error) {
    console.error('[overbooking] marqueur de cadence non ecrit, passage saute :', error.message)
    return false      // plutot sauter un passage que scanner a chaque tick
  }
  return true
}

// ─── Point d'entree du cycle ─────────────────────────────────────────────────
// Fail-safe : une exception ici ne doit pas faire tomber le cron.
async function checkOverbooking (results = null) {
  try {
    if (!(await cadenceEcoulee())) return null
    const conflits = await detecterSurreservations()
    const groupes = regrouper(conflits)
    if (!groupes.length) {
      // Rien a signaler — mais il reste peut-etre des alarmes a eteindre.
      return await traiterAlarmes([], results)
    }
    console.warn(`[overbooking] ${groupes.length} bien(s) en surreservation`)
    return await traiterAlarmes(groupes, results)
  } catch (e) {
    console.error('[overbooking] exception', e.message)
    if (results) results.errors = (results.errors || []).concat([{ etape: 'overbooking', error: e.message }])
    return null
  }
}

module.exports = {
  detecterSurreservations,
  regrouper,
  traiterAlarmes,
  checkOverbooking,
  signature,
  RELANCE_MS,
  CADENCE_MS
}
