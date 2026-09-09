// lib/migration-ari.js
// ETAPE « pousser l'ARI vers la propriete cible » — assistant de migration.
// Spec : docs/specs/spec-assistant-migration.md
// Plan : docs/specs/plan-bascule-jour-j.md, phase 0.3.
//
// ⚠ CE MODULE NE POUSSE RIEN LUI-MEME. Il garde, il montre, et il appelle
// `runFullSync` (lib/channel-fullsync.js) — le writer UNIQUE de l'ARI 500 jours.
// Un second pousseur « pour la migration » aurait fini par envoyer autre chose
// que le chemin de tous les jours, et c'est exactement ce qu'on ne veut pas
// decouvrir le jour J.
//
// ⚠ L'ETAT SE LIT CHEZ LA CIBLE, PAS DANS UN DRAPEAU LOCAL.
// « Une colonne dit que c'est pousse » et « la propriete cible porte les prix »
// ne sont pas la meme phrase. La seconde est la seule qui protege le jour J :
// une poussee acceptee en HTTP 200 mais perdue en tache de fond se verrait ici,
// et pas dans un drapeau.

const { canPushRates, RATE_PUSH_BLOCKED, proprieteChezLeProvider, estEnMigration, estRelieAuCanal } = require('./rate-sync')
const { runFullSync } = require('./channel-fullsync')

// Horizon de controle. Les nuits tarifees des deux biens de Bagneres tiennent
// dans trois semaines ; 400 jours couvre large sans jamais tronquer.
const HORIZON_CONTROLE_JOURS = 400

// ⚠ FENETRE DE LECTURE BORNEE. Les autres appelants de `GET /restrictions` du
// depot restent a 3 ou 14 jours. Un seul prix saisi loin — une date d'ete —
// ferait passer la requete a 300 jours, et si le provider plafonne ce qu'il
// rend, les dates au-dela passeraient pour manquantes : l'etape dirait « a
// faire » sur un calendrier complet. On controle donc une fenetre courte, et on
// DIT qu'elle est courte.
const FENETRE_LECTURE_JOURS = 90

// ─── Les canaux poses sur la propriete visee ─────────────────────────────────
// ⚠ « EN MIGRATION » NE VEUT PAS DIRE « HORS LIGNE ».
// Le plan de bascule active les canaux Booking et Airbnb sur la propriete CIBLE
// en phase 2.6, et le re-keying n'a lieu qu'en 2.8. Entre les deux, le bien est
// toujours `provider = 'beds24'` avec sa cle source : `estEnMigration` est vrai,
// et une poussee partirait droit vers les OTA — en affirmant le contraire. On ne
// suppose donc pas que la cible est vierge : on le DEMANDE.
async function canauxSurLaCible (call, cible) {
  let rep
  try { rep = await call('GET', `/channels?filter[property_id]=${encodeURIComponent(cible)}`) }
  catch (e) { return { lu: false, detail: e.message } }
  if (!rep || !rep.ok) return { lu: false, detail: `HTTP ${rep && rep.status}` }
  const liste = rep.json?.data || []
  const actifs = liste.filter(c => c?.attributes?.is_active !== false)
  return { lu: true, total: liste.length, actifs: actifs.length }
}

