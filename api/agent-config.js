// api/agent-config.js
// GET  → charge la config alertes
// POST → sauvegarde la config alertes

const { createClient } = require('@supabase/supabase-js');
const { requirePermission } = require('../lib/require-permission');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ⚠ USURPATION D'IDENTITE CORRIGEE (2 septembre 2026).
//
// Cet endpoint decodait le user_id depuis le JWT SANS VERIFIER LA SIGNATURE :
//
//   const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64'))
//   return payload.sub
//
// Un JWT est en base64, pas chiffre : n'importe qui pouvait forger
// `xxx.<payload avec le sub de sa cible>.yyy` et lire ou ECRIRE la configuration
// d'alertes de n'importe quel compte — les canaux et destinataires des alertes,
// donc de quoi les rediriger.
//
// Le commentaire d'origine invoquait « meme pattern que cron.js » : c'etait faux,
// cron.js s'authentifie par CRON_SECRET et ne decode aucun JWT. C'etait le seul
// endroit du repo a faire cela (verifie par grep).
//
// La verification passe desormais par lib/require-permission.js, qui appelle
// supabase.auth.getUser() — laquelle valide la signature.

// ─── Les DELAIS d'un bien (chantier « delai de reponse IA », lot 1) ──────────
// Spec : docs/specs/spec-delai-reponse-ia.md §3.1.
//
// ⚠ UNE TROISIEME CIBLE, PAS UNE QUATRIEME CLE A PLAT. Le merge cible existant
// (`mode_ref`, `alertes_ref`) impose « une cible par requete » parce qu'un POST
// du blob entier depuis deux onglets s'ecrasait (constat de review). Les trois
// reglages de delai forment UN bloc : l'ecran les enregistre d'un geste, le
// serveur merge sur le blob relu en base.
//
// ⚠ `reponse_ia: null` EST UNE VALEUR, PAS UNE ABSENCE : c'est « Validation
// manuelle ». `0` est « immediat ». Les deux doivent traverser la validation
// sans se confondre avec un champ oublie — d'ou le test d'APPARTENANCE
// (`'reponse_ia' in d`) et pas la verite de la valeur.
// ⚠ LA BORNE N'EST PLUS RECOPIEE ICI (constat de la revue du 27 octobre 2026) :
// elle etait ecrite a deux endroits, et le point de LECTURE (lib/cron-shared.js)
// en avait sa propre copie. Une derive entre les deux rendrait « hors contrat »
// a la lecture une valeur que l'endpoint a acceptee et stockee.
const { minutesValides, formeExploitable } = require('../lib/guestflow/delais-contrat');
const { appliquerDelaiAuxBrouillons, bilanVide } = require('../lib/guestflow/appliquer-delai');
const HEURE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/**
 * Rend le bloc `delais` NETTOYE, ou `null` si la charge est invalide.
 * Jamais d'objet libre dans le blob : chaque champ est borne, et tout champ
 * inconnu est ECARTE (il ne passe pas « au cas ou »).
 */
function delaisPropres (d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (!('reponse_ia' in d) || !('alerte_info' in d)) return null

  // Validation manuelle (`null`) ou un nombre de minutes borne.
  const reponse = d.reponse_ia
  if (reponse !== null && !minutesValides(reponse)) return null
  if (!minutesValides(d.alerte_info)) return null

  // La sourdine est optionnelle ; absente, elle est inactive.
  const s = d.sourdine
  let sourdine = { active: false, debut: '22:00', fin: '08:00' }
  if (s !== undefined) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null
    // `=== true` strict : une chaine « false » n'active rien.
    const active = s.active === true
    const debut = String(s.debut == null ? '' : s.debut)
    const fin = String(s.fin == null ? '' : s.fin)
    // ⚠ LES HEURES SE VALIDENT MEME SOURDINE INACTIVE. Sinon on enregistre une
    // plage illisible qui ne mord qu'au jour ou l'hote active la sourdine —
    // une erreur de saisie qui attend des semaines avant de se manifester.
    if (!HEURE.test(debut) || !HEURE.test(fin)) return null
    // Une plage vide ne se detecte qu'ici : debut === fin voudrait dire « 24 h
    // de sourdine » ou « aucune », et aucune des deux lectures n'est evidente.
    if (debut === fin) return null
    sourdine = { active, debut, fin }
  }

  return { reponse_ia: reponse === null ? null : reponse, alerte_info: d.alerte_info, sourdine }
}

