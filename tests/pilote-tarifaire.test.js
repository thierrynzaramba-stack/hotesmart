// tests/pilote-tarifaire.test.js — lot 4.5, LE PILOTE TARIFAIRE PAR BIEN.
// Spec : docs/specs/spec-yieldflow-v1.md §2 bis
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. la garde est SERVEUR — le bandeau n'a jamais rien protege ;
//   2. le pilote n'emporte QUE le tarif : fermer une nuit reste possible ;
//   3. un bien en `keep` ne bascule pas, et on le lui DIT en francais ;
//   4. le defaut ne change rien pour personne.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const {
  MODES, DEFAUT, piloteDuBien, pilotParYield, pousseSesPrix,
  peutPasserEnYieldflow, peutCouperLaPousseeDesPrix,
  refusEcritureTarifaire, datesTarifees
} = require('../lib/pilote-tarifaire')

// Le meme depliage que `api/calendar.js`, pour eprouver la collecte pour de vrai.
// ⚠ EN HEURE LOCALE, comme `toLocalISO` la-bas — surtout pas `toISOString()`.
// Premiere version de ce helper : `toISOString()` rendait « 2026-09-30 » pour
// le 1er octobre, parce qu'un `Date` local passe en UTC recule d'une heure.
// C'est la regle du depot (« un instant sans fuseau est lu en heure locale, et
// ca duplique en silence ») attrapee ici par le test lui-meme.
const jourLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`
const expandDays = (from, to, days) => {
  const out = []
  const d = new Date(from + 'T00:00:00')
  const last = new Date(to + 'T00:00:00')
  while (d <= last) {
    if (!days || !days.length || days.includes(d.getDay())) out.push(jourLocal(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

// ─── 1. Le defaut ne change rien ────────────────────────────────────────────
test('LE TEST QUI COMPTE : sans geste de l hote, RIEN ne change', () => {
  // La colonne vient d'etre creee : tous les biens existants la portent a
  // 'calendrier'. Un bien lu avant la migration (colonne absente) doit se
  // comporter pareil, sinon le deploiement couperait la saisie de prix entre
  // la mise en ligne du code et l'application du SQL.
  assert.equal(DEFAUT, 'calendrier')
  assert.equal(piloteDuBien({}), 'calendrier', 'colonne absente')
  assert.equal(piloteDuBien({ pilote_tarifaire: null }), 'calendrier')
  assert.equal(piloteDuBien(null), 'calendrier', 'bien absent')
  assert.equal(piloteDuBien({ pilote_tarifaire: 'YIELDFLOW' }), 'calendrier',
    'la casse ne bascule pas un bien')
  assert.equal(piloteDuBien({ pilote_tarifaire: 'moteur' }), 'calendrier',
    'une valeur inventee est lue comme le mode le moins surprenant')
  assert.equal(piloteDuBien({ pilote_tarifaire: 'yieldflow' }), 'yieldflow')
  assert.deepEqual(MODES, ['calendrier', 'yieldflow'], 'deux modes, pas trois')
})

test('un bien non bascule n est PAS pilote par yield', () => {
  assert.equal(pilotParYield({}), false)
  assert.equal(pilotParYield({ pilote_tarifaire: 'calendrier' }), false)
  assert.equal(pilotParYield({ pilote_tarifaire: 'yieldflow' }), true)
})

// ─── 2. Le pilote n emporte QUE le tarif ────────────────────────────────────
test('LE TEST QUI COMPTE : fermer une nuit reste possible en mode yieldflow', () => {
  // ⚠ C'EST LA REGRESSION DU 7 SEPTEMBRE QU'ON EMPECHE DE REVENIR.
  // Un refus qui engloberait le segment entier empecherait l'hote de fermer
  // une nuit — la memoire d'intention commerciale et l'anti-surreservation ne
  // changent pas de mains (arbitrage B du §2 bis).
  const dispo = [{ date_from: '2026-10-01', date_to: '2026-10-03', avail: 1 }]
  assert.deepEqual(datesTarifees(dispo, expandDays), [],
    'un segment de disponibilite ne porte aucun tarif : rien a refuser')

  const fermeture = [{ date_from: '2026-10-01', date_to: '2026-10-02', stop_sell: true }]
  assert.deepEqual(datesTarifees(fermeture, expandDays), [],
    'fermer a la vente reste au calendrier DANS LES DEUX MODES')

  const sejourMin = [{ date_from: '2026-10-01', date_to: '2026-10-01', min_stay_arrival: 3 }]
  assert.deepEqual(datesTarifees(sejourMin, expandDays), [])
})

test('LE TEST QUI COMPTE : un tarif, lui, est collecte — meme a zero', () => {
  // `rate: 0` est le pire cas du depot (Channex l'ignore et garde la grille) :
  // il doit etre vu comme un tarif, pas comme une absence de tarif.
  assert.deepEqual(datesTarifees([{ date_from: '2026-10-01', date_to: '2026-10-01', rate: 0 }], expandDays),
    ['2026-10-01'], 'zero est un tarif')
  assert.deepEqual(datesTarifees([{ date_from: '2026-10-01', date_to: '2026-10-03', rate: 120 }], expandDays),
    ['2026-10-01', '2026-10-02', '2026-10-03'])
  // Le filtre `days` est respecte : on ne refuse pas des nuits que la requete
  // ne touchait pas.
  const weekends = datesTarifees(
    [{ date_from: '2026-10-01', date_to: '2026-10-11', rate: 90, days: [0, 6] }], expandDays)
  assert.equal(weekends.length, 4, 'samedis et dimanches du 1er au 11 octobre')
  // Un segment mixte : c'est le tarif qui declenche, pas le reste.
  assert.deepEqual(datesTarifees(
    [{ date_from: '2026-10-01', date_to: '2026-10-01', avail: 1, stop_sell: false, rate: 100 }],
    expandDays), ['2026-10-01'])
  assert.deepEqual(datesTarifees([], expandDays), [])
  assert.deepEqual(datesTarifees(null, expandDays), [], 'pas de segments : pas de refus')
})

// ─── 3. La garde est SERVEUR, et placee AVANT toute ecriture ────────────────
test('LE TEST QUI COMPTE : la garde refuse AVANT la moindre ecriture', () => {
  // Une garde posee apres l'ecriture de la configuration du bien laisserait
  // passer une ecriture — et le prix plancher a deja paye cette lecon
  // (l'upsert avait lieu avant la construction de la charge ARI).
  const src = lire('api/calendar.js')
  const iGarde = src.indexOf('PILOTE TARIFAIRE : LE CALENDRIER N\'ECRIT PAS')
  assert.ok(iGarde > 0, 'la garde existe')
  const iConfig = src.indexOf("from('properties').update(propUpdates)")
  const iPlancher = src.indexOf('PRIX PLANCHER : ON REFUSE A LA PORTE')
  assert.ok(iConfig > 0 && iPlancher > 0)
  assert.ok(iGarde < iConfig, 'AVANT l ecriture de la configuration du bien')
  assert.ok(iGarde < iPlancher, 'et avant le bloc du prix plancher')

  // ⚠ ET RIEN N'ECRIT ENTRE L'ENTREE DANS `save` ET LA GARDE. Comparer deux
  // index connus ne prouve que ces deux-la ; ce qui compte est qu'AUCUNE
  // ecriture ne se glisse avant le refus. On lit donc la tranche entiere.
  const iSave = src.indexOf("if (action !== 'save')")
  assert.ok(iSave > 0 && iSave < iGarde)
  const avant = src.slice(iSave, iGarde)
  for (const ecriture of ['.upsert(', '.insert(', '.update(', '.delete(']) {
    assert.ok(!avant.includes(ecriture),
      `aucun ${ecriture} entre l entree dans save et le refus`)
  }
})

test('LE TEST QUI COMPTE : la garde juge sur une colonne REELLEMENT chargee', () => {
  // ⚠ « Une garde qui juge sur une colonne non selectionnee est une garde
  // ouverte » — le commentaire est dans `api/channel-property.js`, et cette
  // lecon a deja ete payee deux fois (`base_price`, le cran d'arret).
  // `piloteDuBien` rend 'calendrier' quand la colonne manque : oublier la
  // colonne n'aurait donc rien casse de visible, ça aurait juste DESARME la
  // garde en silence.
  const cal = lire('api/calendar.js')
  const cols = cal.match(/const COLS = '[^']+'/)
  assert.ok(cols, 'les colonnes chargees par le calendrier')
  assert.ok(/pilote_tarifaire/.test(cols[0]), 'dont le pilote')
  assert.equal((cal.match(/pilote_tarifaire/g) || []).length >= 2, true,
    'les DEUX selects du calendrier la chargent')

  const chp = lire('api/channel-property.js')
  const selectPatch = chp.split('.eq(\'id\', pid)')[0]
  assert.ok(/pilote_tarifaire/.test(selectPatch),
    'et celui de channel-property, dont la garde neuve juge le pilote')
})

test('le refus du calendrier rend 409 et un message LISIBLE dans `error`', () => {
  // `shared/api-client.js` construit son exception avec `data.error`, jamais
  // avec `data.message`. Un code technique dans `error` s'afficherait tel quel
  // a l'hote — Thierry a deja lu « prix_sous_plancher » et cru que sa saisie
  // avait abouti.
  const r = refusEcritureTarifaire(3)
  assert.equal(r.code, 'pilote_yieldflow')
  assert.ok(/YieldFlow/.test(r.error), 'nomme le pilote')
  assert.ok(/3 tarifs/.test(r.error), 'et combien de nuits sont refusees')
  assert.ok(/disponibilité et la fermeture à la vente/.test(r.error),
    'dit ce qui reste possible ici : sinon l hote croit son calendrier mort')
  assert.ok(!/_/.test(r.error), 'aucun code technique dans le message lisible')
  assert.ok(/1 tarif /.test(refusEcritureTarifaire(1).error), 'accord au singulier')

  const src = lire('api/calendar.js')
  const bloc = src.split('PILOTE TARIFAIRE : LE CALENDRIER N\'ECRIT PAS')[1].slice(0, 1600)
  assert.ok(/status\(409\)/.test(bloc), '409 : un conflit d etat, pas une erreur de saisie')
  assert.ok(/refusEcritureTarifaire/.test(bloc), 'le message vient du module, pas d une recopie')
})

// ─── 4. B bis : keep ne bascule pas, et on le DIT ───────────────────────────
test('LE TEST QUI COMPTE : un bien en `keep` ne peut pas passer en yieldflow', () => {
  // Sinon l'app ecrirait des prix que RIEN ne pousse : une strategie tarifaire
  // invisible des plateformes, et un journal qui ne voit rien.
  assert.equal(pousseSesPrix({ rate_sync_mode: 'managed' }), true)
  assert.equal(pousseSesPrix({ rate_sync_mode: 'keep' }), false)
  assert.equal(pousseSesPrix({}), false, 'sans mode, on ne pousse pas')

  const ok = peutPasserEnYieldflow({ rate_sync_mode: 'managed' })
  assert.equal(ok.ok, true)

  const refus = peutPasserEnYieldflow({ rate_sync_mode: 'keep' })
  assert.equal(refus.ok, false)
  assert.equal(refus.code, 'pilote_refuse_keep')
  assert.ok(/Je garde mes prix/.test(refus.error), 'nomme le reglage dans les mots de l hote')
  assert.ok(/ne partiraient nulle part/.test(refus.error), 'dit POURQUOI')
  assert.ok(/Activez d'abord l'envoi des prix/.test(refus.error), 'et QUEL geste debloque')
  assert.ok(!/_|rate_sync_mode|keep'/.test(refus.error), 'pas de jargon technique')
  assert.equal(peutPasserEnYieldflow(null).ok, false, 'pas de bien : pas de bascule')
})

test('LE TEST QUI COMPTE : la porte INVERSE est fermee aussi', () => {
  // Couper la poussee d'un bien DEJA pilote par YieldFlow atteint le meme etat
  // interdit par l'autre cote. Le §2 bis ne le disait pas.
  assert.equal(peutCouperLaPousseeDesPrix({ pilote_tarifaire: 'calendrier' }).ok, true)
  assert.equal(peutCouperLaPousseeDesPrix({}).ok, true)

  const v = peutCouperLaPousseeDesPrix({ pilote_tarifaire: 'yieldflow' })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'pilote_yieldflow_actif')
  assert.ok(/Repassez-le/.test(v.error), 'dit le geste qui debloque')
  assert.ok(!/_/.test(v.error))

  // Et elle est branchee la ou `keep` s'ecrit, AVANT l'appel reseau qui suit.
  const chp = lire('api/channel-property.js')
  const i = chp.indexOf("if (rate_sync_mode === 'keep') {")
  assert.ok(i > 0)
  const bloc = chp.slice(i, i + 1400)
  assert.ok(/peutCouperLaPousseeDesPrix/.test(bloc), 'la garde est dans la branche keep')
  assert.ok(bloc.indexOf('peutCouperLaPousseeDesPrix') < bloc.indexOf('canauxActifsDuBien'),
    'et avant la verification reseau des canaux : on refuse sans appeler personne')
})

// ─── 5. L endpoint de bascule ───────────────────────────────────────────────
test('LE TEST QUI COMPTE : basculer le pilote exige le droit `reglages`', () => {
  // Basculer change QUI decide les prix : meme consequence qu un prix, donc
  // meme droit que le calendrier tarifaire. Sous `reservations`, un profil qui
  // gere les sejours changerait la main qui tarife.
  const src = lire('api/yield-pilote.js')
  assert.ok(/domaine: ecriture \? 'reglages' : 'reservations'/.test(src))
  assert.ok(/niveau: ecriture \? 'write' : 'read'/.test(src))
  assert.ok(/bienRequis: true/.test(src), 'un bien est toujours designe')
})

test('l endpoint ne pousse aucun prix et ne touche a aucun autre reglage', () => {
  // Basculer est un changement d ECRIVAIN, pas de tarif : les lignes
  // `calendar_inventory` en place restent, le journal continue.
  const src = lire('api/yield-pilote.js')
  const update = src.match(/\.update\(\{[^}]*\}\)/g) || []
  assert.equal(update.length, 1, 'une seule ecriture')
  assert.ok(/pilote_tarifaire: voulu/.test(update[0]), 'et elle ne porte que le pilote')
  // ⚠ ON CHERCHE UN APPEL, PAS UN MOT. La premiere version testait
  // `/channel/i` sur toute la source : elle a rougi sur un COMMENTAIRE citant
  // `api/channel-property.js`. Un test qui lit des mots dans des commentaires
  // mesure la redaction, pas le comportement.
  assert.ok(!/require\('\.\.\/lib\/channels/.test(src), 'aucun acces au canal')
  assert.ok(!/updateAvailability\(|pousserAri\(/.test(src), 'aucune poussee canal')
  assert.ok(/\.eq\('user_id', compte\)/.test(src), 'le compte est dans le WHERE, pas que dans la garde')
})

test('le meme mode renvoye deux fois n est pas une erreur', () => {
  const src = lire('api/yield-pilote.js')
  assert.ok(/voulu === actuel/.test(src), 'idempotent : l ecran peut renvoyer l etat courant')
  assert.ok(/change: false/.test(src))
})

// ─── 6. La migration ────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : la migration pose le defaut protecteur et les deux filets', () => {
  const sql = lire('migrations/2026-09-18-pilote-tarifaire.sql')
  assert.ok(/default 'calendrier'/.test(sql), 'tous les biens existants en calendrier')
  assert.ok(/not null/.test(sql))
  assert.ok(/check \(pilote_tarifaire in \('calendrier', 'yieldflow'\)\)/.test(sql),
    'un mode invente serait lu « pas yieldflow » par la garde, donc ouvrirait l ecriture')
  assert.ok(/properties_pilote_keep_ck/.test(sql), 'le filet de B bis en base')
  assert.ok(/rate_sync_mode = 'managed'/.test(sql))
  // Lignes courtes : ce SQL se colle a la main dans l editeur Supabase, qui
  // tronque au-dela (constate 3 fois).
  const trop = sql.split('\n').filter(l => l.length > 60)
  assert.deepEqual(trop, [], 'aucune ligne de plus de 60 caracteres')
})

// ─── 7. Ce que la review a trouve, et qui ne doit pas revenir ───────────────
test('LE TEST QUI COMPTE : l endpoint de bascule RELIT le bien', () => {
  // ⚠ IL JUGEAIT SUR `garde.bien`, QUI NE PORTE PAS CES COLONNES.
  // `resoudreBien` ne selectionne que id, user_id, name, provider,
  // provider_property_id, migration_target_property_id. `pilote_tarifaire` et
  // `rate_sync_mode` y valaient donc `undefined` : le GET annonçait
  // « bascule impossible » pour TOUS les biens, le POST vers yieldflow rendait
  // 409 toujours, et le retour vers 'calendrier' repondait 200 « rien a faire »
  // SANS ECRIRE — un bien bascule restait verrouille sans issue par l ecran.
  const src = lire('api/yield-pilote.js')
  const perm = lire('lib/require-permission.js')
  assert.ok(!/select\('id, user_id, name, provider, provider_property_id, migration_target_property_id, pilote/.test(perm),
    'la garde ne charge toujours pas le pilote : la relecture reste donc necessaire')
  const iRelecture = src.indexOf("select('id, name, rate_sync_mode, pilote_tarifaire')")
  assert.ok(iRelecture > 0, 'l endpoint relit le bien avec les colonnes qu il juge')
  const iDecision = src.indexOf('peutPasserEnYieldflow(bien)')
  assert.ok(iRelecture < iDecision, 'AVANT de decider')
  assert.ok(/\.eq\('user_id', compte\)/.test(src.slice(iRelecture, iRelecture + 320)),
    'et la relecture porte son cloisonnement')
})

test('LE TEST QUI COMPTE : la colonne absente ne tue pas la LECTURE du calendrier', () => {
  // Si le code part avant la migration, PostgREST fait echouer le select
  // entier : tout l ecran tombe, lecture comprise. L ordre « migration
  // d abord » reste vrai, mais un ordre est un geste, et un geste s oublie.
  const src = lire('api/calendar.js')
  assert.ok(/const colonneAbsente/.test(src), 'le cas est reconnu')
  assert.ok(/sansPilote/.test(src), 'et la lecture est rejouee sans la colonne')
  assert.equal((src.match(/colonneAbsente\(/g) || []).length, 2,
    'les DEUX selects de biens sont couverts')
  assert.ok(/migration 2026-09-18-pilote-tarifaire\.sql non appliquee/.test(src),
    'et le journal dit quoi faire')
})

test('LE TEST QUI COMPTE : les trois ecrans retirent le TARIF, pas la fermeture', () => {
  // Le serveur refuse TOUTE la requete des qu elle porte un `rate`. Si un ecran
  // envoie quand meme le tarif avec une fermeture saisie au meme moment, l hote
  // perd AUSSI sa fermeture — alors que l arbitrage B la lui promet.
  const bureau = lire('pages/biens-calendrier.html')
  const mobile = lire('pages/calendrier-mobile.html')
  assert.ok(/estPiloteYield\(sel\.bienId\)/.test(bureau), 'saisie en ligne')
  assert.ok(/p\.key==='rate'&&estPiloteYield\(popupBienId\)/.test(bureau), 'popup des parametres')
  assert.ok(/p\.type==='price'&&currentBien&&currentBien\.pilote_tarifaire==='yieldflow'/.test(mobile),
    'et le mobile, qui n avait aucune garde')
  // Le retrait se DIT : un tarif retire en silence est un tarif que l hote
  // croit avoir pose.
  for (const [nom, src] of [['bureau', bureau], ['mobile', mobile]]) {
    assert.ok(/tarifIgnore/.test(src), `${nom} : le retrait est trace`)
    assert.ok(/pilotés par YieldFlow/.test(src), `${nom} : et annonce a l hote`)
    assert.ok(/Le reste de votre saisie, lui, est bien pris en compte/.test(src),
      `${nom} : en disant que le reste est passe`)
  }
})

test('apres un refus, l ecran ne montre pas des prix qui n existent pas', () => {
  // L etat local est mute et re-rendu AVANT l envoi : sans relecture, l hote
  // lit une erreur en VOYANT ses nouveaux prix, et les croit enregistres.
  const src = lire('pages/biens-calendrier.html')
  const catches = src.match(/catch\(err\)\{[^}]*\}/g) || []
  const sauvegardes = catches.filter(c => /sauvegarde/.test(c))
  assert.ok(sauvegardes.length >= 2, 'les deux chemins d ecriture ont un catch')
  for (const c of sauvegardes) {
    assert.ok(/reloadInventory\(\)/.test(c), `un catch sans relecture : ${c.slice(0, 60)}`)
  }
})

test('le second ecrivain de `rate_sync_mode` est garde lui aussi', () => {
  // `api/channel-property.js` n etait pas le seul : l assistant de migration
  // ecrit `keep` en direct. Un bien pilote y heurtait la contrainte postgres,
  // et l hote lisait « violates check constraint » — le jargon meme que l autre
  // chemin prend soin d eviter.
  const src = lire('lib/migration-mode-prix.js')
  assert.ok(/peutCouperLaPousseeDesPrix/.test(src), 'la garde est branchee')
  const i = src.indexOf('peutCouperLaPousseeDesPrix(bien)')
  const iEcriture = src.indexOf("update({ rate_sync_mode: mode })")
  assert.ok(i > 0 && i < iEcriture, 'et elle refuse AVANT d ecrire')
  // Et le bien qu elle juge porte la colonne.
  assert.ok(/pilote_tarifaire/.test(lire('api/migration.js')),
    'l appelant charge la colonne, sinon la garde lit undefined et s ouvre')
})

test('l ecran ne promet pas ce que le lot 4.6 apportera', () => {
  // « Les prix se travaillent ici, et vous validez chaque tarif » etait faux :
  // le lot 4.5 n ouvre aucune ecriture cote Yield. Un hote qui bascule FIGE ses
  // prix, et rien ne l en avertissait.
  const src = lire('apps/yield/prix.html')
  assert.ok(/basculer FIGE les prix de ce logement/.test(src),
    'le choix dit ce qu il fait AUJOURD HUI')
  assert.ok(/YieldFlow ne propose pas\s*'\s*\+\s*'\s*encore de tarifs|ne propose pas/.test(src),
    'et l etat bascule le redit')
  assert.ok(/enCoursPilote/.test(src), 'le jeton anti-course protege l affichage du pilote')
})

test('LE TEST QUI COMPTE : le refus intercepte AVANT que l ecran ne peigne', () => {
  // ⚠ DEFAUT TROUVE PAR THIERRY EN RECETTE SUR STAGING, 20 septembre 2026.
  // La garde de la popup etait posee APRES la boucle qui mute l etat local :
  // elle empechait bien l ENVOI, mais `st[i].rate` etait deja ecrase et
  // `renderBlocks()` avait peint le nouveau prix. Comme plus aucune requete ne
  // partait, aucun `catch` ne se declenchait, donc aucune relecture du cœur —
  // le prix refuse restait AFFICHE jusqu au prochain rechargement. « Un hote
  // croirait son prix pris en compte. »
  //
  // La lecon depasse ce fichier : empecher l envoi ne suffit pas quand l ecran
  // a deja peint. Un refus doit intercepter AVANT la mutation, sinon il faut
  // defaire — et defaire, ca s oublie.
  const src = lire('pages/biens-calendrier.html')
  const iGarde = src.indexOf("p.key==='rate'&&estPiloteYield(popupBienId)")
  const iMutation = src.indexOf("st[i][p.key]=computeNewRate")
  assert.ok(iGarde > 0, 'la garde de la popup existe')
  assert.ok(iMutation > 0, 'la mutation de l etat local existe')
  assert.ok(iGarde < iMutation,
    'la garde doit preceder la mutation : sinon l ecran peint un prix refuse')

  // La saisie en ligne refuse avant meme d ouvrir le champ.
  const iInline = src.indexOf("sel.row==='rate'&&estPiloteYield(sel.bienId)")
  const iChamp = src.indexOf("cell.innerHTML='<input class=\"rate-input\"")
  assert.ok(iInline > 0 && iChamp > 0 && iInline < iChamp,
    'la saisie en ligne refuse avant d ouvrir le champ')

  // Le mobile ne mute aucun etat local : sa garde precede le seul push.
  const mob = lire('pages/calendrier-mobile.html')
  const iGardeMob = mob.indexOf("p.type==='price'&&currentBien")
  const iPush = mob.indexOf('segments.push({date_from:sISO,date_to:eISO,days:daysArr,rate:')
  assert.ok(iGardeMob > 0 && iPush > 0 && iGardeMob < iPush,
    'le mobile refuse avant de construire le segment tarifaire')
})