function ymd (d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Ce qui manque pour pouvoir pousser, dit en clair. `null` = on peut.
function raisonDeNePasPousser (bien) {
  if (!bien) return { raison: 'bien_inconnu', message: 'Bien introuvable.' }
  // ⚠ LE PREMIER REFUS, ET LE PLUS IMPORTANT : CETTE ETAPE N'EST PAS UN
  // BOUTON « POUSSER » GENERIQUE.
  // Sans lui, l'action acceptait un bien VIVANT chez Channex — canaux Booking et
  // Airbnb mappes — et poussait 500 jours vers les OTA, `stop_sell` sur chaque
  // date sans prix, hors du cooldown 24 h et hors de la file serialisee du
  // calendrier. Le chemin de tous les jours (api/calendar.js) reste le seul pour
  // un bien en production ; celui-ci ne sert qu'a un demenagement en cours.
  if (estRelieAuCanal(bien) && !estEnMigration(bien)) {
    return { raison: 'pas_en_migration',
      message: 'Ce logement n\'est pas en cours de migration : son calendrier part par le '
        + 'chemin habituel, avec ses gardes (delai de 24 h, file d\'attente). Cette etape ne '
        + 'sert qu\'a remplir la propriete cible d\'un demenagement.' }
  }
  if (!proprieteChezLeProvider(bien)) {
    return { raison: 'pas_de_destination',
      message: 'Ce logement n\'existe pas encore chez le nouveau provider : il n\'y a nulle part '
        + 'ou pousser. Faire d\'abord l\'etape « Logement cree chez le nouveau provider ».' }
  }
  if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
    return { raison: 'ids_canal_manquants',
      message: 'Le room type ou le rate plan manque : l\'ARI n\'aurait pas ou se poser. '
        + 'Reprendre l\'etape de creation du logement.' }
  }
  // ⚠ LE MODE DE PRIX EST UNE DECISION DE L'HOTE, ET ELLE TIENT PENDANT LA
  // MIGRATION. Un bien en « je garde mes prix » ne pousse aucun tarif — meme
  // pour demenager. C'est a l'hote de passer en « HoteSmart gere mes prix »,
  // en connaissance de cause : apres la bascule, l'ancien provider ne poussera
  // plus rien, et un bien reste en `keep` ne serait vendable nulle part.
  if (!canPushRates(bien)) {
    return { raison: 'mode_keep',
      message: RATE_PUSH_BLOCKED.message
        + ' Attention : apres la bascule, l\'ancien provider ne poussera plus vos prix.' }
  }
  return null
}

// ─── L'ACTION ────────────────────────────────────────────────────────────────
// `dryRun` calcule les 500 memes dates et s'arrete avant le premier appel.
async function pousserAri (bien, { dryRun = true, appel = null } = {}) {
  const refus = raisonDeNePasPousser(bien)
  // ⚠ UN APERCU N'EST PAS UNE POUSSEE, ET LE MODE DE PRIX NE DOIT PAS L'INTERDIRE.
  // Refuser de MONTRER a un hote en « je garde mes prix » ce que la publication
  // ferait, c'est lui demander de changer son reglage a l'aveugle pour le
  // decouvrir apres. Le mode protege les prix : il bloque l'ecriture, pas la vue.
  // Tous les autres refus tiennent, y compris en apercu — eux disent que l'etape
  // n'a pas de sens, pas que l'hote n'a pas encore choisi.
  const seulementPourVoir = dryRun && refus && refus.raison === 'mode_keep'
  if (refus && !seulementPourVoir) return { ok: false, ...refus }

  const cible = proprieteChezLeProvider(bien)
  const call = appel || require('./channels').getProvider('channex').channelCall
  const canaux = await canauxSurLaCible(call, cible)

  // Une lecture qui echoue ne vaut pas « il n'y en a pas ». On refuse d'agir
  // plutot que de pousser en esperant.
  if (!canaux.lu) {
    return { ok: false, raison: 'canaux_illisibles',
      message: 'Impossible de savoir si des canaux sont poses sur la propriete cible '
        + `(${canaux.detail}). Sans cette reponse, on ne peut pas affirmer que cette poussee `
        + 'n\'atteindra aucune plateforme — donc on ne pousse pas.' }
  }
  // Des canaux actifs : la poussee atteindrait les OTA. Le chemin de tous les
  // jours (le calendrier) existe pour ca, avec son delai de 24 h et sa file.
  // Une etape de migration ne contourne pas une garde parce que c'est la migration.
  if (canaux.actifs && !dryRun) {
    return { ok: false, raison: 'canaux_actifs_sur_la_cible',
      message: `${canaux.actifs} canal/canaux ACTIF(S) sur la propriete cible : cette poussee `
        + 'atteindrait Booking et/ou Airbnb. Passer par le calendrier, qui a ses gardes. '
        + 'Cette etape ne sert qu\'a remplir une cible encore hors ligne.' }
  }

  const r = await runFullSync(bien, { dryRun })
  return {
    ok: true,
    dry_run: !!dryRun,
    cible,
    canaux_sur_la_cible: canaux,
    resultat: r,
    // L'apercu d'un bien en mode `keep` montre ce que la publication ferait, et
    // rappelle qu'en l'etat elle ne partira pas.
    avertissement: seulementPourVoir ? refus.message : undefined,
    // ⚠ LA NOTE EST CALCULEE, PAS RECITEE. Elle affirmait « aucun canal n'existe
    // sur la propriete cible » sans l'avoir verifie une seule fois.
    note: (dryRun ? 'Aucun appel d\'ecriture n\'a ete fait. ' : '')
      + (canaux.total
        ? `⚠ ${canaux.total} canal/canaux pose(s) sur la cible, dont ${canaux.actifs} actif(s) : `
          + 'ce qui part d\'ici est visible des plateformes.'
        : 'Aucun canal sur la propriete cible : rien de ceci n\'atteint Booking ni Airbnb.')
      + ' Les nuits sans prix partent FERMEES — fermeture calculee, aucune intention ecrite dans le coeur.'
  }
}

