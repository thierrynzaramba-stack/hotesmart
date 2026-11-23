#!/usr/bin/env node
// scripts/migrer-modes-vers-delais.js
// LA MIGRATION DES DONNEES DU CHANTIER « DELAI DE REPONSE IA » (lot 2, §6).
//
//   node --env-file=<.env de la base visee> scripts/migrer-modes-vers-delais.js          # a blanc
//   node --env-file=<.env de la base visee> scripts/migrer-modes-vers-delais.js --go     # ecrit
//
// ⚠ A BLANC PAR DEFAUT. Rien n'est ecrit sans `--go` : ce script touche le
// reglage qui gouverne les ENVOIS au voyageur.
//
// ⚠ AUCUN CHANGEMENT DE COMPORTEMENT, ET C'EST TOUT SON CAHIER DES CHARGES :
//   mode 'auto' -> reponse_ia = 0     (ca part tout de suite, comme avant)
//   mode 'test' -> reponse_ia = null  (validation manuelle, comme avant)
//   dans les deux cas -> alerte_info = 0
//
// ⚠ `alerte_info = 0` POUR TOUT LE MONDE, et c'est une decision de Thierry du
// 27 octobre 2026 contre mon premier reflexe. L'alerte « info manquante » n'a
// JAMAIS ete reglable : `lib/cron-classify.js` appelle
// `sendAlertNotifications` dans le tour, sans lire le mode. Poser 15 minutes
// ici aurait donc CHANGE le comportement de biens en production sous couvert
// de migration. Les 15 minutes sont le defaut des biens NEUFS, a l'onboarding.
//
// ⚠ IDEMPOTENT : un bien qui porte deja un bloc `delais` n'est pas touche. On
// peut relancer sans rien casser, et un second passage ne rend rien.
//
// ⚠ LA SOURDINE EST INACTIVE : personne ne l'a demandee, et l'activer
// retarderait des alertes que l'hote recoit aujourd'hui tout de suite.

