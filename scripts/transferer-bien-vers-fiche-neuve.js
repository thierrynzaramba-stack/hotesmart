// scripts/transferer-bien-vers-fiche-neuve.js
// Transfere les donnees d'une ancienne fiche (cle Beds24) vers la fiche NEUVE
// (cle Channex), par `transferer_bien` — plan retenu par Thierry le
// 10 septembre 2026.
//
// ⚠ CE SCRIPT NE FAIT QUE PILOTER. Tout le travail est dans la fonction
// plpgsql `transferer_bien` (migrations/2026-09-10-transfert-vers-bien-neuf.sql) :
// une seule transaction, sauvegarde integrale dans `rekeying_backup`, et neuf
// refus. PostgREST n'a pas de transaction sur plusieurs requetes — c'est toute
// la raison d'etre de cette fonction.
//
// ⚠ IL POSE `automation_paused = true` SUR LA SOURCE, QUE LA FONCTION EXIGE.
// Sans cette pause, un cron qui lit encore l'ancienne cle enverrait un message
// ou un code d'acces sur un sejour en train de changer de fiche.
//
// ⚠ IL NE TOUCHE PAS `rate_sync_mode`, ET C'EST DELIBERE.
// La fiche neuve nait en `keep` : HoteSmart ne pousse aucun prix. La passer en
// `managed` maintenant ferait appliquer `base_price` a toutes les dates SANS
// ligne de calendrier — 500 jours au prix de base, alors que le transfert
// n'apporte que 17 dates tarifees pour La bulle. Le passage en `managed` est un
// geste separe, apres amorcage des vrais prix.
//
// DRY RUN par defaut : il ne fait alors QUE l'audit `transfert_compter`.
// USAGE : node scripts/transferer-bien-vers-fiche-neuve.js <la-bulle|coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { noterCleMigree, retirerCleMigree, attendreFenetreDeCache } = require('../lib/cles-migrees')
const { rekeyerJson } = require('./rekeyer-json-config')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ECRIRE = process.argv.includes('--ecrire')

// Liste fermee, nommee en dur : un transfert ne prend pas d'identifiant libre.
const CIBLES = {
  'la-bulle': {
    nom: 'Cœur de vie « La bulle »',
    source: '58001ed1-e194-498a-94b4-606eece8f33d',
    cible: '091d9abf-ff86-45ce-8123-3425e6f3900f'
  },
  'coeur-23': {
    nom: 'coeur de vie 23',
    source: '49b2d1f6-b8df-43ba-b636-fa4f73713c4b',
    cible: 'efe1daf1-652c-4177-b29b-19f1db377c96'
  }
}

const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/transferer-bien-vers-fiche-neuve.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]

async function audit (etiquette) {
  const { data, error } = await supabase.rpc('transfert_compter',
    { p_source: C.source, p_cible: C.cible })
  if (error) throw new Error(`transfert_compter : ${error.message}`)
  const par = {}
  for (const r of data) {
    par[r.famille] = par[r.famille] || { s: 0, c: 0 }
    par[r.famille].s += Number(r.sous_source)
    par[r.famille].c += Number(r.sous_cible)
  }
  console.log(`\n── audit ${etiquette}`)
  for (const [f, v] of Object.entries(par)) {
    console.log(`   ${f.padEnd(20)} source ${String(v.s).padStart(5)}   cible ${String(v.c).padStart(5)}`)
  }
  return { data, par }
}

