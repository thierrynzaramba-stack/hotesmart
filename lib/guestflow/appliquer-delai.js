// lib/guestflow/appliquer-delai.js
// LE NOUVEAU REGLAGE GOUVERNE AUSSI LES BROUILLONS DEJA EN ATTENTE.
// Chantier « delai de reponse IA ». Spec : docs/specs/spec-delai-reponse-ia.md
//
// ⚠ POURQUOI CE MODULE EXISTE (recette de Thierry, 28 octobre 2026). Le reglage
// ne gouvernait que les brouillons A VENIR : `lib/cron-classify.js` lit le delai
// au moment de CREER la tache, et plus rien ne la relit ensuite. Donc un
// brouillon arme a +60 min restait arme apres que l'hote ait repasse le bien en
// validation manuelle — l'ecran annoncait « Part dans 59 min » pendant une
// heure, et a l'echeance le cron le refusait avec
// `repasse_en_validation_manuelle`. C'est exactement la phrase que Thierry a
// fait corriger pour la pause, par une autre porte.
//
// Sa decision, mot pour mot : « a l'enregistrement, les brouillons en attente du
// bien suivent le nouveau reglage. Validation manuelle -> desarmes, plus de
// compte a rebours. Autre delai -> echeance recalculee depuis la creation du
// brouillon (si elle est deja passee, il part au prochain passage, c'est ce que
// l'hote a demande). Mon dernier reglage gouverne toujours. »
//
// ⚠ UN SEUL ECRIVAIN, ET C'EST CE FICHIER. `agent_tasks.send_after` est deja
// ecrit par trois endroits (creation dans `cron-classify`, passe et reprise dans
// `brouillons-dus`, actions de l'hote dans `api/messages`). Un quatrieme ecrit
// EN LIGNE dans `api/agent-config.js` aurait fait du endpoint de reglages un
// ecrivain de taches : la regle du depot veut un writer par donnee, pas un par
// occasion.
//
// ⚠ L'HORLOGE EST TOUJOURS INJECTEE (`maintenant`). C'est la regle du depot sur
// les tests, et ce module est du cote « on injecte ».

const { delaiDeReponse, echeanceDeReponse } = require('./delais-contrat')

// Les brouillons se lisent PAR PAGES, par curseur sur `id`. PostgREST rend
// 1000 lignes SANS erreur : une lecture non bornee est la famille de defauts la
// plus silencieuse du depot. Un bien n'a pas 500 propositions en attente — mais
// « n'a pas » n'est pas une borne, et le jour ou il en a, on le DIT.
const PAGE = 500
const MAX_PAGES = 40

const EN_ATTENTE = 'pending_validation'

