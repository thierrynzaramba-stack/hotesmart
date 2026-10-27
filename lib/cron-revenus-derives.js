// lib/cron-revenus-derives.js — LE RATTRAPAGE DES COLONNES DERIVEES
//
// Architecture decidee par Thierry le 27 octobre 2026 : le payload provider
// n'est lu qu'UNE FOIS, a l'ecriture de la reservation, et l'ecran lit un
// agregat SQL. Le writer (`lib/bookings-snapshot.js`) pose les colonnes derivees sur
// toute reservation qu'il ECRIT. Ce module reprend les autres.
//
// ⚠ TROIS RAISONS D'AVOIR UN RATTRAPAGE, et aucune n'est « au cas ou » :
//   1. le writer ne derive QUE s'il a le payload sous la main. Un appelant qui
//      mappe lui-meme sans transmettre la source laisse les colonnes intactes —
//      c'est voulu (un enrichissement ne doit jamais appauvrir), et c'est ici
//      que ces lignes sont reprises ;
//   2. le trigger SQL `delais_versement_invalide_trg` met `derive_le` a NULL
//      quand un delai change. Il INVALIDE sans effacer : l'ecran continue
//      d'afficher un chiffre d'un jour, et c'est ce module qui le rafraichit ;
//   3. la VERSION de la regle de calcul. Quand le calcul change, toute ligne
//      d'une version anterieure doit etre reprise — sinon un correctif ne vaut
//      que pour les reservations ecrites apres lui.
//
// ⚠ CADENCE QUOTIDIENNE A 04:00 HEURE DE PARIS, et le fuseau est le point. Le
// cron Vercel tourne toutes les 5 minutes en UTC : « 04:00 » n'existe pas pour
// lui. On compare donc l'heure de PARIS, celle de l'hote — en hiver 04:00 Paris
// est 03:00 UTC, en ete 02:00 UTC, et une garde ecrite en UTC se decalerait
// d'une heure deux fois par an. Le depot a deja paye ce decalage.

const { deriverRevenus, aDeriver, COLONNES, VERSION } = require('./revenus/derive')
const { tableDesDelais } = require('./revenus/versement')

const MARQUEUR = 'revenus_derives'
// 20 heures, pas 24 : a 24 h pile, un cycle qui tourne une minute plus tard
// chaque jour finit par sauter une journee entiere. La fenetre horaire ci-dessous
// fait le reste du travail.
const PERIODE_MS = 20 * 60 * 60 * 1000
// L'heure de Paris a laquelle on accepte de travailler. Une plage d'une heure :
// le cron passe toutes les 5 minutes, donc douze occasions de prendre la main.
const HEURE_PARIS = 4
// Budget mur : on rend la main au cycle plutot que de le faire tuer. Le cycle
// entier est plafonne a 60 s (vercel.json).
const BUDGET_MS = 15000
const PAGE = 200
// ⚠ UN PLAFOND PAR PASSAGE, ET IL EST ASSUME. A 1 436 reservations, le
// remplissage initial se fait par le script dedie — pas par le cron. Ce module
// rattrape le FLUX : quelques lignes par nuit, et les milliers d'un changement
// de delai en plusieurs nuits. Un cron qui tenterait tout d'un coup se ferait
// tuer et ne marquerait jamais sa cadence.
const LIGNES_MAX = 2000

// L'heure de Paris, sans dependance : `Intl` sait les fuseaux, et il connait
// l'heure d'ete mieux qu'un calcul a la main.
function heureDeParis (instant) {
  try {
    // ⚠ `formatToParts`, PAS `format()`, ET C'EST UN DEFAUT QUE J'AI ECRIT PUIS
    // MESURE. Le format FRANCAIS rend « 04 h » — avec l'unite — et
    // `Number('04 h')` vaut NaN. Ma premiere version comparait donc NaN a 4 :
    // la fenetre ne s'ouvrait JAMAIS, le rattrapage ne tournait jamais, et
    // l'appel rendait sagement `hors_fenetre` a chaque passage. Un cron mort
    // qui dit « ce n'est pas l'heure » est indiscernable d'un cron qui attend.
    //
    // `formatToParts` rend la VALEUR sans la decoration de locale. Choisir
    // `en-GB` marcherait aussi, mais ferait dependre une garde d'ecriture du
    // comportement d'affichage d'une langue qui n'est pas celle du produit.
    // ⚠ L'INSTANT SE VALIDE, parce qu'une entree invalide rend une heure
    // PLAUSIBLE : `new Date(null)` vaut l'epoch, soit 01:00 a Paris. Mesure :
    // `heureDeParis(null)` rendait 1. Un appelant qui passerait une valeur vide
    // n'aurait donc pas une erreur mais une heure fausse — et un module qui
    // ECRIT ne doit pas se tromper d'heure en silence.
    if (typeof instant !== 'number' || !Number.isFinite(instant)) return null
    const parts = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(instant))
    const h = parts.find(x => x.type === 'hour')
    const n = h ? Number(h.value) : NaN
    return Number.isInteger(n) ? n : null
  } catch (e) {
    // ⚠ SI `Intl` MANQUE, ON NE TRAVAILLE PAS. Deviner l'heure de Paris a
    // partir d'UTC se trompe d'une heure la moitie de l'annee, et ce module
    // ECRIT : mieux vaut ne rien faire qu'ecrire a la mauvaise heure.
    return null
  }
}

