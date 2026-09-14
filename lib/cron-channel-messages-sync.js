// lib/cron-channel-messages-sync.js
// IMPORT RECURRENT DES MESSAGES CHANNEX — les reponses ecrites par l'hote.
//
// ⚠ LE DEFAUT QUE CE MODULE FERME, MESURE LE 14 SEPTEMBRE 2026.
// `importMessages` est le SEUL chemin qui rapporte les messages dont
// `sender !== 'guest'` — donc ce que l'hote ecrit depuis l'app Airbnb. Il ne
// tournait qu'a l'activation du canal et pendant une fenetre de 30 min
// (`cron-channel-messages-backfill.js`), qui pose ensuite `messages_backfilled`
// et l'arrete DEFINITIVEMENT. En regime courant, seul le webhook alimentait
// `messages`, et il n'apporte que l'entrant.
// Mesure sur Ofuro Futari : 21 messages entrants, ZERO sortant, jamais.
// Consequence : l'agent IA lisait un fil ampute des reponses de l'hote et
// pouvait repondre une seconde fois au meme voyageur.
//
// ⚠ TROIS EXIGENCES DE THIERRY, ET ELLES VIENNENT TOUTES DU 10 SEPTEMBRE.
// Ce jour-la, un `ReferenceError` dans le premier appel d'un `try` commun a
// emporte `processArrivalCodes` pendant 24 h : plus aucun code d'acces cree,
// une voyageuse devant une porte fermee.
//   1. L'import passe APRES les codes d'acces dans l'ordre du cycle.
//   2. Il a son PROPRE `try` : une panne de l'import ne doit jamais emporter
//      ce qui suit, jamais couter un code d'acces.
//   3. S'il s'abstient, ca doit SE VOIR. Muet cote voyageur, compte cote
//      exploitation — sinon c'est encore une panne qui dort.
//
// COUT MESURE (4 biens, 45 fils) : import complet = 49 appels, 3,9 s.
// En incremental, lister coute UN appel par bien (~300 ms pour le parc) et on
// ne va chercher que les fils dont `updated_at` a bouge — zero a deux par
// cycle en regime courant.

const { getProvider } = require('./channels')
const { reportIncident } = require('./founder-notify')

// Budget mur par BIEN. Le cycle plafonne a 60 s et tourne deja entre 40 et 56 :
// l'import ne prend que ce qui reste, et rend la main plutot que de mordre sur
// ce qui suit.
const BUDGET_MS = 2500
// En deca de ce reliquat, on ne commence meme pas : entamer une passe qu'on sait
// devoir interrompre coute des appels provider pour rien.
const RELIQUAT_MINIMAL_MS = 800
// Trois abstentions d'affilee sur le meme bien = ce n'est plus un cycle charge,
// c'est un etat. On le dit.
const ABSTENTIONS_AVANT_INCIDENT = 3
// Au-dela, l'ecriture est « de masse » et s'annonce avant d'ecrire.
const ANNONCE_A_PARTIR_DE = 50

function marqueurDe (userId, propId) { return `messages_import:${userId}:${propId}` }

// Etat par bien : `last_run` porte le marqueur d'anteriorite (jusqu'ou on a
// importe), `total_messages` le nombre d'abstentions CONSECUTIVES. Detournement
// assume d'une colonne existante, comme le fait deja `messages_classify_cursor`.
async function lireEtat (supabase, cle) {
  const { data, error } = await supabase
    .from('cron_logs').select('last_run, total_messages').eq('id', cle).maybeSingle()
  if (error) {
    // ⚠ UNE LECTURE EN ECHEC N'EST PAS « JAMAIS IMPORTE ». Retomber sur `null`
    // relancerait un import COMPLET du bien — des centaines d'ecritures, et
    // l'alerte de croissance avec. On s'abstient, le cycle suivant reessaiera.
    console.error('[msg-sync] etat illisible, abstention :', error.message)
    return { illisible: true }
  }
  return { depuis: data?.last_run || null, abstentions: Number(data?.total_messages) || 0 }
}