/**
 * Les brouillons en attente d'un bien suivent le reglage qui vient d'etre
 * enregistre.
 *
 * @param {object} sb            client Supabase (service role)
 * @param {string} userId        le compte proprietaire des taches
 * @param {string} propertyRef   la REFERENCE PROVIDER du bien
 *   (`agent_tasks.property_id` est du TEXT : la ref provider, pas l'UUID de
 *    `properties`. Ne jamais joindre naivement l'un sur l'autre.)
 * @param {object} delais        le bloc `delais` VALIDE qui vient d'etre ecrit
 * @param {number} maintenant    l'instant de reference, en ms
 *
 * @param {boolean} [apercu]  ne RIEN ecrire, seulement compter (voir plus bas)
 *
 * @returns {Promise<{ok: boolean, motif: string, desarmes: number,
 *   rearmes: number, inchanges: number, deja_prises: number, echues: number,
 *   sans_creation: number, erreur?: string}>}
 *
 * ⚠ CHAQUE COMPTEUR A UNE SEULE SIGNIFICATION, et `deja_prises` est ne d'un
 * constat de revue : je rangeais sous `inchanges` deux faits opposes — « il n'y
 * avait rien a faire » et « le cron m'a pris la tache sous le nez ». Le second
 * veut dire qu'un message PART peut-etre, avec le reglage d'AVANT : le cron lit
 * la config une fois par lot, hors de sa boucle, donc `encoreLegitime` peut
 * relire un blob perime pendant une vingtaine de secondes. L'hote qui vient de
 * demander « plus rien sans ma validation » doit l'apprendre, pas lire
 * « Enregistre ».
 *
 * ⚠ `echues` EST UNE BORNE HAUTE DE CE QUI POURRAIT PARTIR, PAS UNE PREVISION
 * — constat 1 de la revue du 28 octobre 2026, et ma premiere version l'annoncait
 * comme un fait. Deux filtres de plus vivent EN AVAL, dans
 * `lib/guestflow/brouillons-dus.js` :
 *   · `encoreLegitime` rejoue ONZE motifs de refus a l'echeance, dont trois
 *     durables que ce module ne peut pas connaitre sans lire d'autres tables :
 *     `automatisation_en_pause`, `reservation_annulee`, `sejour_termine`.
 * ⚠ ET LA SUSPENSION N'EST PAS UN FILTRE, C'EST UN DELAI — recette du
 * 29 octobre 2026. J'avais ecrit ici qu'une tache suspendue est « EXCLUE du
 * compte », en m'appuyant sur le `.is('suspendu_le', null)` de `lireLesDues`.
 * Ce lecteur-la l'ecarte, oui ; mais `reprendreSuspensionsDormantes`, dans le
 * MEME fichier et a CHAQUE passage, efface `suspendu_le` apres 30 minutes sans
 * geste de l'hote et repose l'echeance au plancher de 5 minutes. La tache
 * revient donc d'elle-meme, et elle part. Raisonner sur un seul lecteur d'une
 * passe qui en enchaine plusieurs, c'est lire la moitie du chemin.
 *
 * Un bien en pause accumule des brouillons echus que le cron refuse a chaque
 * passage : ils comptent ici, et aucun ne partira. D'ou le libelle affiche a
 * l'hote — « partiront seules », avec la suspension dite explicitement — et le fait que l'ecran
 * ne pose pas la question sur un bien qu'il SAIT en pause.
 * La direction est conservatrice : on sur-compte, jamais l'inverse.
 *
 * ⚠ ET C'EST CE QUI REND `apercu` NECESSAIRE. Sous « Je valide chaque reponse » les brouillons
 * s'accumulent SANS echeance — ils attendent parce que l'hote ne les a pas
 * valides, et il peut y en avoir un par (reservation x type), vieux de
 * plusieurs jours. En sortir les rearme a `created_at + N`, donc tout ce qui a
 * plus de N d'age est ECHU et part dans les cinq minutes, quel que soit N. Le
 * depot exige le NOMBRE avant un geste de masse vers l'exterieur (4.6.6 :
 * « exige leur nombre et leurs bornes » ; grille : « N nuits vont changer de
 * prix »). Ici la cible est le telephone d'un voyageur.
 *
 * ⚠ RENDRE `ok: false` N'ANNULE PAS LE REGLAGE : il est deja enregistre quand
 * on arrive ici, et c'est le bon ordre — c'est lui qui gouverne les brouillons
 * a venir. Ce que l'appelant doit faire d'un `false`, c'est le DIRE a l'hote :
 * son reglage est pris, ses propositions deja en attente ne l'ont pas suivi.
 */