/**
 * Le rattrapage. Rend un bilan, ne leve jamais.
 *
 * @param results  l'objet de bilan du cycle de cron (ses `errors` sont LUES :
 *                 un cron qui rend 200 avec une erreur dans `results.errors`
 *                 est une panne invisible, et le depot l'a paye 24 h)
 * @param deps     { supabase, now, forcer } — injectables pour les tests
 */
async function rattraperRevenusDerives (results, deps = {}) {
  const sb = deps.supabase
  if (!sb) return { skipped: 'pas_de_client' }
  const maintenant = deps.now || (() => Date.now())
  const t0 = maintenant()

  // ─── 1. La fenetre horaire ──────────────────────────────────────────────
  if (!deps.forcer) {
    const h = heureDeParis(t0)
    if (h == null) return { skipped: 'fuseau_illisible' }
    if (h !== HEURE_PARIS) return { skipped: 'hors_fenetre', heure_paris: h }
  }

  // ─── 2. La cadence ──────────────────────────────────────────────────────
  if (!deps.forcer) {
    const { data: marker } = await sb
      .from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
    if (marker?.last_run && (t0 - new Date(marker.last_run).getTime()) < PERIODE_MS) {
      return { skipped: 'cadence' }
    }
  }

  // ⚠ MARQUEUR POSE AVANT LE TRAVAIL, PAS APRES — meme raison que le poll des
  // avis : si ce rattrapage faisait deborder l'invocation, elle serait tuee
  // avant d'ecrire son marqueur de fin, et le travail repartirait a CHAQUE tick
  // de 5 min en mangeant le budget des autres etapes. Poser le marqueur d'abord
  // fait perdre au pire une nuit — et le passage suivant reprend exactement les
  // memes lignes, puisque `aDeriver` est idempotent.
  const { error: errMarqueur } = await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(t0).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (errMarqueur) {
    console.error('[revenus-derives] marqueur de cadence NON ecrit:', errMarqueur.message)
    results?.errors?.push({ context: 'revenus_derives', error: 'marqueur: ' + errMarqueur.message })
    return { skipped: 'marqueur_illisible' }
  }

  // ─── 3. Les delais, lus UNE FOIS ────────────────────────────────────────
  const { data: lignesDelais, error: eD } = await sb
    .from('delais_versement').select('canal, base, jours, libelle')
  if (eD) {
    // ⚠ SANS LES DELAIS, ON NE DERIVE RIEN — et on le DIT. Deriver avec une
    // table vide poserait colonnes derivees a `null` sur des lignes qui en portaient
    // de justes : un rattrapage qui appauvrit. La distinction entre « je n'ai
    // pas pu lire » et « il n'y a rien » est celle que tout cet ecran tient.
    console.error('[revenus-derives] delais_versement illisible:', eD.message)
    results?.errors?.push({ context: 'revenus_derives', error: 'delais: ' + eD.message })
    return { skipped: 'delais_illisibles' }
  }
  const delais = tableDesDelais(lignesDelais || [])
  if (!Object.keys(delais).length) {
    results?.errors?.push({ context: 'revenus_derives', error: 'aucun canal n a de delai lisible' })
    return { skipped: 'aucun_delai' }
  }

  // ─── 4. La correspondance cle provider -> UUID, lue UNE FOIS ────────────
  //
  // ⚠ LA CLE EST LE COUPLE (user_id, provider_property_id). Deux comptes
  // peuvent porter le meme numero provider : les melanger donnerait les revenus
  // d'un hote a l'autre. C'est la regle dure du depot, du cote qui compte.
  const uuidParCle = new Map()
  {
    // ⚠ PAGINE, ET CE N'EST PAS DU ZELE. Une lecture Supabase sans borne est
    // TRONQUEE A 1 000 LIGNES SANS ERREUR : au-dela, `uuidParCle` serait
    // incomplet et le rattrapage ecrirait `property_uuid: null` sur des biens
    // qui existent — donc sortirait leur argent du total, en silence. Le
    // script de remplissage paginait deja ; c'etait le cron l'exception.
    for (let i = 0; i < 40; i++) {
      const { data, error } = await sb.from('properties')
        .select('id, user_id, provider_property_id')
        .order('id').range(i * 500, (i + 1) * 500 - 1)
      if (error) {
        console.error('[revenus-derives] properties illisible:', error.message)
        results?.errors?.push({ context: 'revenus_derives', error: 'properties: ' + error.message })
        return { skipped: 'properties_illisibles' }
      }
      const page = data || []
      for (const b of page) {
        if (!b || b.provider_property_id == null) continue
        uuidParCle.set(`${b.user_id}|${String(b.provider_property_id)}`, b.id)
      }
      if (page.length < 500) break
    }
  }

  // ─── 5. Le rattrapage, par pages bornees ────────────────────────────────
  const bilan = {
    lues: 0, derivees: 0, ecrites: 0, echecs: 0,
    sans_uuid: 0, sans_montant: 0, sans_date: 0, budget_atteint: false
  }
  const instant = new Date(t0).toISOString()

  // ⚠ ON NE LIT QUE CE QUI EST A DERIVER, par l'index partiel
  // `bookings_snapshot_a_deriver_idx` (`where derive_le is null`). Balayer la
  // table entiere chaque nuit pour trouver trois lignes couterait 3,8 Mo pour
  // rien — c'est le poids meme qu'on fuit.
  //
  // ⚠ ET LA VERSION PERIMEE SE LIT A PART : elle a `derive_le` NON nul, donc
  // elle sort de cet index. Deux requetes, deux motifs, et chacune bornee.
  // ⚠ ET UN TROISIEME MOTIF DEPUIS LE 27 OCTOBRE 2026 : LE PAYLOAD A CHANGE
  // DEPUIS LE CALCUL (dette 112). Une ligne dont le `raw` a ete corrige garde
  // `derive_le` non nul et sa version a jour : elle echappait donc aux DEUX
  // requetes precedentes, et rien ne la reprenait jamais.
  //
  // ⚠ LE FILTRE NE PEUT PAS SE FAIRE EN SQL ICI. PostgREST ne compare pas deux
  // COLONNES entre elles — `derive_raw_hash=neq.raw_hash` compare a la chaine
  // litterale « raw_hash ». On lit donc les candidats par l'index partiel
  // (`derive_le is not null`), et c'est `aDeriver` qui tranche en JavaScript,
  // sur les deux empreintes. C'est la meme fonction que le writer : une seule
  // regle de peremption pour les deux chemins.
  // ⚠ QUATRE MOTIFS, ET LE TROISIEME EST SEPARE DU QUATRIEME A DESSEIN.
  // `payload_nul` (l'empreinte manque) s'exprime EN SQL, donc son ensemble de
  // candidats REDUIT a chaque ligne derivee : c'est le gros du travail apres la
  // migration, et il converge en un passage. `payload_different` (l'empreinte
  // existe et differe) ne s'exprime pas en SQL — PostgREST ne compare pas deux
  // colonnes — donc il balaye, et son plafond est annonce plus bas.
  for (const motif of ['jamais', 'version', 'payload_nul', 'payload_different']) {
    // ⚠ UN CURSEUR, ET IL EST INDISPENSABLE POUR LE TROISIEME MOTIF. Les deux
    // premiers progressent d'eux-memes : une ligne derivee cesse d'avoir
    // `derive_le` nul, une ligne remise a jour cesse d'etre en version
    // inferieure — donc la page suivante est forcement differente.
    //
    // Le motif « payload », lui, lit les lignes DERIVEES ET A JOUR : apres
    // derivation, elles le sont toujours. Sans curseur, la meme page serait
    // relue a chaque tour, `aDeriver` la rejetterait, et la boucle tournerait
    // sans jamais atteindre la deuxieme page — le rattrapage ne reprendrait
    // donc que les premieres lignes de la table, a vie.
    let curseur = null
    for (let p = 0; p < Math.ceil(LIGNES_MAX / PAGE); p++) {
      if (maintenant() - t0 > BUDGET_MS) { bilan.budget_atteint = true; break }
      // ⚠ LA BORNE EST DECLAREE AVEC LA REQUETE, PAS ACCROCHEE A LA FIN. Elle
      // etait sur le `await` final, douze lignes plus bas : en inserant un
      // `if/else` a accolades entre les deux, j'ai fait sortir le `.limit()` de
      // la fenetre que le recensement de `tests/bookings-snapshot-troncature`
      // examine, et ce test a compte une lecture non bornee de plus. Il avait
      // raison de parler : une borne qu'un remaniement peut separer de son
      // `from()` est une borne fragile. Ici, elle ne peut plus s'en detacher.
      let q = sb.from('bookings_snapshot').limit(PAGE)
        .select('id, user_id, booking_id, property_id, snapshot, raw, derive_le, derive_version, raw_hash, derive_raw_hash')
      if (motif === 'jamais') q = q.is('derive_le', null)
      else if (motif === 'version') q = q.not('derive_le', 'is', null).lt('derive_version', VERSION)
      // ⚠ `eq` ET NON `gte` SUR LA VERSION. `gte` embarquait les versions
      // SUPERIEURES : apres un retour arriere du code (lignes ecrites en v3,
      // code revenu en v2), ces lignes seraient re-derivees par l'ANCIENNE
      // regle et leur `derive_version` redescendrait. Le `lt` du motif
      // precedent les excluait deja ; `eq` les exclut ici aussi.
      else if (motif === 'payload_nul') {
        q = q.not('derive_le', 'is', null).eq('derive_version', VERSION)
          .is('derive_raw_hash', null)
      } else {
        q = q.not('derive_le', 'is', null).eq('derive_version', VERSION)
          .not('derive_raw_hash', 'is', null)
      }
      if (curseur) q = q.gt('id', curseur)
      const { data, error } = await q.order('id')
      if (error) {
        // Une colonne absente ici veut dire que la migration n'est pas
        // appliquee sur cette base : ce n'est pas une panne, c'est une attente.
        const texte = `${error.code || ''} ${error.message || ''}`.toLowerCase()
        const colonne = COLONNES.some(c => texte.includes(c))
        if (colonne) {
          // ⚠ ET ON LE DIT DANS `results.errors`, parce qu'un cron qui rend 200
          // en silence est la panne qu'on ne voit pas (24 h de panne totale
          // invisible, vecu du depot). ⚠ Cette attente arrete les QUATRE
          // motifs, pas seulement les deux derniers : le `select` nomme
          // `derive_raw_hash` pour tous, et de toute facon `deriverRevenus`
          // rend cette colonne, donc l'UPDATE echouerait. S'arreter vaut mieux
          // qu'ecrire a moitie — mais l'ordre de deploiement est donc : coller
          // la migration 7, PUIS merger.
          // ⚠ ET PAS DANS `results.errors` : un test l'interdit, et il a raison.
          // `results.errors` alerte le fondateur, et ce cron passe toutes les
          // 5 minutes — la fenetre entre le merge et le collage produirait des
          // centaines d'alertes pour une attente normale. Une alarme qui crie
          // pour du normal se fait couper, et ce jour-la elle ne dira plus rien
          // des vraies pannes. La trace va donc dans les logs, et `skipped`
          // remonte dans le bilan du cron.
          console.error('[revenus-derives] colonne derivee absente : migration a appliquer sur cette base')
          return { skipped: 'migration_absente' }
        }
        console.error('[revenus-derives] lecture echec:', error.message)
        results?.errors?.push({ context: 'revenus_derives', error: 'lecture: ' + error.message })
        return { ...bilan, erreur: error.message }
      }
      const page = data || []
      bilan.lues += page.length
      if (!page.length) break
      // Le curseur avance sur la DERNIERE ligne lue, derivee ou non : c'est la
      // lecture qui progresse, pas l'ecriture.
      curseur = page[page.length - 1].id

      for (const l of page) {
        if (!aDeriver(l)) continue
        bilan.derivees++
        // ⚠ ON NE DERIVE PAS SANS PAYLOAD. Une ligne dont `raw` est nul ne
        // peut pas rendre un montant : la deriver poserait dix `null` avec un
        // motif, donc effacerait ce qu'un passage precedent avait pu ecrire.
        // On la laisse — et comme `derive_le` reste nul, elle revient chaque
        // nuit. C'est voulu : le jour ou son payload arrive, elle est reprise.
        if (l.raw == null) continue
        const uuid = uuidParCle.get(`${l.user_id}|${String(l.property_id)}`) || null
        // ⚠ `empreinteDuRaw` EST OBLIGATOIRE, ET SON ABSENCE ANNULAIT LA MOITIE
        // DE LA DETTE 112 — trouve par la review, verifie par execution. Sans
        // elle, `deriverRevenus` rend `derive_raw_hash: null` (c'est son
        // `?? null`), donc le rattrapage ECRIVAIT null dans la colonne qui
        // existe pour detecter la peremption. Consequences mesurees :
        // · la ligne restait candidate au motif « payload » APRES avoir ete
        //   derivee, donc elle etait reprise a chaque passage, a vie, et
        //   `budget_atteint` devenait vrai chaque nuit — un drapeau d'anomalie
        //   transforme en bruit de fond ;
        // · le rattrapage ECRASAIT l'empreinte posee par le writer. Un seul
        //   changement de delai (le trigger remet `derive_le` a null sur toute
        //   la table) y faisait entrer l'integralite des lignes.
        //
        // ⚠ ET C'EST LE `raw_hash` STOCKE QU'ON REPOSE, jamais une empreinte
        // recalculee depuis `l.raw` : `raw` est du `jsonb`, donc Postgres l'a
        // normalise (ordre des cles, echelle des nombres) et une empreinte
        // relue ne vaudrait pas celle calculee avant insertion. Comparer deux
        // valeurs qui ne convergent pas, c'est la meme boucle sans fin, mais
        // invisible.
        const d = deriverRevenus(l.snapshot, l.raw, {
          delais, uuidDuBien: uuid, provider: null, maintenant: instant,
          empreinteDuRaw: l.raw_hash
        })
        if (!d.property_uuid) bilan.sans_uuid++
        if (d.montant_net_cents == null) bilan.sans_montant++
        if (d.date_versement == null) bilan.sans_date++
        // ⚠ `update` PAR `id`, JAMAIS `upsert` SUR (user_id, booking_id). Un
        // upsert reecrirait la ligne entiere et pourrait toucher `snapshot` —
        // donc rouvrir la detection de changement, donc renvoyer message de
        // bienvenue, menage et code d'acces a un voyageur. C'est le vecu du
        // depot sur les cles migrees.
        const { error: eU } = await sb.from('bookings_snapshot').update(d).eq('id', l.id)
        if (eU) {
          bilan.echecs++
          if (bilan.echecs <= 3) {
            console.error(`[revenus-derives] echec ${l.booking_id}: ${eU.message}`)
          }
        } else bilan.ecrites++
      }
      if (page.length < PAGE) break
      // ⚠ LA DERNIERE PAGE DU PLAFOND EST PLEINE : IL RESTE DES LIGNES QUE CE
      // PASSAGE N'A PAS VUES, et pour `payload_different` elles ne sont pas
      // « reportees a demain » — le curseur repart de zero chaque nuit et
      // l'ordre des `id` est stable, donc la QUEUE DE LA TABLE ne serait jamais
      // examinee. Le plafond vaut LIGNES_MAX (2 000) ; la production porte
      // 1 436 lignes au 27 octobre 2026, donc le cas n'est pas atteint — mais
      // `bookings_snapshot` ne decroit pas (214 → 1 436 au backfill), et le
      // jour ou elle depasse le plafond, personne ne le verrait. Un rattrapage
      // qui ne couvre plus toute la table doit le DIRE.
      if (p === Math.ceil(LIGNES_MAX / PAGE) - 1) {
        bilan.tronque = motif
        results?.errors?.push({
          context: 'revenus_derives',
          error: `motif ${motif} : plafond de ${LIGNES_MAX} lignes atteint, `
            + 'la fin de la table n a pas ete examinee'
        })
      }
    }
    if (bilan.budget_atteint) break
  }

  // ⚠ LES ECHECS REMONTENT DANS `results.errors`. Un cron qui rend 200 en
  // ayant echoue est une panne invisible : le depot l'a paye 24 heures.
  if (bilan.echecs) {
    results?.errors?.push({
      context: 'revenus_derives',
      error: `${bilan.echecs} ecriture(s) en echec sur ${bilan.derivees} derivee(s)`
    })
  }
  return bilan
}

module.exports = {
  rattraperRevenusDerives, heureDeParis,
  MARQUEUR, HEURE_PARIS, PERIODE_MS, LIGNES_MAX, BUDGET_MS
}