// ─── Le blob LEGACY (POST `config` entier) ───────────────────────────────────
// ⚠ IL RESTE OUVERT PARCE QU'UN APPELANT REEL L'UTILISE : `seedAlertConfig`
// de pages/onboarding.html, qui fait GET du blob, merge cote client, puis POST
// du tout. On ne le RETIRE pas — ca casserait l'onboarding.
//
// ⚠ ET CE QU'IL FERME, IL FAUT LE DIRE EXACTEMENT — LA PREMIERE VERSION DE CE
// COMMENTAIRE AFFIRMAIT PLUS QUE LE CODE NE FAIT (constat de la revue du
// 27 octobre 2026). Le merge est a UN NIVEAU : il protege les cles ABSENTES de
// la charge. Or `seedAlertConfig` n'omet rien — il REPOSTE le blob entier qu'il
// a lu. Donc chaque cle qu'il reemet (`mode`, `intervention`, `info_unknown`)
// ecrase toujours ce qu'une cible concurrente a ecrit entre son GET et son
// POST. Ce qui est ferme : la disparition d'une cle qu'il ne connait pas. Ce
// qui reste ouvert : la peremption d'une cle qu'il connait.
//
// CE QUI EST VRAIMENT PROTEGE, ET C'EST LE POINT : `delais` gouverne les
// ENVOIS, et aucun appelant legacy n'a de raison de l'ecrire (le seeder ne le
// connait pas). On l'ECARTE donc de toute charge legacy : la valeur en base
// gagne, toujours. Un reglage d'envoi ne se change que par sa cible.
//
// La dette restante (le seeder devrait passer par des cibles) est notee au KB.
const CLES_RESERVEES_AUX_CIBLES = ['delais']

