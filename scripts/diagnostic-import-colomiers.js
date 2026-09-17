// scripts/diagnostic-import-colomiers.js
//
// INCIDENT IMPORT DES MESSAGES OTA — DIAGNOSTIC, LECTURE SEULE.
//
// Contexte : `api/cron-messages.js` (commits d86e107, 1f1763e, d67c3b7) est le
// cron dedie a l'import HISTORIQUE des messages OTA — les reponses ecrites
// depuis l'app Booking/Airbnb, que le webhook ne voit jamais. Trois biens ont
// converge le 16 septembre 2026 ; Colomiers, non.
//
// ⚠ CE SCRIPT N'ECRIT RIEN, ET N'APPELLE AUCUN PROVIDER.
// Pas d'insert, pas d'update, pas d'upsert, pas de `getProvider`. Il ne fait que
// LIRE, et il est lançable a n'importe quel moment sans consequence — y compris
// pendant un passage du cron.
//
// ⚠ CE QU'IL NE DIT PAS, ET POURQUOI. Il ne donne AUCUN nombre de « messages
// restant a importer ». Ce nombre n'est pas derivable en lecture seule, et une
// premiere version le calculait quand meme — a tort, de trois facons a la fois :
//   1. `messages_attendus` de l'annonce prealable ne somme que les fils de la
//      PAGE de listing en cours (`lib/channels/channex.js`), pas le bien ;
//   2. l'annonce n'est emise QU'UNE FOIS, au demarrage d'un lot, et JAMAIS sur
//      une reprise (`if (!annonceFaite && !reprise …)`) — donc sur Colomiers,
//      qui reprend depuis des cycles, elle est perimee ;
//   3. la soustraire a un compte de lignes GLOBAL et ACTUEL melange deux
//      perimetres et deux instants : le resultat pouvait etre INFERIEUR au vrai
//      reste, et `Math.max(0, …)` ecrasait la contradiction en « 0 » — sous une
//      etiquette « borne haute » qui promettait l'inverse.
// Le seul endroit honnete pour ce decompte est le DRY-RUN du script de
// rattrapage, qui liste les fils chez le provider sans ecrire. Ce diagnostic-ci
// etablit l'ETAT ; le decompte vient apres.
//
// USAGE
//   node scripts/diagnostic-import-colomiers.js
//   node scripts/diagnostic-import-colomiers.js --bien=<uuid>
//   node scripts/diagnostic-import-colomiers.js --tous

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

// ⚠ LA GARDE AVANT LE CLIENT, pas dans le `main`. `createClient` leve des le
// chargement du module quand l'URL manque : le message utile n'etait jamais
// atteint, et le script sortait sur une trace de pile de la librairie.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.')
  console.error('Lancez depuis le depot, avec .env.local en place.')
  process.exit(1)
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ LES CONSTANTES SONT IMPORTEES, PLUS RECOPIEES. Les recopier les avait deja
// fait DIVERGER : le script bornait a 200 la ou le cron borne a 500, sous un
// commentaire qui affirmait « la meme borne que le cron ». Un bien bloque au-dela
// du 200e devenait invisible, et `--bien=<son uuid>` repondait « aucun bien ne
// correspond » — une reponse fausse, en silence, dans l'outil charge de detecter
// les silences. Le module qui les definit les exporte : on les lui demande.
// (`require` APRES la garde d'environnement : sa chaine cree un client Supabase
// au chargement, qui leve si les variables manquent.)
const { marqueurDe, ABSTENTIONS_AVANT_INCIDENT, ANNONCE_A_PARTIR_DE } =
  require('../lib/cron-channel-messages-sync')

// Le bien qui n'a jamais converge (mesure du 16 septembre 2026).
const COLOMIERS_PREFIXE = '0544fd9a'
// ⚠ CELLE-CI N'EST PAS EXPORTEE (`api/cron-messages.js:50`), elle est donc
// RECOPIEE — et c'est une dette assumee, pas un oubli : si elle change la-bas
// sans changer ici, le script retronquera en silence.
const MAX_BIENS = 500