const { createClient } = require('@supabase/supabase-js')
const { REF_PRODUCTION, nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { reponseIaValide, formeExploitable } = require('../lib/guestflow/delais-contrat')

const GO = process.argv.includes('--go')
const SOURDINE_PAR_DEFAUT = { active: false, debut: '22:00', fin: '08:00' }

// ⚠ LA PRODUCTION EST REFUSEE PAR DEFAUT, ET LA MAIN DE THIERRY N'EST PAS LA
// SEULE SURETE (sa condition, 28 octobre 2026). Ce script ecrit le reglage qui
// GOUVERNE LES ENVOIS au voyageur : un `--go` tape dans le mauvais terminal
// changerait le comportement de tous les biens d'un compte reel.
//
// ⚠ ET C'EST UNE VARIABLE QUI NOMME LE PROJET, PAS UN DRAPEAU. Thierry a
// demande `--confirmer-prod` ; le motif eprouve du depot
// (scripts/verifier-migration-canaux-echec.js) est plus fort, et je l'ai suivi :
// un drapeau s'ajoute par reflexe au bout d'une ligne de commande, tandis que
// nommer soi-meme la reference du projet ne se fait pas par accident — « une
// variable a 1, true ou oui ne suffit pas, et une faute de frappe referme la
// porte ».
//
// Code de sortie 3, comme demande (le script cite en exemple refuse en 2 ; je
// garde le 3 pour que ce refus-ci se distingue des autres sorties du script :
// 1 = lecture impossible ou base inconnue, 2 = ecritures en erreur).
const URL = process.env.SUPABASE_URL
const PROJET = refDuProjet(URL) || ''
const CONFIRME = String(process.env.CONFIRMER_PROD || '').trim() === REF_PRODUCTION

// ⚠ LE REFUS PASSE AVANT TOUTE CONNEXION, et c'est un defaut que j'ai corrige
// en l'eprouvant : je l'avais place apres la lecture des configs. Un script qui
// refuse la production APRES s'y etre connecte et avoir lu ses donnees fait
// deux choses de trop — et il devient intestable sans acces reel, puisqu'une
// fausse cle le fait echouer en LECTURE (code 1) avant d'atteindre son refus
// (code 3). Le refus ne depend que de `SUPABASE_URL` : il n'a aucune raison
// d'attendre.
//
// L'empreinte, elle, reste imprimee avant tout RESULTAT de mesure — « un
// resultat qui ne dit pas ou il a ete obtenu ne prouve rien ». Refuser n'est
// pas mesurer : le refus NOMME la base dans son propre message.
if (GO && nomDeLaBase(process.env.SUPABASE_URL) === 'PRODUCTION'
  && String(process.env.CONFIRMER_PROD || '').trim() !== REF_PRODUCTION) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION, et ce script ecrit le reglage`)
  console.error('        qui gouverne les envois au voyageur. Staging par defaut.')
  console.error('')
  console.error('Pour un passage unique et assume, relancer avec')
  console.error(`        CONFIRMER_PROD=${REF_PRODUCTION}`)
  console.error('        (la reference du projet, pas un drapeau : « 1 », « true »')
  console.error('         ou « oui » ne suffisent pas, et une faute de frappe referme.)')
  console.error('')
  console.error('A blanc (sans --go), la production se lit sans aucune ecriture.')
  process.exit(3)
}

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  // ─── L'empreinte : OU ecrit-on ? Et le refus si on ne sait pas ──────────
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  // ⚠ PAGINE, PARCE QUE POSTGREST TRONQUE A 1000 LIGNES SANS ERREUR (regle du
  // depot, constat 12 de la revue). Un `select` nu aurait annonce « Applique »
  // en ayant ignore les comptes au-dela du millieme — et l'idempotence aurait
  // MASQUE le manque au relancement : les non migres n'apparaissent nulle part,
  // ni dans « a migrer », ni dans « deja migres ».
  const PAGE = 500
  const lignes = []
  for (let debut = 0; ; debut += PAGE) {
    const { data, error } = await sb.from('agent_alert_config')
      .select('user_id, config')
      .order('user_id', { ascending: true })
      .range(debut, debut + PAGE - 1)
    if (error) { console.error('ECHEC : lecture impossible —', error.message); process.exit(1) }
    lignes.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  console.log(`Base ${base} · ${lignes.length} compte(s) avec une config d'alertes`)
  if (base === 'INCONNUE') {
    console.error('ECHEC : projet Supabase inconnu — ni la production, ni staging.')
    console.error("Un resultat qui ne dit pas OU il a ete obtenu ne prouve rien.")
    process.exit(1)
  }
  if (GO && base === 'PRODUCTION') {
    console.log('\n⚠ PASSAGE EN PRODUCTION ASSUME — ' + new Date().toISOString())
    console.log('  confirme par CONFIRMER_PROD, et journalise ici.')
    console.log('  ecrit : la cle `delais` de chaque bien qui n\'en a pas encore,')
    console.log('          derivee de son `mode` actuel — aucun changement de comportement.')
    console.log('  ne touche : aucun bien deja migre, aucune autre cle du blob.\n')
  }
  console.log(GO ? '→ MODE ECRITURE (--go)' : '→ a blanc : rien ne sera ecrit')

  let comptes = 0, biens = 0, dejaFaits = 0, inchanges = 0, erreurs = 0
  const detail = []

  for (const ligne of lignes) {
    const blob = ligne.config
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) { inchanges++; continue }
    const sortie = { ...blob }
    let touche = false

    for (const [ref, entree] of Object.entries(blob)) {
      if (!entree || typeof entree !== 'object' || Array.isArray(entree)) continue
      // Idempotence : un bloc `delais` deja CONFORME se laisse tranquille.
      if (formeExploitable(entree.delais) && 'reponse_ia' in entree.delais
        && reponseIaValide(entree.delais.reponse_ia)) { dejaFaits++; continue }

      // Le mode d'avant decide, et le repli est celui du code : 'test'.
      const mode = entree.mode === 'auto' ? 'auto' : 'test'
      const reponse = mode === 'auto' ? 0 : null
      sortie[ref] = { ...entree, delais: {
        reponse_ia: reponse, alerte_info: 0, sourdine: { ...SOURDINE_PAR_DEFAUT }
      } }
      touche = true
      biens++
      detail.push(`    ${ligne.user_id.slice(0, 8)}… / ${ref} : mode ${mode} -> reponse_ia ${reponse === null ? 'null (validation manuelle)' : '0 (immediat)'}`)
    }

    if (!touche) { inchanges++; continue }
    comptes++
    if (!GO) continue
    const { error: eW } = await sb.from('agent_alert_config')
      .update({ config: sortie, updated_at: new Date().toISOString() })
      .eq('user_id', ligne.user_id)
    if (eW) { erreurs++; console.error(`  ✖ ${ligne.user_id.slice(0, 8)}… : ${eW.message}`) }
  }

  console.log(`\n  ${biens} bien(s) a migrer, sur ${comptes} compte(s)`)
  console.log(`  ${dejaFaits} bien(s) deja migre(s) — non touches (idempotence)`)
  console.log(`  ${inchanges} compte(s) sans rien a faire`)
  if (detail.length) { console.log('\n  Detail :'); for (const d of detail) console.log(d) }
  if (erreurs) { console.error(`\nECHEC : ${erreurs} ecriture(s) en erreur.`); process.exit(2) }
  if (!GO && biens) {
    console.log('\n  Rien n\'a ete ecrit. Relancer avec --go pour appliquer.')
  } else if (GO) {
    console.log('\n  Applique. Verifier a l\'ecran qu\'aucun bien n\'a change de comportement :')
    console.log('  un bien en Mode Test doit afficher « Je valide chaque reponse ».')
  }
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
