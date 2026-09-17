// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron DÉDIÉ à l'import des messages écrits chez l'OTA
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ POURQUOI IL EXISTE, ET CE N'EST PAS UN CONFORT D'ARCHITECTURE.
// L'import vivait en seconde passe du cycle principal, avec 8 s de budget POUR
// TOUT LE PARC. Mesure du 15 septembre 2026, quatre cycles consecutifs :
//
//   Colomiers     abstentions 130 -> 133   motif = budget
//   Ofuro Futari  abstentions 131 -> 134   motif = budget
//   La bulle      abstentions 130 -> 133   motif = cycle_en_retard
//   Coeur de vie  abstentions 127 -> 130   motif = cycle_en_retard
//
// Les deux premiers biens consommaient les 8 s sans aboutir ; les deux suivants
// n'etaient MEME PAS APPELES. Marqueur d'anteriorite a `null` depuis 133 cycles,
// 1189 messages en base inchanges d'un bout a l'autre, et le preavis d'ecriture
// de masse reparti a chaque cycle avec le meme compte.
//
// ⚠ ET `BUDGET_MS` N'ETAIT PAS LE LEVIER. `cycle_en_retard` se decide AVANT
// lui : c'est l'ORDRE DE PASSAGE qui affame l'import, pas la duree qu'on lui
// accorde une fois appele. Augmenter sa part dans un cycle deja a 40-56 s pour
// un plafond de 60 n'aurait fait que deplacer ce qui saute — et ce qui saute,
// dans ce cycle, ce sont les codes d'acces. La lecon du 10 septembre (24 h de
// codes perdus, une voyageuse devant une porte) interdit ce marchandage.
//
// ⚠ « UN SEUL APPELANT » VAUT POUR `importerMessagesDuBien`, PAS POUR
// `importMessages`. `lib/cron-channel-messages-backfill.js` tourne toujours
// dans le cycle principal et rejoue l'import pour les biens actives depuis
// moins de 30 minutes. Un bien fraichement active peut donc etre lu par les
// deux — inoffensif (`recordMessage` deduplique, le backfill ne touche AUCUN
// marqueur `messages_import:`), mais a savoir avant de mesurer un cout.
//
// ⚠ CADENCE 10 MINUTES, PAS 5. L'import est un RATTRAPAGE d'historique : le
// temps reel passe par le webhook, qui lui fonctionne. Dix minutes laissent la
// place a une passe large sans jamais chevaucher la precedente — deux passes
// concurrentes sur le meme bien ne se corrompraient pas (le marqueur est un
// upsert, `recordMessage` deduplique) mais doubleraient le cout pour rien.

const { createClient } = require('@supabase/supabase-js')
const {
  importerMessagesDuBien,
  ordonnerPourImport,
  BUDGET_BIEN_DEDIE_MS,
  BUDGET_PARC_DEDIE_MS,
  RELIQUAT_MINIMAL_MS
} = require('../lib/cron-channel-messages-sync')