const arg = n => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : null
}
const drapeau = n => process.argv.includes(`--${n}`)
// ⚠ `--bien <uuid>` (avec une espace) ETAIT AVALE EN SILENCE : `arg()` ne
// reconnait que `--bien=`, donc `vise` valait `null` et le script diagnostiquait
// Colomiers en affichant le nom d'un AUTRE bien, sans un mot. Un outil de
// diagnostic qui repond a cote de la question posee est pire qu'un outil qui
// refuse. On refuse.
function refuserFormeEspace (nom) {
  const i = process.argv.indexOf(`--${nom}`)
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    console.error(`Écrivez --${nom}=${process.argv[i + 1]} (avec un =), pas --${nom} ${process.argv[i + 1]}.`)
    process.exit(1)
  }
}

const n = v => (v === null || v === undefined ? '—' : String(v))
const jours = iso => {
  if (!iso) return ''
  const d = (Date.now() - Date.parse(iso)) / 86400000
  return Number.isFinite(d) ? `   (il y a ${d.toFixed(1)} j)` : ''
}
const court = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—')

async function biensCandidats () {
  // ⚠ LES DEUX VALEURS, `channex` ET `channel`, COMME LE CRON.
  // Premier jet : `.eq('provider', 'channex')`. C'est EXACTEMENT le defaut que
  // `api/cron-messages.js` documente avoir corrige en review — `'channel'` est
  // la valeur marque blanche, traitee en paire partout dans le depot, et
  // `properties.provider` n'a aucune contrainte qui l'empeche.
  // Ici la consequence serait pire : un DIAGNOSTIC plus etroit que le cron qu'il
  // diagnostique conclurait « tout est converge » sur un parc qui ne l'est pas.
  const { data, error } = await supabase.from('properties')
    .select('id, name, user_id, provider, provider_property_id')
    .in('provider', ['channex', 'channel'])
    .not('provider_property_id', 'is', null)
    .limit(MAX_BIENS)
  if (error) throw new Error('lecture des biens : ' + error.message)
  if ((data || []).length >= MAX_BIENS) {
    console.warn(`⚠ ${MAX_BIENS} biens lus : borne atteinte, la liste peut etre TRONQUEE.`)
  }
  return data || []
}