async function ecrireEtat (supabase, cle, { depuis, abstentions }) {
  const { error } = await supabase.from('cron_logs').upsert({
    id: cle, last_run: depuis, total_messages: abstentions, total_replies: 0, errors: []
  })
  if (error) console.error('[msg-sync] etat non enregistre :', error.message)
}

// Une abstention, comptee — et signalee si elle s'installe.
async function sAbstenir (supabase, { cle, etat, bien, motif, results }) {
  const abstentions = (etat.abstentions || 0) + 1
  await ecrireEtat(supabase, cle, { depuis: etat.depuis || null, abstentions })
  results.messagesImportAbstentions = (results.messagesImportAbstentions || 0) + 1
  console.warn(`[msg-sync] abstention (${motif}) sur ${bien.provider_property_id}, ${abstentions} d'affilee`)

  if (abstentions === ABSTENTIONS_AVANT_INCIDENT) {
    // ⚠ A L'EGALITE, PAS AU-DELA : l'incident part UNE fois quand l'etat
    // s'installe, pas a chaque cycle ensuite. L'anti-spam de `reportIncident`
    // est d'une heure ; ici on veut un seul signal par installation.
    try {
      await reportIncident('messages_import_suspendu', {
        userId: bien.user_id,
        propertyId: String(bien.provider_property_id),
        propertyName: bien.name || null,
        detail: {
          message: `Import des messages suspendu depuis ${abstentions} cycles (${motif}). `
            + `Les reponses ecrites depuis l'app OTA n'entrent plus dans le coeur : `
            + `l'agent IA travaille sur un fil ampute et peut repondre deux fois.`,
          motif, abstentions
        }
      })
    } catch (e) { console.error('[msg-sync] incident non enregistre :', e.message) }
  }
  return { abstenu: true, motif }
}

// ORDRE D'IMPORT : CELUI QU'ON A LE MOINS SERVI PASSE DEVANT.
//
// ⚠ BLOQUANT 4, RELEVE EN REVIEW. L'echeance etait posee AVANT la boucle par
// bien : elle mesurait donc le CYCLE, pas l'import. Le travail metier de chaque
// bien (templates, classification, `fetchChannelBookings`, codes Seam) la
// consommait, et des le 2e ou 3e bien il ne restait rien -> abstention
// `cycle_en_retard` a CHAQUE cycle. Au troisieme, un incident partait ; ensuite
// plus rien, et les messages des derniers biens n'etaient JAMAIS importes.
// L'ordre de `props` n'etant pas garanti par le SELECT, ce n'etaient meme pas
// toujours les memes biens.
//
// Deux correctifs, et il faut les deux : une echeance propre a la PHASE
// d'import (dans cron-channel-props), et cet ordre. Sans l'ordre, le bien en
// fin de liste resterait le sacrifie permanent des cycles charges.
//
// ⚠ UNE SEULE REQUETE POUR TOUT LE PARC. Lire le marqueur bien par bien pour
// les trier couterait ce que le tri fait economiser.
// ⚠ ET UNE LECTURE EN ECHEC NE REORDONNE RIEN : l'ordre d'origine est rendu tel
// quel. Inventer un ordre sur une lecture ratee reintroduirait, en silence,
// l'inequite que ce tri existe pour supprimer.
async function ordonnerPourImport (supabase, biens) {
  const cles = (biens || []).map(b => marqueurDe(b.user_id, b.provider_property_id))
  if (!cles.length) return biens || []

  const { data, error } = await supabase.from('cron_logs').select('id, last_run').in('id', cles)
  if (error) {
    console.warn('[msg-sync] marqueurs illisibles, ordre d origine conserve :', error.message)
    return biens
  }
  const vuLe = new Map((data || []).map(r => [r.id, r.last_run || null]))
  // Jamais importe (`null`) d'abord, puis du plus ancien au plus recent.
  return [...biens].sort((a, b) => {
    const ta = vuLe.get(marqueurDe(a.user_id, a.provider_property_id))
    const tb = vuLe.get(marqueurDe(b.user_id, b.provider_property_id))
    if (!ta && !tb) return 0
    if (!ta) return -1
    if (!tb) return 1
    return String(ta).localeCompare(String(tb))
  })
}