// ⚠ `--sans-attente` EXIGE UNE RAISON : `--sans-attente="cron redeploye a 14h02"`.
// Sa forme nue est refusee par `attendreFenetreDeCache` — un drapeau qui existe
// pour un cas precis finit toujours par etre utilise par reflexe, et celui-ci
// contourne la garde qui empeche le cron de rapatrier ce qu'on deplace.
const RAISON_SANS_ATTENTE = (() => {
  const brut = process.argv.find(a => a.startsWith('--sans-attente'))
  if (!brut) return false
  const raison = brut.includes('=') ? brut.slice(brut.indexOf('=') + 1).trim() : ''
  // ⚠ LE REFUS TOMBE ICI, AU PARSING — CORRECTIF DE REVIEW.
  // Il etait leve par `attendreFenetreDeCache`, donc APRES la pause et APRES
  // l'enregistrement de la cle migree : une garde posee pour empecher un geste
  // par reflexe s'executait apres deux ecritures, dont l'une laisse un bien
  // mort-vivant si on s'arrete la. Un refus d'argument se prononce avant tout
  // appel reseau.
  if (!raison) {
    console.error('REFUS : --sans-attente exige une raison. Utiliser --sans-attente="<raison>".')
    console.error('  Ce drapeau ne vaut QUE si le cron vient d\'etre redeploye : un demarrage a')
    console.error('  froid part avec un cache vide, donc il relira la table immediatement.')
    console.error('  Si une instance CHAUDE tourne encore, ses ecritures repartiront sous')
    console.error('  l\'ANCIENNE cle et rapatrieront ce que ce script est en train de deplacer.')
    process.exit(1)
  }
  return raison
})()

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN — audit seul'}  bien : ${C.nom}`)
  console.log(`   source ${C.source}\n   cible  ${C.cible}`)

  const avant = await audit('AVANT')

  // Les lignes deja cote cible sur les tables a contrainte unique feraient
  // echouer toute la transaction. La fonction refuse dessus ; on les montre ici
  // pour que le refus ne soit pas une surprise.
  const bloquantes = avant.data.filter(r => Number(r.sous_cible) > 0)
  if (bloquantes.length) {
    console.log('\n   ⚠ deja cote cible :')
    for (const r of bloquantes) console.log(`      ${r.nom_table}/${r.colonne} = ${r.sous_cible}`)
  }

  if (!ECRIRE) {
    console.log('\nEssai a blanc — rien n\'a ete transfere. Relancer avec --ecrire.')
    return
  }

  // 1) La pause, exigee par la fonction.
  const { error: eP } = await supabase.from('properties')
    .update({ automation_paused: true, paused_at: new Date().toISOString(),
      paused_reason: 'transfert vers la fiche neuve en cours' })
    .eq('id', C.source)
  if (eP) throw new Error(`pause de la source : ${eP.message}`)
  console.log('\n✓ automation_paused = true sur la source')

  // ⚠ LA CLE EST ENREGISTREE AVANT QUE LA MOINDRE LIGNE NE BOUGE.
  // Elle l'etait APRES le transfert jusqu'au 14 septembre 2026, et c'etait
  // tenable tant que le cron relisait la table toutes les 60 s. Le cache du
  // succes est passe a 15 minutes (voir [cles-migrees]) pour ne plus exposer
  // cette lecture a une passerelle saturee — ce qui elargit d'autant la fenetre
  // pendant laquelle le cron croit encore la cle vivante. Enregistrer apres le
  // transfert reviendrait a rejouer le 10 septembre en quinze fois plus long :
  // 106 sejours etaient repartis sous l'ancienne cle « dans les minutes suivant
  // un transfert pourtant verifie a 0 ligne restante ».
  //
  // ⚠ ET ON ATTEND CETTE FENETRE. `noterCleMigree` vide le cache du processus
  // COURANT — celui de ce script. Le cron tourne ailleurs : son cache a lui
  // n'expire que par TTL. Tant qu'il n'a pas expire, il rapatriera ce qu'on
  // deplace. L'attente est le prix du cache long, et elle se paie une fois par
  // migration, pas une fois par cycle.
  // Sans cet enregistrement, `api/cron.js` — qui boucle sur la liste LIVE du
  // compte Beds24, ou le bien reste volontairement — rematerialise la fiche au
  // cycle suivant, reecrit les sejours sous l'ANCIENNE cle et renvoie des
  // messages au voyageur depuis la chaine Beds24. Mesure du 10 septembre :
  // 106 des 786 sejours de La bulle etaient repartis sous `209413` dans les
  // minutes suivant un transfert pourtant verifie a 0 ligne restante.
  // Le transfert et cet enregistrement sont UN SEUL geste.
  // ⚠ DEPUIS QUE LA CLE EST ENREGISTREE AVANT LE TRANSFERT, SON ECHEC ARRETE
  // TOUT — CORRECTIF DE REVIEW. Le `catch` d'origine avait ete ecrit pour
  // l'ordre ANCIEN : il journalisait « Le transfert est fait » (desormais faux),
  // posait un code de sortie et CONTINUAIT. Le script attendait alors quinze
  // minutes, affichait « ✓ fenetre ecoulee, le cron connait la cle migree » —
  // un mensonge — puis deplacait les lignes SANS aucune garde enregistree.
  // C'est le 10 septembre a l'identique, avec en prime un compte a rebours
  // rassurant. L'enregistrement est la CONDITION du transfert : il leve.
  //
  // ⚠ ET L'ERREUR DU SELECT EST LUE. Sans `error`, une lecture en echec rendait
  // `src = null`, le bloc entier etait saute SANS UN MOT, et le transfert
  // partait non protege — en silence total. La panne qui produit ce cas est
  // exactement celle que ce lot traite : une passerelle saturee.
  const { data: src, error: eSrc } = await supabase.from('properties')
    .select('user_id, provider, provider_property_id').eq('id', C.source).maybeSingle()
  if (eSrc) throw new Error(`lecture de la fiche source : ${eSrc.message}`)
  if (!src) throw new Error(`fiche source ${C.source} introuvable — transfert impossible`)
  if (!src.provider_property_id) {
    throw new Error(`la fiche source n'a pas de provider_property_id : rien a enregistrer `
      + `comme migre, donc rien ne protegerait le transfert. Refus.`)
  }

  await noterCleMigree(supabase, {
    userId: src.user_id,
    provider: src.provider,
    propId: src.provider_property_id,
    cibleFiche: C.cible
  })
  console.log(`\n✓ cle ${src.provider} ${src.provider_property_id} enregistree comme MIGREE`)
  console.log('   le cron ne la materialisera plus, ne la synchronisera plus,')
  console.log('   et n\'enverra plus de message depuis cette chaine.')

  // ⚠ TOUT ARRET ENTRE ICI ET LE TRANSFERT LAISSE UN BIEN MORT-VIVANT : marque
  // migre, donc ignore par la synchro, les messages, les codes et les avis — et
  // pourtant pas transfere. Invisible, sans alerte. On annule donc
  // l'enregistrement sur TOUS les chemins de sortie, y compris un Ctrl-C
  // pendant le decompte de quinze minutes, qui est precisement le moment ou un
  // operateur croit le script fige.
  const annulerEnregistrement = async (motif) => {
    try {
      await retirerCleMigree(supabase, {
        userId: src.user_id, provider: src.provider, propId: src.provider_property_id
      })
      console.error(`\n✓ enregistrement de la cle migree ANNULE (${motif})`)
      console.error('   le bien redevient synchronise : il n\'est ni transfere ni mort-vivant.')
    } catch (e) {
      console.error(`\n⚠⚠ ANNULATION DE LA CLE MIGREE ECHOUEE : ${e.message}`)
      console.error(`   ETAT A REPARER A LA MAIN : la cle ${src.provider_property_id} est`)
      console.error('   enregistree comme migree alors que RIEN n\'a ete transfere. Le bien')
      console.error('   est invisible du cron. Supprimer la ligne dans provider_keys_migrated.')
    }
  }
  const surInterruption = () => {
    console.error('\n\n⚠ INTERRUPTION pendant l\'attente — rien n\'a ete transfere.')
    annulerEnregistrement('interruption').finally(() => process.exit(130))
  }
  process.on('SIGINT', surInterruption)
  process.on('SIGTERM', surInterruption)

  await attendreFenetreDeCache({ sauter: RAISON_SANS_ATTENTE })

  // 2) Le transfert, en une transaction.
  const { data, error } = await supabase.rpc('transferer_bien',
    { p_source: C.source, p_cible: C.cible })
  if (error) {
    console.error(`\nTRANSFERT REFUSE : ${error.message}`)
    // ⚠ ON REND LA PAUSE. Une source pausee sans transfert coupe les messages
    // et les codes du voyageur pour rien.
    await supabase.from('properties')
      .update({ automation_paused: false, paused_reason: null }).eq('id', C.source)
    console.error('pause rendue sur la source (aucune donnee deplacee)')
    // ⚠ ET L'ENREGISTREMENT AUSSI. Rendre la pause sans annuler la cle laissait
    // le bien « actif » a l'ecran alors que TOUT le cron l'ecarte — le pire des
    // deux etats, puisqu'il ne se voit pas.
    await annulerEnregistrement('transfert refuse')
    process.exitCode = 1
    return
  }

  console.log('\n── lignes deplacees')
  let total = 0
  for (const r of data) {
    total += Number(r.deplacees)
    if (Number(r.deplacees)) {
      console.log(`   ${String(r.famille).padEnd(16)} ${String(r.nom_table + '/' + r.colonne).padEnd(44)} ${r.deplacees}`)
    }
  }
  console.log(`   TOTAL ${total}`)

  // ⚠ LES REFERENCES TENUES COMME CLES DANS UN JSONB.
  // Troisieme angle mort de mes inventaires, trouve en review : ni le nom de la
  // colonne (`config`) ni ses valeurs ne parlent de bien — la reference est une
  // CLE d'objet. Mesure : l'entree `209413` de `agent_alert_config.config`
  // portait `mode: 'auto'` et les destinataires d'alerte ; la fiche neuve
  // n'ayant rien, `getPropertyMode` retombait sur `'test'` et l'agent IA du
  // bien migre etait muet, sans une ligne de log.
  // ⚠ `T` N'EXISTAIT PAS ICI — nom de variable emprunte a un autre script.
  // Le transfert du 23 s'est termine sur `T is not defined` APRES avoir tout
  // deplace et enregistre la cle migree : le re-keying des cles JSON n'a donc
  // pas eu lieu, et l'agent IA du bien serait reste muet. Trouve en production,
  // le 11 septembre 2026. On relit la cible plutot que de supposer.
  const { data: cib } = await supabase.from('properties')
    .select('provider_property_id').eq('id', C.cible).maybeSingle()
  if (src && src.provider_property_id && cib && cib.provider_property_id) {
    const faits = await rekeyerJson(src.provider_property_id, cib.provider_property_id,
      { ecrire: true, userId: src.user_id })
    if (faits.length) {
      console.log('\n── references en cles JSON')
      for (const f of faits) console.log('   ' + JSON.stringify(f))
    }
  }

  const apres = await audit('APRES')
  const resteSource = Object.values(apres.par).reduce((n, v) => n + v.s, 0)
  console.log(`\n${resteSource === 0 ? '✓' : '⚠'} reste ${resteSource} ligne(s) cote source (0 attendu)`)

  const { count } = await supabase.from('rekeying_backup')
    .select('*', { count: 'exact', head: true }).eq('bien_id', C.source)
  console.log(`✓ ${count} entree(s) de sauvegarde dans rekeying_backup`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
