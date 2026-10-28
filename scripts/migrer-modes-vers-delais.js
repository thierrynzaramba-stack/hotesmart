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
const { nomDeLaBase } = require('../lib/empreinte-base')
const { reponseIaValide, formeExploitable } = require('../lib/guestflow/delais-contrat')

const GO = process.argv.includes('--go')
const SOURDINE_PAR_DEFAUT = { active: false, debut: '22:00', fin: '08:00' }

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
