#!/usr/bin/env node
// scripts/verifier-migration-delai-ia.js — la migration du lot 1 du chantier
// « delai de reponse IA » (migrations/2026-10-27-delai-reponse-ia.sql) est-elle
// appliquee, et sous la bonne FORME ? Regle du 25 septembre 2026 : on ne colle
// que la migration, la verification passe par un script qui imprime son
// empreinte avant de mesurer.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-delai-ia.js
//
// ⚠ LECTURE SEULE. Aucune ecriture, aucun upsert, aucune suppression.
//
// ⚠ LA FORME, PAS L'EXISTENCE. Chaque colonne attendue est lue par son NOM
// (`select <colonne> limit 0`) : une colonne absente ou mal nommee est une
// erreur, pas un silence. Et la requete ATTENDUE DU LOT 2 est jouee (filtre sur
// status + borne d'echeance + tri + limite), parce qu'une colonne qui existe ne
// prouve pas qu'on peut filtrer dessus.
//
// ⚠ « ATTENDUE », PAS « CELLE DU CRON » (constat de la revue du 27 octobre
// 2026) : `lib/guestflow/brouillons-dus.js` n'existe pas encore. Annoncer
// qu'on rejoue la requete du cron « telle quelle » serait une affirmation que
// rien ne peut verifier — et elle resterait ecrite apres que le cron ait
// change.
//
// ⚠ CE QUE CE SCRIPT NE PEUT PAS PROUVER, ET IL LE DIT : les deux index
// partiels. PostgREST n'expose pas le catalogue (dette 32, meme limite que
// verifier-migration-grille-hote.js). La requete du cron prouve que le filtre
// REPOND ; elle ne prouve pas qu'il est INDEXE. Au volume actuel (imprime en
// tete par l'empreinte) la difference ne se voit pas — a 30 000 comptes, elle
// est tout. La relecture du
// fichier de migration couvre les index, et rien d'autre ici ne le remplace.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const COLONNES = ['send_after', 'alert_after', 'suspendu_le', 'modifie_le']

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  // ─── Empreinte : OU mesure-t-on ? Et le refus s'il n'y a pas de reponse ───
  const { count, error } = await sb.from('agent_tasks').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) {
    console.error('ECHEC : empreinte illisible', error ? error.message : '')
    process.exit(1)
  }
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Base ${base} · agent_tasks = ${count} ligne(s)`)
  if (base === 'INCONNUE') {
    console.error('ECHEC : projet Supabase inconnu — ni la production, ni staging.')
    console.error("Un resultat qui ne dit pas OU il a ete obtenu ne prouve rien.")
    process.exit(1)
  }

  let echecs = 0

  // ─── 1. Les quatre colonnes, par leur nom ────────────────────────────────
  let manquantes = 0
  for (const c of COLONNES) {
    const { error: e } = await sb.from('agent_tasks').select(c).limit(0)
    if (e) { manquantes++; console.log(`  ✖ agent_tasks.${c} : ${e.message}`) }
  }
  echecs += manquantes
  // ⚠ LE COMPTEUR EST LOCAL, ET C'EST UN DEFAUT DU MODELE QU'ON NE REPRODUIT
  // PAS : dans verifier-migration-grille-hote.js, le `✔` est garde par le
  // compteur GLOBAL, donc un echec sur la premiere table prive les suivantes
  // de leur ligne de reussite — la sortie devient muette la ou elle devrait
  // informer.
  if (!manquantes) console.log(`  ✔ agent_tasks : ${COLONNES.length} colonnes lues par leur nom`)

  // ─── 2. La requete du cron, rejouee telle quelle ─────────────────────────
  // C'est la lecture du lot 2 (lib/guestflow/brouillons-dus.js) : les taches
  // ECHUES, bornees, triees. Si elle repond, la forme tient.
  const maintenant = new Date().toISOString()
  // ⚠ `suspendu_le` NE FILTRE QUE LES BROUILLONS (constat de la meme revue). Il
  // etait applique aux deux requetes : une suspension de brouillon — l'hote a
  // ouvert la proposition pour la modifier — aurait masque l'alerte
  // `info_unknown` du meme sejour, qui n'a rien a voir avec elle.
  for (const [etiquette, statut, colonne, filtreSuspension] of [
    ['brouillons dus', 'pending_validation', 'send_after', true],
    ['alertes dues', 'pending', 'alert_after', false]
  ]) {
    let q = sb.from('agent_tasks')
      .select('id')
      .eq('status', statut)
      .not(colonne, 'is', null)
      .lte(colonne, maintenant)
    if (filtreSuspension) q = q.is('suspendu_le', null)
    const { data, error: e } = await q
      .order(colonne, { ascending: true })
      .limit(5)
    if (e) { echecs++; console.log(`  ✖ requete « ${etiquette} » : ${e.message}`) }
    else console.log(`  ✔ requete « ${etiquette} » : repond (${data.length} echue(s) a l instant)`)
  }

  // ─── 3. Les colonnes sont-elles NULLES partout ? ─────────────────────────
  // Au lot 1 elles doivent l'etre : rien ne les ecrit encore. Une valeur
  // signifierait qu'un defaut a ete pose par la migration — donc un envoi
  // automatique arme sur des lignes que personne n'a examinees.
  //
  // ⚠ MAIS CE CONTROLE DEVIENDRA FAUX AU LOT 2, ET IL NE DOIT PAS CRIER AU
  // LOUP (constat de la revue du 27 octobre 2026). Des que `cron-classify`
  // posera legitimement `send_after`, un ✖ « un depart automatique est arme »
  // s'imprimerait a chaque passage — la fausse alarme que le depot interdit
  // partout ailleurs, et qu'on apprend a ignorer.
  //
  // Il est donc INFORMATIF par defaut, et ne compte un echec que si on le lui
  // demande : `AUCUN_ARMEMENT_ATTENDU=1`, a passer pendant la recette du lot 1.
  const exigerAucunArmement = process.env.AUCUN_ARMEMENT_ATTENDU === '1'
  for (const c of ['send_after', 'alert_after']) {
    const { count: n, error: e } = await sb.from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .not(c, 'is', null)
    if (e) { echecs++; console.log(`  ✖ comptage ${c} : ${e.message}`) }
    else if (n > 0 && exigerAucunArmement) {
      echecs++
      console.log(`  ✖ ${c} : ${n} ligne(s) NON NULLES, alors qu AUCUN_ARMEMENT_ATTENDU=1`)
    } else if (n > 0) {
      console.log(`  · ${c} : ${n} ligne(s) armee(s) — normal des le lot 2`)
    } else {
      console.log(`  ✔ ${c} : aucune ligne non nulle`)
    }
  }
  if (!exigerAucunArmement) {
    console.log('  (AUCUN_ARMEMENT_ATTENDU=1 pour exiger que rien ne soit encore arme — recette du lot 1)')
  }

  // ─── 4. Sonde du navigateur : la table reste fermee sans session ─────────
  if (!process.env.SUPABASE_ANON_KEY) {
    console.log('  (sonde navigateur non faite : SUPABASE_ANON_KEY absente de ce fichier d environnement)')
  } else if (count === 0) {
    // ⚠ « AUCUNE LIGNE » N'EST PAS « FERME », ET C'EST UN FAUX VERT DEJA VECU
    // (constat de la revue du 27 octobre 2026). Sur une table VIDE — et le
    // compte imprime plus haut peut valoir 0 — la cle anon rend zero ligne
    // quelle que soit la RLS : la sonde affichait ✔ sur une table grande
    // ouverte. Un verificateur qui n'a rien lu ne doit pas rassurer.
    console.log('  ⚠ sonde navigateur IMPOSSIBLE : agent_tasks est vide, zero ligne ne prouve rien')
  } else {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data, error: e } = await anon.from('agent_tasks').select('id').limit(1)
    if (e && /schema cache|does not exist/i.test(e.message || '')) {
      echecs++; console.log('  ✖ sonde navigateur : agent_tasks absente')
    } else {
      // La table PORTE des lignes (count > 0) : zero ligne rendue a la cle
      // anon est donc bien le fait de la RLS, et pas du vide.
      const ferme = !!e || !(data || []).length
      if (!ferme) echecs++
      console.log(`  ${ferme ? '✔' : '✖'} sonde navigateur : ${ferme ? 'aucune ligne lisible sans session' : 'DES LIGNES SONT LISIBLES SANS SESSION'}`)
    }
  }

  if (echecs) {
    console.error(`ECHEC : ${echecs} ecart(s) — migration absente, incomplete, ou colonnes deja armees.`)
    process.exit(2)
  }
  console.log('Migration 2026-10-27-delai-reponse-ia : conforme sur ce que l API permet de prouver.')
  console.log('(Les DEUX INDEX PARTIELS ne sont pas prouves ici — voir l en-tete.)')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