async function etatDuBien (bien) {
  const propId = String(bien.provider_property_id)
  const cle = marqueurDe(bien.user_id, propId)

  // ⚠ `errors` DANS LE SELECT. PostgREST ne rend que les colonnes demandees, et
  // c'est precisement l'oubli qui avait rendu le point de reprise inerte en
  // production. On relit la MEME forme que `lireEtat` : `last_run` = marqueur
  // d'anteriorite, `total_messages` = abstentions, `errors[0]` = la reprise.
  const { data: etat, error: errEtat } = await supabase.from('cron_logs')
    .select('last_run, total_messages, errors').eq('id', cle).maybeSingle()
  if (errEtat) throw new Error(`etat de ${bien.name} : ` + errEtat.message)
  const brut = Array.isArray(etat?.errors) ? etat.errors[0] : null

  // ⚠ `count` SE LIT COMME `lireEtat` LE LIT, pas « tel quel ». Le provider
  // ecarte la reprise quand ce compte n'est pas un nombre fini (`filInchange`
  // devient faux, et le fil repart de sa page 1). Afficher `count: "abc"` comme
  // une reprise vivante ferait dire au diagnostic le contraire de ce que fait le
  // cron — et c'est tout ce qu'on lui demande de ne pas faire.
  // ⚠ `Number(null)` VAUT 0, ET 0 EST FINI — le meme piege que le lot 5, refait
  // dans le script ecrit APRES l'avoir grave au KB. `ecrireEtat` et
  // `repriseSuivante` persistent EXPLICITEMENT `count: null` quand le
  // `message_count` du fil n'est pas un nombre fini : relire ce `null` avec
  // `Number.isFinite(Number(x))` rendait `count: 0`, affiche comme une reprise
  // VIVANTE — pendant que le cron calcule `filInchange = (0 === compteFil)`,
  // faux pour tout fil non vide, jette la reprise et relit le fil depuis sa
  // page 1. Exactement la contradiction que ce champ existe pour reveler.
  // On teste donc l'ABSENCE de valeur avant de convertir.
  const countAbsent = !brut || brut.count === null || brut.count === undefined
  const countLu = countAbsent ? NaN : Number(brut.count)
  const reprise = brut && brut.fil
    ? { fil: String(brut.fil), page: Number(brut.page) || 1,
        count: Number.isFinite(countLu) ? countLu : null,
        countBrut: brut.count === undefined ? null : brut.count }
    : null

  // ⚠ DEUX COMPTES DIRECTS, PAS UNE SOUSTRACTION. `enBase - sansId` sur deux
  // requetes separees peut devenir NEGATIF si le webhook insere entre les deux —
  // et ce script se revendique lançable pendant une passe du cron.
  const compte = async filtre => {
    const q = supabase.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', bien.user_id).eq('property_id', propId)
    const { count, error } = await filtre(q)
    if (error) throw new Error(`comptage sur ${bien.name} : ` + error.message)
    return count || 0
  }
  // ⚠ TROIS MESURES SUCCESSIVES, PAS UN INSTANTANE. Le webhook peut inserer
  // entre deux : `avec + sans` peut donc depasser `total` a l'ecran. On le DIT
  // plus bas plutot que de laisser le lecteur conclure a une base incoherente.
  const enBase = await compte(q => q)
  const avecIdProvider = await compte(q => q.not('provider_msg_id', 'is', null))
  const sansIdProvider = await compte(q => q.is('provider_msg_id', null))

  // L'annonce prealable — a lire pour ce qu'elle est, voir l'en-tete.
  const { data: annonces, error: errAnn } = await supabase.from('automation_incidents')
    .select('created_at, detail')
    .eq('type', 'ecriture_de_masse_annoncee').eq('property_id', propId)
    .order('created_at', { ascending: false }).limit(1)
  if (errAnn) throw new Error(`annonces de ${bien.name} : ` + errAnn.message)
  const ann = (annonces || [])[0] || null

  // ⚠ CELLE-CI DOIT LEVER COMME LES AUTRES, ET ELLE NE LE FAISAIT PAS. Seul
  // appel du fichier qui ne destructurait pas `error` : sur un timeout de pooler,
  // `count` valait `undefined`, l'ecran affichait « alarmes 0 », et on en
  // concluait que l'import n'avait jamais ete suspendu — donc que le blocage
  // etait recent. Le contresens exact que ce script existe pour eviter.
  const { count: suspensions, error: errSusp } = await supabase.from('automation_incidents')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'messages_import_suspendu').eq('property_id', propId)
  if (errSusp) throw new Error(`alarmes de ${bien.name} : ` + errSusp.message)

  return {
    bien, propId, cle,
    aUneLigne: !!etat,
    marqueur: etat?.last_run || null,
    abstentions: Number(etat?.total_messages) || 0,
    motif: brut && brut.motif ? String(brut.motif) : null,
    reprise,
    filsVusALAnnonce: ann?.detail?.fils ?? null,
    messagesEstimes: ann?.detail?.messages_attendus ?? null,
    annonceLe: ann?.created_at || null,
    enBase, avecIdProvider, sansIdProvider,
    suspensions: suspensions || 0
  }
}

