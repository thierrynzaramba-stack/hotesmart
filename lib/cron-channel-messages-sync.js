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

// ⚠ LE CRON DEDIE A SES PROPRES BUDGETS, ET C'EST TOUT L'INTERET.
// Dans le cycle principal, l'import se contente de ce qui reste apres les codes
// d'acces : 8 s pour tout le parc, donc 2,5 s par bien au mieux — mesure du
// 15 septembre 2026, aucun bien n'aboutissait et deux n'etaient meme pas
// appeles. Seul, il dispose des 60 s de sa fonction : on en garde 15 de marge
// pour la reponse et les ecritures d'etat.
// ⚠ ON NE TOUCHE PAS A `BUDGET_MS`. Il borne l'import dans le CYCLE PRINCIPAL,
// ou la contrainte reste entiere tant que l'import y figure : le relever
// prendrait le temps des codes d'acces. Deux contextes, deux budgets.
// ⚠ 30 s, PAS 45 — MESURE EN REEL LE 16 SEPTEMBRE 2026. Avec 45 s de parc sous
// un `maxDuration` de 60, le cron est mort en `FUNCTION_INVOCATION_TIMEOUT` : la
// marge de 15 s ne suffisait pas, parce que le budget n'etait pas consulte DANS
// le lot de messages (il l'est maintenant) et parce que `channelCall` peut
// dormir sur un `Retry-After` sans plafond. Une fonction qui meurt ne rend pas
// son bilan ET n'ecrit pas l'etat du bien en cours : c'est pire qu'un budget
// trop court, qui lui laisse au moins une trace.
const BUDGET_PARC_DEDIE_MS = 30000
const BUDGET_BIEN_DEDIE_MS = 12000
// En deca de ce reliquat, on ne commence meme pas : entamer une passe qu'on sait
// devoir interrompre coute des appels provider pour rien.
const RELIQUAT_MINIMAL_MS = 800
// Trois abstentions d'affilee sur le meme bien = ce n'est plus un cycle charge,
// c'est un etat. On le dit.
const ABSTENTIONS_AVANT_INCIDENT = 3

// ⚠ TOUS LES COMBIEN ON REDIT QU'UN IMPORT EST BLOQUE. Une alarme qui ne parle
// qu'une fois laisse une panne s'installer en silence : c'est ce qui est arrive
// pendant 125 cycles.
// ⚠ PAS EXACTEMENT UNE HEURE. Douze cycles de cinq minutes tombent PILE sur la
// fenetre anti-spam de `reportIncident` (une heure, comparaison `gte`) : selon
// la gigue du cron, l'e-mail serait parti une fois sur deux, au hasard. Treize
// cycles passent franchement la borne, et le rappel devient deterministe.
const RAPPEL_TOUS_LES = 13
// Au-dela, l'ecriture est « de masse » et s'annonce avant d'ecrire.
const ANNONCE_A_PARTIR_DE = 50

// ⚠ UNE ABSTENTION ATTENDUE N'EST PAS UNE ALERTE — ET LE NIVEAU DE LOG EST CE
// QUI LE DIT AU RESTE DU MONDE (17 septembre 2026).
//
// Vercel etiquette « error » toute invocation qui ECRIT SUR STDERR, quel que
// soit le statut HTTP. `console.warn` y va. Or une abstention pour `budget` ou
// `cycle_en_retard` est le fonctionnement NORMAL d'un rattrapage a point de
// reprise : elle se produit a CHAQUE cycle tant que le fil est plus long que le
// budget, par construction. Le cron dedie ressortait donc en « error » a chaque
// passage pendant un rattrapage qui se deroulait exactement comme prevu.
//
// Le cout n'est pas cosmetique : une alarme toujours allumee est une alarme
// morte. Le jour ou ce cron tombe vraiment, plus rien ne le distingue dans la
// liste — c'est la meme mecanique que les huit tests rouges permanents du
// CLAUDE.md, et que l'incident meme que ce fichier documente, ou « l'alerte la
// plus bruyante etait la moins informative ».
//
// On garde donc `warn` pour ce qui est ANORMAL, et on passe en `log` ce qui est
// prevu. Le contenu du journal ne change pas d'un caractere : c'est le NIVEAU
// qui portait une information fausse.
const MOTIFS_ATTENDUS = new Set(['budget', 'cycle_en_retard'])

function marqueurDe (userId, propId) { return `messages_import:${userId}:${propId}` }