// ⚠ BORNE DE LECTURE. Supabase tronque a 1000 lignes sans erreur : la rechute
// nommee au CLAUDE.md (« une lecture ajoutee sans borne dans un script neuf »).
const MAX_BIENS_PAR_PASSE = 500

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler (req, res) {
  // ⚠ MEME GARDE QUE `/api/cron` : un import declenchable de l'exterieur serait
  // un moyen de faire ecrire la base par n'importe qui, et de bruler le quota
  // d'appels Channex de l'hote.
  // ⚠ UN SECRET ABSENT NE DOIT PAS OUVRIR LA PORTE. Sans cette premiere ligne,
  // un deploiement ou la variable manque compare au litteral `Bearer undefined`
  // — qu'il suffit d'envoyer. La parade existe deja dans le depot
  // (`api/backfill-beds24-host.js`) ; `api/cron.js` ne l'a pas, et la copier
  // telle quelle aurait recopie le defaut avec.
  if (!process.env.CRON_SECRET) {
    console.error('[cron-messages] CRON_SECRET absent : endpoint ferme')
    return res.status(503).json({ error: 'Service non configuré' })
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' })
  }

  const t0 = Date.now()
  const results = { errors: [] }
  console.log('[cron-messages] demarrage', new Date().toISOString())

  // ⚠ LES DEUX VALEURS, COMME LE CYCLE DONT CET IMPORT SORT. `'channel'` est la
  // valeur MARQUE BLANCHE, traitee en paire partout dans le depot, et
  // `properties.provider` n'a AUCUNE contrainte qui l'empeche. Filtrer sur le
  // seul `'channex'` faisait disparaitre ces biens de la file sans une erreur,
  // sans une abstention, sans un incident : leur marqueur n'aurait plus jamais
  // bouge et `messages_import_suspendu` n'aurait pas pu partir. C'est la panne
  // muette exacte que tout ce chantier existe pour fermer, reintroduite par un
  // `select`. Trouve en review.
  // ⚠ Beds24 reste ecarte a dessein : son `importMessages` est un no-op.
  // ⚠ BORNE EXPLICITE : Supabase tronque a 1000 lignes SANS erreur. La regle du
  // depot est de borner, meme quand le parc en compte cinq.
  const { data: props, error } = await supabase
    .from('properties')
    .select('id, user_id, provider_property_id, name')
    .in('provider', ['channex', 'channel'])
    .not('provider_property_id', 'is', null)
    .limit(MAX_BIENS_PAR_PASSE)
  if (error) {
    console.error('[cron-messages] lecture des biens echec:', error.message)
    return res.status(503).json({ error: 'Lecture des biens impossible' })
  }

  // ⚠ L'ORDRE TOURNE. `ordonnerPourImport` fait passer en premier le bien vu il
  // y a le plus longtemps : sans lui, un bien couteux place en tete affamerait
  // les memes biens a chaque passage — c'est exactement ce qui s'est produit
  // dans le cycle principal.
  let aImporter = props || []
  try {
    aImporter = await ordonnerPourImport(supabase, props || [])
  } catch (err) {
    console.error('[cron-messages] ordre illisible, ordre d origine :', err.message)
  }

  // ⚠ UNE ECHEANCE POUR TOUT LE PARC, posee ICI. C'est la lecon du bloquant 4 :
  // une echeance posee avant la boucle metier mesure le CYCLE, pas l'import.
  const echeance = t0 + BUDGET_PARC_DEDIE_MS

  // ⚠ LA BOUCLE CONSULTE L'ECHEANCE, ET NE PAS LE FAIRE COUTAIT PLUS QUE DU
  // TEMPS. Passe les 45 s, chaque bien restant faisait quand meme une lecture
  // d'etat PUIS un upsert d'abstention `cycle_en_retard` — pour un bien qu'on
  // n'a meme pas essaye. A soixante biens, c'est ~120 aller-retours APRES
  // l'expiration du budget, pris sur la marge reservee a la reponse. Et surtout
  // ca pollue le compteur qui a servi a diagnostiquer le blocage : le rappel
  // periodique se mettrait a partir pour une file d'attente normale, pas pour
  // une panne. « L'alerte la plus bruyante etait la moins informative » — on ne
  // va pas la refabriquer.
  // ⚠ NE RIEN ECRIRE POUR EUX EST MIEUX QUE DE LES COMPTER ABSTENUS :
  // `ordonnerPourImport` les fait passer EN TETE a la passe suivante.
  let traites = 0
  // Biens dont la passe s'est terminee sans abstention ni exception.
  let aboutis = 0
  let nonAtteints = 0
  for (const p of aImporter) {
    if (!p.provider_property_id) continue
    if (echeance - Date.now() < RELIQUAT_MINIMAL_MS) { nonAtteints++; continue }
    traites++
    // ⚠ SON PROPRE `try`, PAR BIEN. Une panne sur un bien ne doit pas priver les
    // suivants de leur import — meme regle que dans le cycle principal.
    try {
      const r = await importerMessagesDuBien(supabase, p, {
        echeance, results, budgetBienMs: BUDGET_BIEN_DEDIE_MS
      })
      if (r && !r.abstenu) aboutis++
    } catch (err) {
      console.error(`[cron-messages] ${p.provider_property_id}:`, err.message)
      results.errors.push({ property_id: p.provider_property_id, error: err.message })
    }
  }
  if (nonAtteints) {
    // ⚠ `log`, PAS `warn` — LE BUDGET EST FAIT POUR NE PAS TOUT ATTEINDRE.
    // Cette phrase decrit le fonctionnement prevu : le budget borne la passe et
    // `ordonnerPourImport` fait passer devant ceux qu'on n'a pas servis. La dire
    // sur `stderr` faisait etiqueter « error » par Vercel toute invocation d'un
    // parc plus grand qu'une passe — c'est-a-dire le cas NOMINAL. Une alarme
    // toujours allumee est une alarme morte.
    // ⚠ MAIS PAS QUAND LA PASSE N'A RIEN FAIT DU TOUT. `nonAtteints` est nominal
    // tant que la rotation tourne ; `traites === 0` est l'echec TOTAL de la
    // passe, et il est le seul cas ou personne d'autre ne parlera : les biens
    // sautes n'ecrivent volontairement aucun etat, donc aucun compteur
    // d'abstention ne monte et `messages_import_suspendu` ne peut PAS partir
    // pour eux. Sans cette ligne sur stderr, un budget mange par un pooler qui
    // pend produirait un bilan « traites: 0 » d'apparence saine.
    // C'est le meme critere que pour les abstentions : ce qui compte est qu'il
    // se passe QUELQUE CHOSE, pas le nombre de tours.
    // ⚠ « RIEN FAIT » SE COMPTE SUR LES RESULTATS, PAS SUR LES TENTATIVES.
    // `traites++` se fait AVANT le `try` : il compte les biens ENTRES, y compris
    // celui qui leve aussitot ou s'abstient sur `etat_illisible`. Le scenario
    // nomme — un pooler qui pend — donne donc `traites: 1` des que le blocage est
    // dans le premier bien, et la ligne restait sur stdout. On compte ce qui a
    // REELLEMENT abouti.
    const rienFait = aboutis === 0
    const dire = rienFait ? console.warn : console.log
    dire(`[cron-messages] ${nonAtteints} bien(s) non atteints dans le budget — `
      + (rienFait ? 'et AUCUN bien traite dans cette passe'
                  : 'ils passeront en tete a la prochaine passe'))
  }

  const bilan = {
    biens: aImporter.length,
    traites,
    non_atteints: nonAtteints,
    aboutis,
    importes: results.messagesImportes || 0,
    abstentions: results.messagesImportAbstentions || 0,
    erreurs: results.errors.length,
    ms: Date.now() - t0
  }
  console.log('[cron-messages] fin', JSON.stringify(bilan))
  // ⚠ 200 MEME AVEC DES ERREURS, ET ELLES SONT DANS LE CORPS. Un cron qui rend
  // 500 fait retenter Vercel ; ici une panne par bien est deja absorbee, et le
  // diagnostic se lit dans `errors` — jamais dans le code HTTP. Lecon du
  // 10 septembre : « diagnostiquer un cron = lire results.errors ».
  return res.status(200).json({ ok: true, ...bilan, errors: results.errors })
}