function fusionnerBlobLegacy (existant, entrant) {
  const base = existant || {}
  const sortie = { ...base }
  const rejets = []
  // ⚠ CE QUI EST DEJA EN BASE A L'IDENTIQUE N'EST PAS UN REJET, ET SANS CETTE
  // NUANCE LE 400 CASSAIT L'ONBOARDING DEFINITIVEMENT (constat de la revue du
  // 27 octobre 2026). `seedAlertConfig` fait GET(blob) -> merge -> POST(blob) :
  // il REEMET ce qu'il a lu. Si le blob stocke porte deja une entree fautive
  // (non-objet, ou ref trop longue), TOUT POST legacy futur repondrait 400 et
  // n'ecrirait rien — et l'onboarding ne teste pas `r.ok`, donc le seed des
  // alertes echouerait en silence pour ce compte, sans aucun moyen de le
  // reparer par cet endpoint.
  //
  // On refuse donc ce que l'appelant APPORTE de fautif, pas ce qu'il recopie.
  const dejaEnBase = (ref, valeur) => ref in base
    && JSON.stringify(base[ref]) === JSON.stringify(valeur)

  for (const [ref, valeur] of Object.entries(entrant || {})) {
    // ⚠ UN REJET SE DIT, IL NE SE JETTE PAS EN SILENCE (constat de la premiere
    // revue). Ces entrees etaient persistees avant ce lot ; les ecarter en
    // repondant 200 { ok: true } laisse l'appelant croire que tout est passe.
    //
    // ⚠ LA LONGUEUR SE TESTE AVANT LE TYPE : dans l'ordre inverse, une ref
    // enorme a valeur scalaire partait en entier dans `refusees`, sans la
    // troncature prevue (meme revue).
    if (String(ref).length > 64) {
      if (!dejaEnBase(ref, valeur)) rejets.push(String(ref).slice(0, 16) + '…')
      continue
    }
    if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) {
      if (!dejaEnBase(ref, valeur)) rejets.push(ref)
      continue
    }
    const propre = { ...valeur }
    // ⚠ ET L'ECART SE DIT, DANS LA FONCTION MEME QUI POSE « UN REJET SE DIT »
    // (constat de la premiere revue). `delete` silencieux + 200 { ok: true } :
    // un writer qui enverrait `delais` le verrait disparaitre en croyant
    // l'avoir pose.
    //
    // ⚠ MAIS L'EXEMPTION `dejaEnBase` VAUT ICI AUSSI, et son absence cassait
    // l'onboarding (constat 3 de la troisieme revue). `seedAlertConfig` fait
    // GET(blob) -> merge -> POST(blob) : il REEMET ce qu'il a lu. Des qu'un
    // bien du compte porte `delais` — ce que la nouvelle UI ecrit au premier
    // enregistrement —, `reservees` etait non vide, l'endpoint rendait 400 sans
    // rien ecrire, et `pages/onboarding.html` ne teste pas `r.ok` : le seed des
    // alertes echouait EN SILENCE pour ce compte. Meme classe de defaut que
    // celui que `dejaEnBase` ferme, par la porte d'a cote.
    //
    // On refuse donc ce que l'appelant APPORTE sur une cle reservee, pas ce
    // qu'il recopie. Et dans les deux cas la valeur en base gagne.
    const reservees = CLES_RESERVEES_AUX_CIBLES.filter(cle => cle in propre)
    const apportees = reservees.filter(cle => {
      const enBase = base[ref] && base[ref][cle]
      return JSON.stringify(enBase) !== JSON.stringify(propre[cle])
    })
    if (apportees.length) {
      rejets.push(`${ref}.${apportees.join('+')} (réservé à sa cible)`)
      continue
    }
    for (const cle of reservees) delete propre[cle]
    // Les champs entrants se superposent sur l'entree existante ; l'entree
    // n'est jamais remplacee, et les cles reservees restent celles de la base.
    sortie[ref] = { ...(sortie[ref] || {}), ...propre }
  }
  return { blob: sortie, rejets }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Lecture comme ecriture : la config d'alertes releve du domaine `reglages`.
  // Elle n'est rattachee a aucun bien -> pas de perimetre a verifier.
  const garde = await requirePermission(req, res, {
    domaine: 'reglages',
    niveau: req.method === 'GET' ? 'read' : 'write'
  });
  if (!garde.ok) return;
  const userId = garde.accountUserId;

  // ── GET : charger la config ──────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('agent_alert_config')
      .select('config')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[agent-config] GET error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ config: data?.config || {} });
  }

  // ── POST : sauvegarder la config ─────────────
  if (req.method === 'POST') {
    const { config, mode_ref, mode } = req.body || {};

    // Bascule CIBLEE du mode d'un bien (messagerie V5, etape 4) : le merge se
    // fait ICI, sur le blob relu en base — un POST du blob entier depuis deux
    // onglets s'ecrasait des configs d'alertes et des modes (releve en
    // review). La fenetre lecture->ecriture reste, mais en millisecondes
    // serveur, plus en secondes d'ecran.
    const { alertes_ref, alertes } = req.body || {};
    const { delais_ref, delais } = req.body || {};
    const viseMode = mode_ref !== undefined || mode !== undefined;
    const viseAlertes = alertes_ref !== undefined || alertes !== undefined;
    const viseDelais = delais_ref !== undefined || delais !== undefined;
    // Une cible par requete : accepter les deux en appliquant la seule
    // premiere jetterait les alertes sans erreur (releve en review).
    // ⚠ LE COMPTE, PAS LA PAIRE : avec trois cibles, tester `A && B` laisse
    // passer `A && C` et `B && C`. On compte.
    if ([viseMode, viseAlertes, viseDelais].filter(Boolean).length > 1) {
      return res.status(400).json({ error: 'Une cible par requête' });
    }
    if (viseMode || viseAlertes || viseDelais) {
      const cible = viseMode ? 'mode' : viseAlertes ? 'alertes' : 'delais';
      const refBrute = cible === 'mode' ? mode_ref : cible === 'alertes' ? alertes_ref : delais_ref;
      const ref = String(refBrute || '').trim();
      if (!ref || ref.length > 64) return res.status(400).json({ error: 'Payload invalide' });
      if (cible === 'mode' && mode !== 'test' && mode !== 'auto') {
        return res.status(400).json({ error: 'Payload invalide' });
      }
      // Les alertes du bien : les DEUX types, chacun borne champ par champ —
      // jamais un objet libre dans le blob.
      let delaisValides = null;
      if (cible === 'delais') {
        delaisValides = delaisPropres(delais);
        if (!delaisValides) return res.status(400).json({ error: 'Payload invalide' });
      }

      // ⚠ L'APERCU : COMPTER CE QUI PARTIRAIT, SANS RIEN ECRIRE (constat 1 de la
      // revue du 28 octobre 2026). Sous « Je valide chaque reponse » les
      // brouillons s'accumulent sans echeance — ils attendent parce que l'hote
      // ne les a pas valides. En sortir les rearme a `created_at + N`, donc
      // tout ce qui a plus de N d'age part dans les cinq minutes, quel que soit
      // N : un hote qui choisit 24 h POUR ETRE PRUDENT verrait partir tout son
      // arriere de plus de 24 h. Le depot exige le NOMBRE avant un geste de
      // masse vers l'exterieur, et ici la cible est le telephone d'un voyageur.
      //
      // Ce mode est en LECTURE SEULE : il passe la meme garde `reglages:write`
      // (c'est bien une ecriture qu'on prepare), il valide le meme payload, et
      // il sort AVANT l'upsert du blob.
      if (cible === 'delais' && (req.body || {}).apercu === true) {
        let apercu;
        try {
          apercu = await appliquerDelaiAuxBrouillons(supabase, {
            userId, propertyRef: ref, delais: delaisValides, maintenant: Date.now(), apercu: true
          });
        } catch (e) {
          apercu = bilanVide({ motif: 'exception', erreur: String(e && e.message || e) });
        }
        // ⚠ UN APERCU EN ECHEC BLOQUE L'HOTE, DONC IL DOIT LAISSER UNE TRACE
        // COTE SERVEUR (constat 3 de la revue). `logger.error` de l'ecran n'ecrit
        // que la console du NAVIGATEUR : `lecture_impossible`,
        // `lecture_illisible` et `trop_de_brouillons` n'existaient dans aucun
        // log Vercel, et ce sont precisement les etats qui empechent
        // l'enregistrement. Symetrique de la ligne du chemin reel.
        if (!apercu.ok) {
          console.error('[agent-config] delais -> apercu:', apercu.motif, apercu.erreur || '');
        }
        return res.status(200).json({ ok: true, delais_ref: ref, apercu });
      }
      // La reprise de la sourdine existante se fait plus bas, une fois le blob
      // relu : sans elle, un enregistrement partiel DESACTIVE une sourdine
      // active et perd sa plage, en 200 et sans un mot (constat de la revue du
      // 27 octobre 2026).
      const sourdineFournie = !!(delais && typeof delais === 'object' && !Array.isArray(delais)
        && delais.sourdine !== undefined);
      let alertesPropres = null;
      if (cible === 'alertes') {
        if (!alertes || typeof alertes !== 'object') return res.status(400).json({ error: 'Payload invalide' });
        alertesPropres = {};
        for (const type of ['intervention', 'info_unknown']) {
          const a = alertes[type];
          if (!a || typeof a !== 'object') return res.status(400).json({ error: 'Payload invalide' });
          const sms = String(a.sms_lines || ''); const email = String(a.email_lines || '');
          if (sms.length > 2000 || email.length > 2000) return res.status(400).json({ error: 'Destinataires trop longs' });
          alertesPropres[type] = {
            sms_enabled: a.sms_enabled === true, sms_lines: sms,
            email_enabled: a.email_enabled === true, email_lines: email
          };
        }
      }
      const { data: lu, error: eL } = await supabase
        .from('agent_alert_config')
        .select('config').eq('user_id', userId).maybeSingle();
      if (eL) return res.status(503).json({ error: 'Lecture impossible' });
      const blob = (lu && lu.config) || {};
      // ⚠ SOURDINE ABSENTE DE LA CHARGE = ON GARDE CELLE DE LA BASE. Le bloc
      // `delais` est remplace en entier (voir plus bas), donc une charge sans
      // `sourdine` y aurait substitue le defaut inactif : l'hote qui enregistre
      // ses deux delais perdait sa plage de nuit sans etre prevenu.
      if (cible === 'delais' && !sourdineFournie) {
        const ancienne = blob[ref] && blob[ref].delais && blob[ref].delais.sourdine;
        if (ancienne && typeof ancienne === 'object' && !Array.isArray(ancienne)) {
          delaisValides = { ...delaisValides, sourdine: ancienne };
        }
      }
      // ⚠ LE RAPPEL SURVIT AU REMPLACEMENT DU BLOC (constat 9 de la seconde
      // revue). `delaisPropres` ne rend que { reponse_ia, alerte_info,
      // sourdine }, et le bloc est remplace en entier : un hote qui reglait
      // 30 minutes puis enregistrait « Je valide chaque reponse » perdait le
      // souvenir des 30 — et un POST `mode: 'auto'` ulterieur (onboarding,
      // script) retombait sur 0, donc l'envoi immediat. Meme classe de defaut
      // que le constat 8, par la porte qui restait.
      if (cible === 'delais') {
        const ancien = (blob[ref] && blob[ref].delais) || {};
        // ⚠ LE SOUVENIR SE CAPTURE, PAS SEULEMENT SE GARDE (constat 4 de la
        // troisieme revue). Je ne lisais que l'ancien `reponse_ia_rappel`,
        // jamais le `reponse_ia` COURANT. Deroule reel : l'hote regle 30 min
        // (aucun rappel n'existe encore), puis choisit « Je valide chaque
        // reponse » — l'ancien rappel etait `undefined`, donc le 30 etait
        // PERDU, et un POST `mode: 'auto'` ulterieur retombait sur 0, donc
        // l'envoi immediat. La branche `cible === 'mode'` faisait deja le bon
        // geste ; il manquait la symetrie.
        const aCapturer = minutesValides(ancien.reponse_ia) && ancien.reponse_ia > 0
          ? ancien.reponse_ia
          : (minutesValides(ancien.reponse_ia_rappel) ? ancien.reponse_ia_rappel : null);
        // Un reglage EXPLICITE a une valeur non nulle n'a pas besoin de
        // souvenir : c'est lui, desormais, qui sera capture au prochain passage
        // en validation manuelle.
        const aGarder = minutesValides(delaisValides.reponse_ia) && delaisValides.reponse_ia > 0
          ? null : aCapturer;
        if (aGarder !== null) {
          delaisValides = { ...delaisValides, reponse_ia_rappel: aGarder };
        }
      }
      // ⚠ LES DEUX CLES RESTENT D'ACCORD, ET C'EST UN CONSTAT GRAVE DE LA REVUE
      // DU 27 OCTOBRE 2026. `getPropertyMode` fait gouverner `delais` quand il
      // existe — mais DEUX lecteurs lisent encore `mode` et personne ne les
      // synchronisait : `modesDe` (pages/messages.html, l'interrupteur
      // Test/Auto, qui RELIT apres ecriture et confirmait donc une valeur qui
      // ne gouverne plus) et la garde de scripts/templates-test-colomiers.js.
      //
      // Le scenario : apres la migration des donnees (spec §6), l'hote bascule
      // un bien en Test ; le POST ecrit `mode:'test'`, l'ecran AFFICHE Test, et
      // GuestFlow continue d'envoyer tout seul. Le script, lui, imprime
      // « mode : test — jamais un envoi » puis arme un message sur un sejour en
      // cours. Un interrupteur qui ment est pire qu'un interrupteur absent.
      //
      // Tant que la cle `mode` existe (elle part au lot 4), CHAQUE ecriture
      // pose les DEUX, dans les deux sens :
      //   · cible `delais` -> `mode` derive (reponse_ia null = test, sinon auto)
      //   · cible `mode`   -> `delais.reponse_ia` aligne (test = null, auto = 0)
      // `auto` vaut 0 et pas 15 : c'est le sens EXACT du Mode Auto d'avant,
      // « ca part tout de suite ». Un toggle ne doit pas inventer un delai.
      const modeDerive = cible === 'delais'
        ? (delaisValides.reponse_ia === null ? 'test' : 'auto')
        : null
      // ⚠ DEUX CONSTATS DE LA REVUE DU 27 OCTOBRE 2026 SUR CES TROIS LIGNES.
      //
      // 1. LA FORME SE VERIFIE AVANT D'ETALER. `blob[ref].delais` etait seulement
      //    teste pour sa VERITE : un `delais: []` (forme que le point de lecture
      //    argumente comme atteignable) donnait `{ ...[], reponse_ia: 0 }`, soit
      //    `{ reponse_ia: 0 }` — plus d'`alerte_info`, plus de `sourdine`. Le
      //    serveur ecrivait lui-meme un bloc que son propre validateur
      //    refuserait, et le lot 2 lirait `alerte_info === undefined` (« pas
      //    d'echeance d'alerte ») sans le voir. Pour un scalaire, pire encore :
      //    `{ ...'22' }` donne `{ 0:'2', 1:'2' }`.
      //
      // 2. BASCULER TEST PUIS AUTO DETRUISAIT LE DELAI REGLE PAR L'HOTE. Il
      //    regle 30 minutes ; il touche l'interrupteur (Test, puis Auto) ;
      //    `reponse_ia` revenait a 0, donc envoi immediat, et les 30 minutes
      //    etaient perdues sans trace ni avertissement. Le raisonnement
      //    precedent ne couvrait que « ne pas INVENTER un delai » — pas la
      //    destruction d'un delai existant.
      //
      //    On MEMORISE donc la derniere valeur non nulle (`reponse_ia_rappel`)
      //    au passage en Test, et on la RESTITUE au retour en Auto. Sans
      //    rappel, Auto vaut 0 : le sens exact du Mode Auto d'avant.
      const ancienDelais = cible === 'mode' && formeExploitable(blob[ref] && blob[ref].delais)
        ? blob[ref].delais
        : null
      let delaisAlignes = null
      if (ancienDelais) {
        if (mode === 'test') {
          const aRetenir = minutesValides(ancienDelais.reponse_ia) && ancienDelais.reponse_ia > 0
            ? ancienDelais.reponse_ia
            : (minutesValides(ancienDelais.reponse_ia_rappel) ? ancienDelais.reponse_ia_rappel : undefined)
          delaisAlignes = { ...ancienDelais, reponse_ia: null,
            ...(aRetenir === undefined ? {} : { reponse_ia_rappel: aRetenir }) }
        } else {
          // ⚠ LA VALEUR COURANTE D'ABORD (constat 8 de la revue du 27 octobre
          // 2026). Ce bloc ne regardait que `reponse_ia_rappel` : un POST
          // `mode: 'auto'` sur un bien dont `reponse_ia` valait DEJA 30, sans
          // rappel, ecrivait 0 — envoi immediat, delai detruit. C'est exactement
          // le defaut que ce bloc existe pour corriger, par l'autre porte.
          // Plus aucun ecran ne poste `mode_ref` (le toggle a disparu), donc le
          // chemin est atteignable par un script ou l'onboarding, pas par un
          // clic — ce qui le rend plus silencieux, pas moins reel.
          const dejaRegle = minutesValides(ancienDelais.reponse_ia) && ancienDelais.reponse_ia > 0
            ? ancienDelais.reponse_ia : null
          const rappel = dejaRegle !== null ? dejaRegle
            : (minutesValides(ancienDelais.reponse_ia_rappel) ? ancienDelais.reponse_ia_rappel : 0)
          delaisAlignes = { ...ancienDelais, reponse_ia: rappel }
        }
      }

      blob[ref] = cible === 'mode'
        ? { ...(blob[ref] || {}), mode, ...(delaisAlignes ? { delais: delaisAlignes } : {}) }
        : cible === 'delais'
          // Le bloc ENTIER remplace le precedent : les trois reglages voyagent
          // ensemble et l'ecran les envoie ensemble. Un merge champ par champ
          // laisserait une sourdine orpheline apres un changement de forme.
          ? { ...(blob[ref] || {}), delais: delaisValides, mode: modeDerive }
          : { ...(blob[ref] || {}),
              intervention: { ...((blob[ref] || {}).intervention || {}), ...alertesPropres.intervention },
              info_unknown: { ...((blob[ref] || {}).info_unknown || {}), ...alertesPropres.info_unknown } };
      const { error: eW } = await supabase
        .from('agent_alert_config')
        .upsert(
          { user_id: userId, config: blob, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      if (eW) {
        console.error('[agent-config] POST cible error:', eW);
        return res.status(500).json({ error: eW.message });
      }

      // ⚠ LE NOUVEAU REGLAGE GOUVERNE AUSSI LES BROUILLONS DEJA EN ATTENTE
      // (decision de Thierry, 28 octobre 2026 : « mon dernier reglage gouverne
      // toujours »). Sans ce passage, le reglage ne valait que pour les
      // brouillons A VENIR : `lib/cron-classify.js` lit le delai en CREANT la
      // tache, et plus rien ne la relit — un brouillon arme a +60 min survivait
      // au retour en validation manuelle, et l'ecran annoncait « Part dans
      // 59 min » pendant une heure.
      //
      // ⚠ APRES L'UPSERT, PAS AVANT, ET L'ORDRE COMPTE. Le reglage gouverne les
      // brouillons a venir : s'il echoue, il n'y a rien a propager. Et s'il est
      // ecrit mais que la propagation echoue, on NE PEUT PAS rendre un 500 — le
      // reglage, lui, est bien enregistre, et un 500 ferait croire l'inverse.
      // L'ecran recoit donc `brouillons` et le DIT : « Enregistre en partie ».
      // ⚠ ET LA PROPAGATION PEUT ETRE REFUSEE SANS PERDRE LE RESTE DU PANNEAU
      // (constat 2 de la revue, et c'etait un vrai defaut de mon correctif).
      // `delais` porte TROIS reglages — le delai de reponse, l'echeance d'alerte
      // et la sourdine. Mon premier jet, quand l'hote refusait de liberer son
      // arriere, n'envoyait PAS le POST du tout : sa plage de sourdine etait
      // perdue, et la note ne parlait que « des delais ». Il n'avait aucun moyen
      // d'enregistrer une sourdine sans accepter de liberer l'arriere.
      // « Ne pas savoir combien n'autorise pas a le faire » vaut pour
      // `reponse_ia` ; je l'avais applique au bloc entier.
      //
      // Donc : `propager: false` enregistre le blob et SAUTE la reprise des
      // brouillons. Les deja-en-attente gardent leur echeance — c'est le
      // comportement d'avant ce lot, et c'est exactement ce que l'hote a choisi
      // en refusant — tandis que le reglage gouverne les brouillons A VENIR.
      let brouillons = null;
      if (cible === 'delais') {
        if ((req.body || {}).propager === false) {
          brouillons = bilanVide({ ok: true, motif: 'propagation_non_demandee' });
        } else {
          try {
            // ⚠ « GARDER POUR VALIDATION » (decision de Thierry du 29 octobre
            // 2026) : l'ecran demande le DESARMEMENT des propositions
            // annoncees, pas leur liberation. Deux issues reelles, et c'est le
            // sens de son arbitrage — une confirmation dont une branche
            // n'ecrit rien n'est pas une confirmation.
            //
            // `cutoff` est l'instant que l'APERCU a utilise pour compter : le
            // writer le valide (fenetre de 10 min) et s'en sert comme meme
            // predicat, pour que « les propositions annoncees » designe
            // exactement l'ensemble desarme. Une valeur absente ou aberrante
            // retombe sur `Date.now()`, donc sur le comportement par defaut.
            const garderEchues = (req.body || {}).garder === true;
            const brut = Number((req.body || {}).cutoff);
            brouillons = await appliquerDelaiAuxBrouillons(supabase, {
              userId, propertyRef: ref, delais: delaisValides, maintenant: Date.now(),
              garderEchues, cutoff: Number.isFinite(brut) ? brut : undefined
            });
          } catch (e) {
            brouillons = bilanVide({ motif: 'exception', erreur: String(e && e.message || e) });
          }
          if (!brouillons.ok) {
            console.error('[agent-config] delais -> brouillons:', brouillons.motif, brouillons.erreur || '');
          }
        }
      }

      return res.status(200).json(cible === 'mode'
        ? { ok: true, mode_ref: ref, mode }
        : cible === 'delais'
          ? { ok: true, delais_ref: ref, delais: delaisValides, brouillons }
          : { ok: true, alertes_ref: ref, alertes: alertesPropres });
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: 'Payload invalide' });
    }

    // ⚠ CE CHEMIN MERGE, IL N'ECRASE PLUS (chantier delai de reponse IA,
    // lot 1). Il recevait le blob entier et le posait tel quel : un onglet en
    // retard d'une seconde effacait les reglages d'un autre — et, depuis ce
    // lot, les DELAIS d'un bien, donc son comportement d'envoi. Voir
    // `fusionnerBlobLegacy` en tete de fichier pour le pourquoi et pour
    // l'appelant qui le maintient ouvert.
    const { data: luLegacy, error: eLegacy } = await supabase
      .from('agent_alert_config')
      .select('config').eq('user_id', userId).maybeSingle();
    if (eLegacy) return res.status(503).json({ error: 'Lecture impossible' });
    const { blob: fusionne, rejets } = fusionnerBlobLegacy(luLegacy && luLegacy.config, config);
    if (rejets.length) {
      return res.status(400).json({ error: 'Entrées invalides', refusees: rejets });
    }

    const { error } = await supabase
      .from('agent_alert_config')
      .upsert(
        { user_id: userId, config: fusionne, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (error) {
      console.error('[agent-config] POST error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
};