// Etat par bien : `last_run` porte le marqueur d'anteriorite (jusqu'ou on a
// importe), `total_messages` le nombre d'abstentions CONSECUTIVES. Detournement
// assume d'une colonne existante, comme le fait deja `messages_classify_cursor`.
async function lireEtat (supabase, cle) {
  const { data, error } = await supabase
    // ⚠ `errors` EST DANS LE SELECT, ET SON ABSENCE RENDAIT TOUT LE CORRECTIF
    // INERTE. PostgREST ne renvoie que les colonnes DEMANDEES : `data.errors`
    // valait `undefined`, donc le point de reprise ecrit au cycle precedent
    // n'etait JAMAIS relu. Le fil repartait de sa page 1, l'annonce de masse
    // repartait a chaque cycle — exactement le defaut qu'on croyait corriger,
    // avec un incident de plus par heure en prime. Trouve en review.
    .from('cron_logs').select('last_run, total_messages, errors').eq('id', cle).maybeSingle()
  if (error) {
    // ⚠ UNE LECTURE EN ECHEC N'EST PAS « JAMAIS IMPORTE ». Retomber sur `null`
    // relancerait un import COMPLET du bien — des centaines d'ecritures, et
    // l'alerte de croissance avec. On s'abstient, le cycle suivant reessaiera.
    console.error('[msg-sync] etat illisible, abstention :', error.message)
    return { illisible: true }
  }
  // ⚠ `errors` PORTE LE POINT DE REPRISE. Detournement assume d'une colonne
  // existante, comme `last_run` porte deja le marqueur d'anteriorite : la
  // colonne est un tableau JSON libre, et le cron n'y a jamais rien ecrit
  // d'autre. La forme est `[{ fil, page }]` — un tableau, parce que c'est ce que
  // la colonne accepte.
  const brut = Array.isArray(data?.errors) ? data.errors[0] : null
  // ⚠ `count` TRAVERSE L'ALLER-RETOUR, et sans lui la garde du fil change serait
  // morte : le provider refuse d'appliquer un offset si le `message_count` du
  // fil a bouge, et un `count` perdu en base vaut « inconnu », donc « on repart
  // de la page 1 ». La garde serait alors toujours en echec, et la reprise ne
  // servirait jamais.
  const reprise = brut && brut.fil
    ? { fil: String(brut.fil), page: Number(brut.page) || 1,
        count: Number.isFinite(Number(brut.count)) ? Number(brut.count) : null }
    : null
  return { depuis: data?.last_run || null,
           abstentions: Number(data?.total_messages) || 0,
           reprise,
           dernierMotif: brut && brut.motif ? String(brut.motif) : null }
}

// ⚠ LE MOTIF EST ENREGISTRE, ET IL NE L'ETAIT PAS. Diagnostiquer le blocage du
// 15 septembre 2026 a demande de DEDUIRE pourquoi l'import s'abstenait : l'etat
// ne gardait que le COMPTE des abstentions, jamais leur raison. 125 abstentions
// d'affilee, et rien en base ne disait si c'etait le budget, le provider ou un
// cycle en retard. Une panne qui dure doit dire de quoi elle est faite.
async function ecrireEtat (supabase, cle, { depuis, abstentions, reprise = null, motif = null }) {
  const { error } = await supabase.from('cron_logs').upsert({
    id: cle, last_run: depuis, total_messages: abstentions, total_replies: 0,
    // ⚠ UN POINT DE REPRISE S'EFFACE QUAND LA PASSE ABOUTIT. Le garder ferait
    // rejouer a jamais un fil deja importe.
    errors: (reprise && reprise.fil) || motif
      ? [{ ...(reprise && reprise.fil
            ? { fil: String(reprise.fil), page: Number(reprise.page) || 1,
                count: Number.isFinite(Number(reprise.count)) ? Number(reprise.count) : null }
            : {}),
           ...(motif ? { motif: String(motif), le: new Date().toISOString() } : {}) }]
      : []
  })
  if (error) console.error('[msg-sync] etat non enregistre :', error.message)
}