// ⚠ QUATRE ETATS, ET LE SEUIL EST CELUI DU CRON.
//
// Premier jet : `marqueur !== null && abstentions === 0`, puis « ✗ BLOQUE » des
// la premiere abstention. Deux erreurs opposees :
//
//   — UN BIEN A JOUR PASSAIT POUR EN ECHEC. Le verdict se fondait sur le
//     marqueur ; or un bien qui n'a JAMAIS eu de marqueur et dont la passe
//     complete ne rend aucun instant lisible reste a `null` avec `abstentions:
//     0`. (Il s'agit bien de ce cas-la, et non d'un effacement : `sAbstenir`
//     ecrit `depuis: r.jusqua || etat.depuis`, donc un marqueur EXISTANT est
//     conserve. La premiere version du commentaire decrivait une ecriture que le
//     cron ne fait pas — dans un fichier dont le contrat est de n'affirmer que
//     ce qu'il peut etablir.)
//
//   — UNE ABSTENTION N'EST PAS UNE PANNE. Une passe tronquee par le budget en
//     incremente une A CHAQUE CYCLE : c'est le fonctionnement NORMAL d'un
//     rattrapage a point de reprise (page 3, puis 7, puis fini). Le cron n'en
//     fait un etat qu'a `ABSTENTIONS_AVANT_INCIDENT`, et c'est ce seuil-la qu'on
//     reprend — importe, pas recopie. En dessous, on dit « en cours », pas
//     « bloque » : un diagnostic qui crie a la panne sur une file qui avance
//     ferait lancer un rattrapage dont personne n'a besoin.
function verdict (e) {
  if (!e.aUneLigne) return { code: 'jamais', texte: '— jamais passé (aucune ligne d\'état)' }
  if (e.abstentions === 0) {
    return e.marqueur
      ? { code: 'ok', texte: '✓ convergé' }
      : { code: 'ok', texte: '✓ convergé (aucun instant à mémoriser)' }
  }
  if (e.abstentions < ABSTENTIONS_AVANT_INCIDENT) {
    return { code: 'encours',
             texte: `⋯ en cours — ${e.abstentions} abstention(s), sous le seuil de ${ABSTENTIONS_AVANT_INCIDENT}` }
  }
  return { code: 'bloque', texte: `✗ BLOQUÉ — ${e.abstentions} abstention(s) consécutive(s)` }
}

function rendre (e) {
  const v = verdict(e)
  console.log(`\n━━━ ${e.bien.name || e.propId}   [${e.bien.provider}]   (${e.bien.id})`)
  console.log(`    clé d'état             ${e.cle}`)
  console.log(`    marqueur d'antériorité ${n(e.marqueur)}${jours(e.marqueur)}`)
  console.log(`    abstentions            ${e.abstentions}${e.motif ? `   dernier motif = ${e.motif}` : ''}`)
  if (e.reprise) {
    console.log(`    point de reprise       fil ${e.reprise.fil} · page ${e.reprise.page} · count ${n(e.reprise.count)}`)
    if (e.reprise.count === null) {
      console.log(`      ⚠ count illisible (${JSON.stringify(e.reprise.countBrut)}) : le provider REJETTE`)
      console.log('        cette reprise et relit le fil depuis sa page 1.')
    }
  } else {
    console.log('    point de reprise       — (aucun : le prochain cycle repart du début)')
  }
  console.log(`    alarmes « suspendu »   ${e.suspensions}`)

  console.log('    ─ messages en base ─')
  console.log(`    total                  ${e.enBase}`)
  console.log(`    avec provider_msg_id   ${e.avecIdProvider}`)
  console.log(`    sans provider_msg_id   ${e.sansIdProvider}`)
  if (e.avecIdProvider + e.sansIdProvider !== e.enBase) {
    console.log('      ⚠ Ces trois nombres sont TROIS MESURES SUCCESSIVES, pas un')
    console.log('        instantané : le webhook a inséré entre deux requêtes. Ce')
    console.log('        n\'est pas une incohérence de la base.')
  }
  if (e.sansIdProvider) {
    // ⚠ « INDEDUPLICABLES » ETAIT FAUX, et d'un ordre de grandeur. `recordMessage`
    // reconcilie l'echo sur (user, booking, sens, corps [, instant]) et POSE
    // l'identifiant au lieu de reinserer — or c'est exactement la forme des lignes
    // ecrites par le webhook, qui n'ont presque jamais de `provider_msg_id`.
    console.log('      Ces lignes ne sont PAS perdues pour la déduplication :')
    console.log('      `recordMessage` réconcilie l\'écho sur (réservation, sens,')
    console.log('      corps, instant) et POSE l\'identifiant. Seules celles qui')
    console.log('      échappent à cette réconciliation risquent un doublon.')
  }

  console.log('    ─ dernière annonce du cron ─')
  if (e.annonceLe) {
    console.log(`    émise le               ${court(e.annonceLe)}${jours(e.annonceLe)}`)
    console.log(`    fils vus à cet instant ${n(e.filsVusALAnnonce)}   ← un INDEX, pas un total`)
    console.log(`    messages estimés       ${n(e.messagesEstimes)}   ← une PAGE de fils, pas le bien`)
    console.log('      ⚠ NE PAS SOUSTRAIRE CE NOMBRE DU TOTAL EN BASE. Il date du')
    console.log('        démarrage du lot, ne couvre qu\'une page de fils, et n\'est')
    console.log('        jamais réémis sur une reprise. Le décompte réel des')
    console.log('        messages restants vient du DRY-RUN du rattrapage.')
  } else {
    console.log('    aucune')
    console.log('      Deux causes possibles, et sur un bien EN REPRISE la seconde')
    console.log('      est de loin la plus probable :')
    console.log(`        · le lot est sous le seuil (le cron annonce à partir de ${ANNONCE_A_PARTIR_DE}) ;`)
    console.log('        · le bien est en reprise permanente — l\'annonce est gardée')
    console.log('          par `!annonceFaite && !reprise`, donc elle n\'est JAMAIS')
    console.log('          émise sur une reprise, quelle que soit la taille du lot.')
  }
  console.log(`    ÉTAT                   ${v.texte}`)
  return v.code
}