// Import d'UN bien. Rend toujours un objet — une abstention est un resultat,
// pas une panne.
async function importerMessagesDuBien (supabase, bien, { echeance, results = {} } = {}) {
  const propId = String(bien.provider_property_id)
  const cle = marqueurDe(bien.user_id, propId)
  const etat = await lireEtat(supabase, cle)
  if (etat.illisible) {
    // ⚠ ON N'ECRIT RIEN DU TOUT — BLOQUANT 3, RELEVE EN REVIEW.
    // Ma version precedente appelait `sAbstenir` avec un etat force a
    // `{ depuis: null }`, et l'upsert PERSISTAIT donc `last_run: null` : un
    // timeout de pooler d'une seconde effacait le marqueur, et le cycle suivant
    // repartait d'un import COMPLET du bien — avec l'alerte de croissance en
    // prime. Le commentaire de `lireEtat`, deux ecrans plus haut, disait
    // pourtant exactement ce qu'il ne fallait pas faire.
    // Et `abstentions: 0` en dur gelait le compteur a 1 : l'incident
    // `messages_import_suspendu`, declenche a l'egalite avec 3, ne pouvait
    // JAMAIS partir sur ce motif. L'etat le plus silencieux etait celui qui ne
    // s'annoncait pas.
    //
    // Quand on ne sait pas ou on en est, on ne DIT PAS ou on en est. Le cycle
    // suivant relira.
    results.messagesImportAbstentions = (results.messagesImportAbstentions || 0) + 1
    console.warn(`[msg-sync] abstention (etat_illisible) sur ${propId} — aucun etat ecrit`)
    return { abstenu: true, motif: 'etat_illisible' }
  }

  const reste = echeance ? echeance - Date.now() : BUDGET_MS
  if (reste < RELIQUAT_MINIMAL_MS) {
    return sAbstenir(supabase, { cle, etat, bien, motif: 'cycle_en_retard', results })
  }

  const r = await getProvider('channex').importMessages({
    userId: bien.user_id,
    propertyId: propId,
    depuis: etat.depuis,
    echeance: Date.now() + Math.min(reste, BUDGET_MS),
    // ⚠ L'ANNONCE PREALABLE (regle du 14 septembre). Une ecriture de masse
    // deliberee previent AVANT d'ecrire, sinon l'alerte `table_growth` arrive
    // sans son explication et devient indiscernable d'une boucle d'ecriture.
    avantEcriture: async ({ fils, messages }) => {
      if (messages < ANNONCE_A_PARTIR_DE) return
      await reportIncident('ecriture_de_masse_annoncee', {
        userId: bien.user_id,
        propertyId: propId,
        propertyName: bien.name || null,
        detail: {
          message: `Import des messages annonce sur ${bien.name || propId} : `
            + `~${messages} messages sur ${fils} fil(s). Croissance ATTENDUE, `
            + `ce n'est PAS une boucle d'ecriture.`,
          fils, messages_attendus: messages
        }
      })
    }
  })

  if (r?.error) {
    return sAbstenir(supabase, { cle, etat, bien, motif: 'provider_' + r.error, results })
  }
  if (r?.interrompu) {
    // Passe tronquee : le marqueur ne bouge PAS (des fils ont pu etre sautes),
    // et c'est une abstention partielle — comptee comme telle.
    return sAbstenir(supabase, { cle, etat, bien, motif: 'budget', results })
  }

  // Passe complete : le marqueur avance, le compteur d'abstentions repart a zero.
  await ecrireEtat(supabase, cle, { depuis: r.jusqua || etat.depuis, abstentions: 0 })
  results.messagesImportes = (results.messagesImportes || 0) + (r.imported || 0)
  if (r.imported) {
    console.log(`[msg-sync] ${bien.name || propId} : ${r.imported} message(s) importe(s), `
      + `${r.fils?.lus ?? '?'} fil(s) relus sur ${r.fils?.vus ?? '?'}`)
  }
  return { abstenu: false, imported: r.imported || 0, fils: r.fils }
}

module.exports = {
  importerMessagesDuBien,
  ordonnerPourImport,
  marqueurDe,
  BUDGET_MS,
  RELIQUAT_MINIMAL_MS,
  ABSTENTIONS_AVANT_INCIDENT,
  ANNONCE_A_PARTIR_DE
}