// Une abstention, comptee — et signalee si elle s'installe.
// ⚠ CE QUI DISTINGUE UNE FILE QUI AVANCE D'UNE FILE BLOQUEE, C'EST LE PROGRES —
// PAS LE NOMBRE DE TOURS (17 septembre 2026).
//
// Le compteur comptait les abstentions CONSECUTIVES, quelles qu'elles soient. Or
// un rattrapage sur un fil plus long que le budget s'abstient a CHAQUE cycle,
// par construction : des le 3e, l'alerte `messages_import_suspendu` partait en
// disant « Import des messages suspendu » alors que `r.imported > 0` et que le
// point de reprise avait avance a chaque passe. C'est litteralement faux, et
// c'est l'alarme recue sur Colomiers pendant que l'import CONVERGEAIT.
//
// Une abstention qui a fait avancer les choses n'est pas un blocage. Le compteur
// repart donc de zero des qu'il y a progres — messages ecrits, OU point de
// reprise deplace. Ce qu'il mesure desormais : « combien de cycles d'affilee
// rien n'a bouge », qui est la question qu'on croyait deja poser.
//
// ⚠ ET C'EST CE QUI SAUVE LE SIGNAL. Le blocage de 125 cycles etait exactement
// un non-progres repete : la reprise etait rejetee, les memes 22 fils relus, zero
// message ecrit. Il aurait declenche l'alerte au 3e cycle comme avant. On n'a
// pas rendu une panne silencieuse : on a cesse d'appeler panne un travail qui
// avance.
// ⚠ « DIFFERENT » N'EST PAS « AVANCE », et la premiere version confondait les
// deux : `a.page !== b.page` rendait vrai pour un RECUL. Or le recul est la
// signature meme du blocage qu'on veut garder audible — `reprise ecartee` jette
// le point de reprise et le fil repart de sa page 1, donc le cycle suivant coupe
// plus BAS qu'avant. La page oscillait, chaque oscillation passait pour un
// progres, le compteur restait a zero, et le journal affichait « ca AVANCE »
// pendant que rien n'entrait. On aurait remplace une alarme qui crie au loup par
// une alarme qui ne crie jamais — strictement pire.
//
// ⚠ ET `imported > 0` NE SUFFIT PAS SEUL. C'est une somme SUR TOUT LE BIEN : un
// fil coince derriere le budget ne converge jamais, mais la moindre reponse
// ecrite depuis l'app OTA pendant le cycle la fait remonter. Plus le bien est
// actif, plus l'alarme devient impossible. Il ne vaut donc que comme APPOINT,
// jamais contre un recul.
//
// Ce qui compte comme progres, et rien d'autre :
//   — meme fil, page STRICTEMENT plus haute ;
//   — meme fil, meme page, ET des messages ecrits (le budget coupe A
//     L'INTERIEUR d'une page depuis d67c3b7 : la reprise ne bouge pas, le
//     travail avance quand meme) ;
//   — fil different ET des messages ecrits (sans ecriture, un fil qui derive
//     d'un cycle a l'autre est la derive elle-meme, pas un progres).
function aProgresse (etat, reprise, imported) {
  const a = etat.reprise, b = reprise
  if (!b) return false
  // ⚠ ETAT INCONNU N'EST PAS PROGRES. `ecrireEtat` avale son echec : si l'upsert
  // est refuse, `etat.reprise` est nul a CHAQUE lecture, et un `!a -> true`
  // rendait le bien « en progres » pour toujours — en affirmant l'inverse de la
  // verite, dans le journal cense la dire.
  if (!a) return false
  if (String(a.fil) !== String(b.fil)) return imported > 0
  const pa = Number(a.page) || 0, pb = Number(b.page) || 0
  if (pb < pa) return false          // recul : jamais.
  if (pb > pa) return true           // avance franche.
  return imported > 0                // meme page, mais du travail a ete ecrit.
}