;(async () => {
  refuserFormeEspace('bien')
  const tous = await biensCandidats()
  const vise = arg('bien')
  const choisis = drapeau('tous') ? tous
    : tous.filter(b => String(b.id).startsWith(vise || COLOMIERS_PREFIXE))

  if (!choisis.length) {
    console.error(`Aucun bien ne correspond à « ${vise || COLOMIERS_PREFIXE} ».`)
    console.error('Biens vus :', tous.map(b => `${String(b.id).slice(0, 8)} ${b.name}`).join(' | ') || '(aucun)')
    process.exit(1)
  }

  console.log('DIAGNOSTIC IMPORT DES MESSAGES OTA — LECTURE SEULE, aucune écriture.')
  console.log(`Biens dans le périmètre du cron (channex + channel) : ${tous.length}`)

  const compte = { ok: 0, encours: 0, bloque: 0, jamais: 0 }
  for (const b of choisis) compte[rendre(await etatDuBien(b))]++

  console.log(`\n═══ ${choisis.length} bien(s) : ${compte.ok} convergé(s), ${compte.encours} en cours, `
    + `${compte.bloque} bloqué(s), ${compte.jamais} jamais passé(s).`)
  if (compte.bloque) {
    console.log('Un rattrapage est justifié. Son dry-run donnera le décompte réel.')
  } else if (compte.encours) {
    // ⚠ ON NE DECLENCHE PAS UN RATTRAPAGE SUR UNE FILE QUI AVANCE. Deux passages
    // espaces disent en une minute ce qu'aucune lecture unique ne peut dire :
    // si le point de reprise progresse, le cron fait son travail.
    console.log('Aucun bien bloqué, mais un rattrapage est EN COURS. Relancez ce')
    console.log('diagnostic après un ou deux cycles : si la page du point de reprise')
    console.log('avance, il n\'y a rien à faire.')
  } else if (compte.jamais) {
    console.log('Des biens n\'ont jamais été traités : vérifiez que le cron dédié tourne.')
  } else {
    console.log('Aucun bien bloqué : l\'incident peut être classé.')
  }
})().catch(e => { console.error('\nÉCHEC :', e.message); process.exit(1) })