// Les lignes du coeur sur l'horizon. Partagee avec l'etape « mode de prix » :
// deux lectures du meme fait auraient fini par ne plus dire la meme chose.
// `avail` est lu meme quand on ne filtre que les nuits tarifees : c'est lui qui
// dit si la date partirait ouverte.
async function lignesDuCoeur (supabase, bien, jours) {
  const debut = new Date(); debut.setHours(0, 0, 0, 0)
  const fin = new Date(debut); fin.setDate(fin.getDate() + jours)
  const { data, error } = await supabase
    .from('calendar_inventory').select('date, rate, avail')
    .eq('property_id', bien.id).gte('date', ymd(debut)).lte('date', ymd(fin))
    .order('date').limit(1000)
  if (error) return { error: error.message, lignes: [] }
  return { error: null, lignes: data || [] }
}

async function nuitsTarifeesDuCoeur (supabase, bien, jours) {
  const lu = await lignesDuCoeur(supabase, bien, jours)
  if (lu.error) return { error: lu.error, nuits: [] }
  return { error: null, nuits: lu.lignes.filter(l => Number(l.rate) > 0) }
}

// ─── L'ETAT, lu chez la cible ────────────────────────────────────────────────
// `appel` est injectable : les tests n'atteignent jamais le reseau.
async function etatAri (supabase, bien, { appel = null } = {}) {
  const refus = raisonDeNePasPousser(bien)
  // Un blocage en amont se DIT, et n'ouvre pas un appel reseau pour rien.
  if (refus) return { etat: 'bloque', ...refus }

  const cible = proprieteChezLeProvider(bien)
  const debut = new Date(); debut.setHours(0, 0, 0, 0)
  const fin = new Date(debut); fin.setDate(fin.getDate() + HORIZON_CONTROLE_JOURS)

  // Ce que le coeur detient : la reference.
  const lu = await nuitsTarifeesDuCoeur(supabase, bien, HORIZON_CONTROLE_JOURS)
  if (lu.error) return { etat: 'bloque', raison: 'lecture_coeur', message: `Lecture du coeur impossible : ${lu.error}` }
  let duCoeur = lu.nuits
  // ⚠ UN PRIX DE BASE EST UN PRIX. `runFullSync` retombe dessus pour toute date
  // sans exception : un bien a 86 € sans aucune date tarifee pousse 500 dates a
  // 86 €, il n'en ferme aucune. Bloquer sur « aucun prix » aurait dit le
  // contraire de ce que la poussee fait — et l'etape 4 dit deja « fait » sur ce
  // meme bien.
  const surPrixDeBase = !duCoeur.length && Number(bien.base_price) > 0
  if (surPrixDeBase) {
    // Pas de dates tarifees a comparer : on controle la fenetre proche, ou le
    // prix de base doit se retrouver date par date.
    duCoeur = []
    for (let i = 0; i < 30; i++) {
      const d = new Date(debut); d.setDate(d.getDate() + i)
      duCoeur.push({ date: ymd(d), rate: Number(bien.base_price) })
    }
  }
  if (!duCoeur.length) {
    return { etat: 'bloque', raison: 'coeur_sans_prix',
      message: 'Le coeur ne detient aucun prix — ni par date, ni prix de base : la poussee '
        + 'fermerait les 500 dates. Faire d\'abord l\'amorcage des prix.' }
  }

  const call = appel || require('./channels').getProvider('channex').channelCall
  // Fenetre bornee : on ne controle que les dates tarifees des prochains
  // FENETRE_LECTURE_JOURS jours. Les autres restent a verifier au moment ou
  // elles approchent — mieux qu'une requete de 300 jours dont on ignore si le
  // provider la rend entiere.
  const borne = new Date(debut); borne.setDate(borne.getDate() + FENETRE_LECTURE_JOURS)
  const horsFenetre = duCoeur.filter(l => l.date > ymd(borne)).length
  duCoeur = duCoeur.filter(l => l.date <= ymd(borne))
  if (!duCoeur.length) {
    return { etat: 'a_faire', action: 'poussee_ari',
      message: `Aucune nuit tarifee dans les ${FENETRE_LECTURE_JOURS} prochains jours `
        + `(${horsFenetre} plus loin). Rien a controler sur cette fenetre.` }
  }
  const de = duCoeur[0].date
  const a = duCoeur[duCoeur.length - 1].date
  const chemin = `/restrictions?filter[property_id]=${encodeURIComponent(cible)}`
    + `&filter[date][gte]=${de}&filter[date][lte]=${a}&filter[restrictions]=rate,availability`
  let rep
  try { rep = await call('GET', chemin) }
  catch (e) { rep = { ok: false, status: 0, json: { error: e.message } } }
  if (!rep || !rep.ok) {
    // Une panne de lecture BLOQUE : elle ne passe pas pour « rien a faire ».
    return { etat: 'bloque', raison: 'lecture_cible',
      message: `Impossible de lire le calendrier chez le nouveau provider (HTTP ${rep && rep.status}). `
        + 'Sans cette lecture, on ne peut pas affirmer que les prix y sont.' }
  }

  // ⚠ LIMITE CONNUE, ET MESUREE A MOITIE (9 septembre 2026).
  // `filter[restrictions]=rate` rend bien le prix d'un rate plan `per_room` —
  // verifie sur La bulle, 17 dates au prix attendu. Pour un `per_person`, les
  // prix voyagent en `rates[]` par occupation, et on ne sait pas encore si ce
  // meme champ les restitue. Si non, l'etat dirait « a faire » sur un calendrier
  // pourtant pousse. A mesurer a la premiere poussee reelle de « coeur de vie 23 »
  // (plan de bascule, phase 0.3) — pas a supposer maintenant.
  //
  // `data` est indexe par rate_plan, puis par date.
  const parPlan = rep.json?.data || {}
  const duPlan = parPlan[bien.provider_rate_plan_id] || {}
  // ⚠ UN RATE PLAN `per_person` N'ECRIT PAS `rate`, MAIS `rates[]` PAR OCCUPATION
  // — c'est `runFullSync` lui-meme qui le fait (`buildOccupancyRates`). Ne lire
  // que `rate` aurait rendu « aucune nuit tarifee » a vie sur « coeur de vie 23 »,
  // qui est justement en `per_person` a 6 options : l'etape aurait invite a
  // re-pousser un calendrier deja correct, et bloque le critere du jour J.
  const porteUnPrix = (v) => !!v && (Number(v.rate) > 0
    || (Array.isArray(v.rates) && v.rates.some(x => Number(x && x.rate) > 0)))
  const tarifeesChezLaCible = Object.entries(duPlan)
    .filter(([, v]) => porteUnPrix(v)).map(([d]) => d)

  if (!tarifeesChezLaCible.length) {
    return { etat: 'a_faire', action: 'poussee_ari',
      message: `${duCoeur.length} nuit(s) tarifee(s) dans le coeur, aucune chez le nouveau provider. `
        + 'Rien n\'a encore ete pousse.' }
  }
  const manquantes = duCoeur.filter(l => !tarifeesChezLaCible.includes(l.date))
  if (manquantes.length) {
    return { etat: 'a_faire', action: 'poussee_ari',
      message: `${tarifeesChezLaCible.length} nuit(s) tarifee(s) chez le nouveau provider sur les `
        + `${duCoeur.length} du coeur. Manquent : ${manquantes.slice(0, 5).map(l => l.date).join(', ')}`
        + `${manquantes.length > 5 ? '…' : ''}.` }
  }
  if (surPrixDeBase) {
    return { etat: 'fait', action: 'poussee_ari',
      message: `Le prix de base (${bien.base_price} €) est chez le nouveau provider sur les 30 prochains jours. `
        + 'Aucune date tarifee a l\'unite dans le coeur : toutes les nuits partent a ce prix.' }
  }
  return { etat: 'fait', action: 'poussee_ari',
    message: `Les ${duCoeur.length} nuit(s) tarifee(s) du coeur sont chez le nouveau provider, de ${de} a ${a}. `
      + 'Les autres dates y sont fermees faute de prix — c\'est voulu.'
      + (horsFenetre ? ` (${horsFenetre} nuit(s) tarifee(s) au-dela de la fenetre de controle, non verifiees.)` : '') }
}

module.exports = { pousserAri, etatAri, raisonDeNePasPousser, nuitsTarifeesDuCoeur, lignesDuCoeur,
  HORIZON_CONTROLE_JOURS, FENETRE_LECTURE_JOURS }