async function sAbstenir (supabase, { cle, etat, bien, motif, results, reprise = null,
                                      imported = 0 }) {
  const progres = aProgresse(etat, reprise, imported)
  const posee = reprise || etat.reprise || null
  const abstentions = progres ? 0 : (etat.abstentions || 0) + 1
  // ⚠ UNE ABSTENTION GARDE LE POINT DE REPRISE. Sans lui, l'import repart de la
  // page 1 du fil a chaque cycle : sur un fil plus long que le budget, il
  // n'atteint JAMAIS la fin. C'est le blocage mesure en production le
  // 15 septembre 2026 — 125 abstentions d'affilee, marqueur a `null`.
  await ecrireEtat(supabase, cle, { depuis: etat.depuis || null, abstentions,
                                    reprise: posee, motif })
  results.messagesImportAbstentions = (results.messagesImportAbstentions || 0) + 1
  // ⚠ LE MOTIF PRECEDENT ET LE POINT DE REPRISE SONT DITS. Un champ enregistre
  // et jamais relu est un champ mort : c'est ce journal qui rendra le prochain
  // diagnostic lisible sans avoir a deduire.
  // ⚠ LE NIVEAU SUIT LE PROGRES, PAS LE NOMBRE DE TOURS. Un seuil brut rendait le
  // correctif INERTE sur le cas qui l'a motive : un rattrapage a point de reprise
  // s'abstient a chaque cycle, donc des le 3e il repassait sur `stderr` pour tout
  // le reste du rattrapage — c'est-a-dire l'essentiel de sa duree. Puisque le
  // compteur ne monte plus quand ca avance, il redit ce qu'il faut : `abstentions`
  // non nul signifie « rien n'a bouge depuis autant de cycles ».
  const attendue = MOTIFS_ATTENDUS.has(motif) && abstentions < ABSTENTIONS_AVANT_INCIDENT
  const dire = attendue ? console.log : console.warn
  dire(`[msg-sync] abstention (${motif}) sur ${bien.provider_property_id}, `
    + (progres ? 'mais ca AVANCE (compteur remis a zero)' : `${abstentions} d'affilee`)
    + (etat.dernierMotif && etat.dernierMotif !== motif ? ` — precedent : ${etat.dernierMotif}` : '')
    // ⚠ LA POSITION QU'ON VIENT D'ECRIRE, pas celle d'avant. Le journal affichait
    // `etat.reprise` — la position PRECEDENTE — donc sur un cycle qui avance il
    // disait « ca AVANCE » puis montrait la page d'ou l'on venait. Dans un diff
    // dont tout l'objet est de rendre ce journal lisible, c'etait le seul chiffre
    // faux.
    + (posee ? ` — reprise : fil ${posee.fil} page ${posee.page}` : ''))

  // ⚠ A L'EGALITE, PUIS PERIODIQUEMENT — ET LA SECONDE MOITIE MANQUAIT.
  // « Une seule fois quand l'etat s'installe » a produit exactement l'inverse
  // de ce qu'on voulait : l'incident est parti au 3e cycle, puis PLUS JAMAIS,
  // pendant que l'import restait bloque 125 cycles. Le seul signal encore audible
  // etait le preavis d'ecriture de masse, qui ne dit rien du blocage. L'alerte
  // la plus bruyante etait la moins informative, et l'informative s'etait tue.
  // L'anti-spam horaire de `reportIncident` borne le reste.
  if (abstentions === ABSTENTIONS_AVANT_INCIDENT ||
      (abstentions > ABSTENTIONS_AVANT_INCIDENT && abstentions % RAPPEL_TOUS_LES === 0)) {
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
async function importerMessagesDuBien (supabase, bien, { echeance, results = {},
                                                        budgetBienMs = BUDGET_MS } = {}) {
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

  const reste = echeance ? echeance - Date.now() : budgetBienMs
  if (reste < RELIQUAT_MINIMAL_MS) {
    return sAbstenir(supabase, { cle, etat, bien, motif: 'cycle_en_retard', results })
  }

  const r = await getProvider('channex').importMessages({
    userId: bien.user_id,
    propertyId: propId,
    depuis: etat.depuis,
    reprise: etat.reprise || null,
    echeance: Date.now() + Math.min(reste, budgetBienMs),
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
    // Passe tronquee : le marqueur d'ANTERIORITE ne bouge pas — des fils ont pu
    // etre sautes — mais le POINT DE REPRISE, lui, est enregistre. C'est la
    // difference entre « on recommencera » et « on reprendra », et c'est elle
    // qui manquait : sans point de reprise, un fil plus long que le budget n'est
    // jamais importe, quel que soit le nombre de cycles.
    results.messagesImportes = (results.messagesImportes || 0) + (r.imported || 0)
    // ⚠ `imported` EST TRANSMIS, et c'est lui qui evite l'alerte au loup. Sans
    // lui, `sAbstenir` ne peut pas distinguer « le budget a coupe apres 300
    // messages ecrits » de « le budget a coupe sans rien ecrire ».
    return sAbstenir(supabase, { cle, etat, bien, motif: r.interrompu || 'budget', results,
                                 reprise: r.reprise || null, imported: r.imported || 0 })
  }

  // Passe complete : le marqueur avance, le compteur d'abstentions repart a zero.
  // Passe complete : le marqueur avance, le compteur repart a zero, et le point
  // de reprise est EFFACE.
  await ecrireEtat(supabase, cle, { depuis: r.jusqua || etat.depuis, abstentions: 0, reprise: null })
  results.messagesImportes = (results.messagesImportes || 0) + (r.imported || 0)
  if (r.imported) {
    console.log(`[msg-sync] ${bien.name || propId} : ${r.imported} message(s) importe(s), `
      + `${r.fils?.lus ?? '?'} fil(s) relus sur ${r.fils?.vus ?? '?'}`)
  }
  return { abstenu: false, imported: r.imported || 0, fils: r.fils }
}

module.exports = {
  importerMessagesDuBien,
  MOTIFS_ATTENDUS,
  aProgresse,
  ordonnerPourImport,
  marqueurDe,
  BUDGET_MS,
  BUDGET_PARC_DEDIE_MS,
  BUDGET_BIEN_DEDIE_MS,
  RELIQUAT_MINIMAL_MS,
  ABSTENTIONS_AVANT_INCIDENT,
  RAPPEL_TOUS_LES,
  ANNONCE_A_PARTIR_DE
}