async function appliquerDelaiAuxBrouillons (sb, { userId, propertyRef, delais, maintenant, apercu }) {
  const bilan = {
    desarmes: 0, rearmes: 0, inchanges: 0, deja_prises: 0, echues: 0, sans_creation: 0
  }
  const ref = String(propertyRef == null ? '' : propertyRef).trim()
  if (!sb || !userId || !ref || !Number.isFinite(maintenant)) {
    return { ok: false, motif: 'appel_incomplet', ...bilan }
  }

  // Le contrat, pas le champ brut : `delaiDeReponse` est le SEUL endroit qui
  // sait distinguer les trois cas.
  // ⚠ ET SON REPLI ICI EST LE DESARMEMENT, PAS « LE BINAIRE HISTORIQUE »
  // (constat 9 de la revue : mon commentaire promettait plus que le code). On
  // l'appelle sans `mode`, donc son repli evalue `reglages.mode !== 'auto'` sur
  // `undefined` et rend TOUJOURS `manuel: true`. C'est la bonne degradation —
  // un blob illisible ne fait rien partir — mais elle ne consulte aucun mode.
  // En pratique le bloc arrive deja valide par `delaisPropres`, donc ce repli
  // n'est atteint que si ce module est appele d'ailleurs.
  const delai = delaiDeReponse({ delais })
  const horodatage = new Date(maintenant).toISOString()

  let curseur = null
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = sb.from('agent_tasks')
      .select('id, created_at, send_after, suspendu_le')
      .eq('user_id', userId)
      .eq('property_id', ref)
      .eq('status', EN_ATTENTE)
      .order('id', { ascending: true })
      .limit(PAGE)
    if (curseur) q = q.gt('id', curseur)

    const { data, error } = await q
    // ⚠ UNE PANNE DE LECTURE NE VAUT PAS « AUCUN BROUILLON ». Rendre `ok: true`
    // ici ferait dire a l'ecran « Enregistre » alors qu'un brouillon part
    // encore a l'ancienne echeance.
    if (error) return { ok: false, motif: 'lecture_impossible', erreur: error.message, ...bilan }
    // ⚠ ET `data || []` N'EST PAS UNE LECTURE, C'EST UNE SUPPOSITION (constat 8
    // de la revue du 28 octobre 2026, MESURE). PostgREST rend TOUJOURS un
    // tableau sur un select : `undefined` sans erreur est une reponse que le
    // vrai client ne peut pas produire. La lire comme « aucune ligne » rendait
    // `ok: true` a un double de test non thenable — donc muter la reference du
    // bien ou le compte restait VERT sur toute la suite, sur le chemin de
    // l'envoi au voyageur. Une forme impossible se refuse, elle ne se devine pas.
    if (!Array.isArray(data)) {
      return { ok: false, motif: 'lecture_illisible',
        erreur: 'select agent_tasks : ' + (data === undefined ? 'data absente' : typeof data), ...bilan }
    }

    const lot = data
    for (const t of lot) {
      const champs = {}

      if (delai.manuel) {
        // Rien a faire sur une tache deja desarmee ET non suspendue : on ne
        // reecrit pas `updated_at` pour rien (la passe lit ce champ).
        if (t.send_after === null && t.suspendu_le === null) { bilan.inchanges++; continue }
        champs.send_after = null
        champs.updated_at = horodatage
        // ⚠ LA SUSPENSION S'EFFACE AVEC L'ECHEANCE, et c'est le constat 5 de la
        // seconde revue du lot 2, rejoue ici : desarmer en laissant
        // `suspendu_le` produit un etat SANS ISSUE — « En attente : vous
        // modifiez » pour toujours, sans lien de reprise (le pied exige une
        // echeance) et sans reprise automatique possible
        // (`reprendreSuspensionsDormantes` exige `send_after` non nul).
        champs.suspendu_le = null
      } else {
        // « Echeance recalculee depuis la CREATION du brouillon. » Le delai
        // choisi se compte donc depuis le message du voyageur, pas depuis le
        // clic sur Enregistrer : un brouillon ne a 14 h avec 60 min de delai
        // part a 15 h, que l'hote ait regle a 14 h 01 ou a 14 h 50.
        const ne = Date.parse(t.created_at)
        if (!Number.isFinite(ne)) bilan.sans_creation++
        // Sans date de creation lisible (`created_at` est nullable en base), on
        // compte depuis MAINTENANT : c'est le repli le plus TARDIF, donc celui
        // qui ne fait jamais partir un message plus tot que l'hote ne l'a dit.
        const nouvelle = echeanceDeReponse(delai.minutes, Number.isFinite(ne) ? ne : maintenant)
        // Ce brouillon partira-t-il SEUL, sans attendre le delai choisi ?
        // C'est le nombre que l'hote doit lire AVANT de confirmer.
        //
        // ⚠ UNE TACHE SUSPENDUE COMPTE, ET MON EXCLUSION ETAIT FAUSSE —
        // decision de Thierry en recette du 29 octobre 2026 : « une proposition
        // qui finira par partir seule compte, suspendue ou non ».
        //
        // J'avais exclu les suspendues au constat 1 d'une revue, en
        // raisonnant sur `lireLesDues`, qui les ecarte
        // (`.is('suspendu_le', null)`). Le raisonnement etait juste sur CE
        // lecteur-la et faux sur la passe entiere : `reprendreSuspensionsDormantes`
        // (lib/guestflow/brouillons-dus.js) tourne a CHAQUE passage, efface
        // `suspendu_le` des que l'hote n'a plus touche le brouillon depuis
        // 30 minutes, et repose `send_after = maintenant + max(5 min,
        // send_after - suspendu_le)`. **Une suspension ne protege pas un
        // brouillon, elle DIFFERE son depart**, et personne n'a a intervenir.
        //
        // Ce que ca a coute, mesure en recette sur staging : une proposition
        // vieille de 22 h, suspendue, invisible du compteur — donc « Enregistré »
        // sans un mot — et le bouton de reprise affichait « Envoyer dans
        // 5 min », qui est exactement le plancher `REPRISE_MIN_MS`. Elle serait
        // partie seule au voyageur.
        if (Date.parse(nouvelle) <= maintenant) bilan.echues++
        if (t.send_after === nouvelle) { bilan.inchanges++; continue }
        champs.send_after = nouvelle
        // ⚠ `updated_at` N'EST PAS TOUCHE SUR UNE TACHE SUSPENDUE, et c'est un
        // constat de la revue. `reprendreSuspensionsDormantes` lit ce champ comme
        // une mesure d'INACTIVITE DE L'HOTE SUR CE BROUILLON (son parachute de
        // 30 minutes, decision 4 de Thierry). Or enregistrer le panneau est un
        // geste sur le BIEN, pas sur le brouillon : le reecrire repoussait le
        // parachute de 30 minutes a chaque sauvegarde, et rendait
        // `send_after - suspendu_le` — « ce qui restait quand l'hote a ouvert »
        // — arbitraire. La direction etait tardive, donc sans danger pour le
        // voyageur ; elle affaiblissait quand meme une garde de l'hote.
        if (t.suspendu_le === null || t.suspendu_le === undefined) champs.updated_at = horodatage
        // ⚠ ON NE TOUCHE PAS A `suspendu_le` ICI, ET C'EST VOLONTAIRE. La
        // suspension protege le brouillon que l'hote a OUVERT dans la saisie :
        // l'effacer armerait un compte a rebours sur un texte en train d'etre
        // ecrit, et le message pourrait partir sous ses doigts. Elle ne
        // contredit pas son reglage, elle le DIFFERE — `send_after` suit bien
        // le nouveau reglage, et la reprise repart de la (plancher de 5 min).
      }

      // ⚠ EN APERCU, ON NE TOUCHE A RIEN : on a deja compte ce qu'il faut dire a
      // l'hote, et c'est tout l'objet de ce mode.
      if (apercu === true) {
        if (delai.manuel) bilan.desarmes++
        else bilan.rearmes++
        continue
      }

      // Claim conditionne sur le statut : si le cron a pris la tache entre la
      // lecture et ici (`sending`), ou si l'hote vient de l'envoyer, on ne la
      // ressuscite pas.
      const { data: faite, error: eU } = await sb.from('agent_tasks')
        .update(champs)
        .eq('id', t.id)
        .eq('status', EN_ATTENTE)
        .select('id')
      if (eU) return { ok: false, motif: 'ecriture_impossible', erreur: eU.message, ...bilan }
      // ⚠ ZERO LIGNE N'EST PAS « RIEN A FAIRE » : la tache etait a valider quand
      // on l'a lue, elle ne l'est plus. Quelqu'un l'a prise — le cron en
      // `sending`, ou l'hote dans un autre onglet. Compteur SEPARE : c'est le
      // seul cas ou un message peut partir avec le reglage d'avant.
      if (!faite || !faite.length) { bilan.deja_prises++; continue }

      if (delai.manuel) bilan.desarmes++
      else bilan.rearmes++
    }

    if (lot.length < PAGE) return { ok: true, motif: delai.motif, ...bilan }
    curseur = lot[lot.length - 1].id
  }

  // ⚠ UN UPDATE PAR TACHE, EN SERIE, ET C'EST UN CHOIX ASSUME (constat 7 de la
  // revue). La branche `manuel` tiendrait en UN seul statement sans lecture
  // prealable — mais c'est precisement la lecture-puis-update-conditionnel qui
  // permet de voir qu'une tache nous a echappe (`deja_prises`), et ce fait-la
  // est sur le chemin de l'envoi au voyageur : le taire coute plus cher que les
  // aller-retours. Le vrai cout est borne par `MAX_PAGES` et par le nombre de
  // brouillons en attente d'UN bien. La dette est ecrite dans la spec.
  //
  // ⚠ LA TRONCATURE SE DIT. Quarante pages pleines veut dire qu'il reste des
  // brouillons non traites : rendre `ok: true` ici serait exactement le faux
  // vert que la pagination existe pour empecher.
  return { ok: false, motif: 'trop_de_brouillons', ...bilan }
}

/**
 * Le bilan a zero, pour les appelants qui doivent en fabriquer un (chemin
 * d'exception d'un endpoint, par exemple).
 *
 * ⚠ IL EXISTE PARCE QUE DEUX COPIES ONT DEJA DIVERGE : le chemin d'exception de
 * `/api/agent-config` listait quatre compteurs a la main, et les deux ajoutes
 * ensuite (`deja_prises`, `echues`) y manquaient — le JSDoc ci-dessus les
 * promettait tous les six. Inoffensif par chance (`NaN > 0` est faux), mais
 * c'est un contrat que le prochain lecteur aurait cru.
 */
function bilanVide (champs = {}) {
  return {
    ok: false, motif: 'inconnu',
    desarmes: 0, rearmes: 0, inchanges: 0, deja_prises: 0, echues: 0, sans_creation: 0,
    ...champs
  }
}

module.exports = { appliquerDelaiAuxBrouillons, bilanVide, PAGE, MAX_PAGES }
