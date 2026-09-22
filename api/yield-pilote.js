// api/yield-pilote.js
// LE PILOTE TARIFAIRE D'UN BIEN — lot 4.5.
// Spec : docs/specs/spec-yieldflow-v1.md §2 bis
// Regle : lib/pilote-tarifaire.js — DOC : docs/kb/coeur-de-donnees.md
//
// GET  ?bien=<uuid>  -> { pilote, peut_basculer, raison, fenetre, ouverture }
// POST { bien, pilote: 'calendrier' | 'yieldflow', fenetre?: { type, valeur } }
// POST { bien, fenetre: { type, valeur } }   (changer la fenetre, bien pilote)
//
// ⚠ L'ACTIVATION (lot 4.6.3) = passer en yieldflow AVEC une fenetre. Sans
// fenetre, le mode n'ouvre rien (4.6.0 : un bien yieldflow sans fenetre n'a
// pas de « hors fenetre »). On la rend donc OBLIGATOIRE a la bascule, et
// modifiable ensuite. Repasser en calendrier l'efface : la fenetre est une
// propriete du pilote, pas du bien.
//
// ⚠ CET ENDPOINT N'OUVRE RIEN. Il regle, et il EFFACE le marqueur quotidien
// du moteur (`cron_logs` ouverture:<bien>) pour que le cron ouvre au tick
// suivant (5 min) et non le lendemain. Le moteur reste en processus, appele
// par le cron seul : cet endpoint n'importe que le marqueur, jamais le moteur.
//
// ⚠ POURQUOI CET ENDPOINT EXISTE, ET PAS UNE LIGNE DANS `/api/yield`.
// `api/yield.js` grave en tete qu'il n'ecrit RIEN — « lecture seule » y est un
// invariant, pas une description. Y glisser une ecriture le rendrait faux pour
// le prochain qui le lit. Une fonction de plus : 51 sur 100 (limite Vercel Pro).
//
// ⚠ POURQUOI ICI ET PAS DANS `/settings`.
// Le pilote est une CONFIG D'APP : il se regle dans Yield. Test qui tranche
// (docs/kb/coeur-de-donnees.md) : ce reglage aurait-il un sens si l'app
// n'existait pas ? Non — « qui decide les prix » ne se pose que parce que
// YieldFlow existe. Le STOCKAGE, lui, reste une colonne de `properties`, parce
// que la couche de poussee doit le lire sans connaitre l'app : « la config
// d'app vit dans l'app » porte sur QUI LA GERE, pas sur la table.
//
// ⚠ DROIT `reglages` EN ECRITURE, comme `yield-exceptions`. Basculer le pilote
// change QUI decide les prix : c'est le meme niveau de consequence qu'un prix,
// donc le meme droit que le calendrier tarifaire. Le ranger sous
// `reservations` laisserait un profil qui gere les sejours changer la main qui
// tarife.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const {
  MODES, piloteDuBien, peutPasserEnYieldflow, fenetreDuBien, validerFenetre
} = require('../lib/pilote-tarifaire')
const { effacerMarqueur, lireMarqueur } = require('../lib/ouverture-marqueur')
const { viderPrixHote } = require('../lib/prix-hote')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async (req, res) => {
  const body = req.body || {}
  // Les deux noms, comme `yield-exceptions` : l'ecran du lot 4.3 envoyait
  // `property_id` a un endpoint qui attendait `bien`, et CHAQUE saisie
  // repondait « Aucun logement designe ». On ne refait pas ce vocabulaire.
  const bienDemande = req.query.bien || body.bien
    || req.query.property_id || body.property_id
  if (!bienDemande) return res.status(400).json({ error: 'bien_requis' })

  const ecriture = req.method !== 'GET'
  const garde = await requirePermission(req, res, {
    domaine: ecriture ? 'reglages' : 'reservations',
    niveau: ecriture ? 'write' : 'read',
    bien: bienDemande,
    bienRequis: true
  })
  if (!garde.ok) return

  const bienGarde = garde.bien
  const compte = garde.accountUserId

  // ⚠ LA GARDE NE CHARGE PAS CE QUE CET ENDPOINT JUGE — RELU EN REVIEW.
  // `resoudreBien` (lib/require-permission.js) ne selectionne que
  // `id, user_id, name, provider, provider_property_id,
  // migration_target_property_id`. Ni `pilote_tarifaire`, ni `rate_sync_mode`.
  // Juger sur `garde.bien` rendait donc TOUT l'endpoint inoperant, en silence :
  // le GET annonçait « calendrier / bascule impossible » pour tous les biens, y
  // compris un bien `managed` ; le POST vers yieldflow rendait 409 toujours ; et
  // le POST retour vers 'calendrier' voyait `actuel === 'calendrier'`, donc
  // repondait 200 « rien a faire » SANS ECRIRE — un bien bascule par un autre
  // chemin serait reste verrouille, ses prix refuses par le calendrier et sa
  // sortie impossible par l'ecran.
  //
  // C'est mot pour mot la lecon gravee dans `api/channel-property.js` : « une
  // garde qui juge sur une colonne non selectionnee est une garde ouverte ».
  // Elle vaut aussi pour une garde qui juge sur une colonne ABSENTE.
  const { data: bien, error: eBien } = await supabase.from('properties')
    .select('id, name, rate_sync_mode, pilote_tarifaire, pilote_fenetre_type, pilote_fenetre_valeur')
    .eq('id', bienGarde.id).eq('user_id', compte).maybeSingle()
  if (eBien) {
    console.error('[yield-pilote] lecture bien', eBien.message)
    return res.status(503).json({ error: 'Réglage illisible pour le moment. Réessayez.' })
  }
  if (!bien) return res.status(404).json({ error: 'Logement introuvable.' })

  // ─── GET : l'etat, et CE QUI EST POSSIBLE ──────────────────────────────
  // L'ecran a besoin des deux : le mode courant, et si la bascule est ouverte.
  // Lui faire deduire « keep => interdit » le rendrait porteur de la regle, et
  // la regle vit dans `lib/pilote-tarifaire.js`, en un seul endroit.
  if (req.method === 'GET') {
    const possible = peutPasserEnYieldflow(bien)
    // La derniere ouverture du moteur, pour que l'ecran dise « ouvert jusqu'au
    // … le … » plutot que de laisser l'hote deviner si le cron est passe.
    const marqueur = await lireMarqueur(supabase, bien.id)
    return res.status(200).json({
      bien: bien.id,
      pilote: piloteDuBien(bien),
      rate_sync_mode: bien.rate_sync_mode || null,
      peut_basculer: possible.ok,
      raison: possible.ok ? null : possible.error,
      fenetre: fenetreDuBien(bien),
      ouverture: { derniere: marqueur ? marqueur.derniere : null, bilan: marqueur ? marqueur.bilan : null }
    })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // ─── POST : basculer, et/ou regler la fenetre ─────────────────────────
  const actuel = piloteDuBien(bien)
  const voulu = body.pilote == null ? actuel : String(body.pilote || '').trim()
  if (!MODES.includes(voulu)) {
    return res.status(400).json({
      error: 'Mode de pilotage inconnu.',
      attendus: MODES
    })
  }

  // La fenetre : obligatoire pour ENTRER en yieldflow, modifiable tant qu'on y
  // est, ignoree (et effacee) en calendrier.
  let fenetre = null
  // Une fenetre seule sur un bien en calendrier n'a pas de sens : on le dit,
  // plutot que de repondre 200 « rien a faire » (releve en review).
  if (voulu === 'calendrier' && body.fenetre != null) {
    return res.status(400).json({ error: 'La fenêtre d\'ouverture ne se règle qu\'en mode YieldFlow.', code: 'fenetre_hors_yieldflow' })
  }
  if (voulu === 'yieldflow') {
    const entreeEnYieldflow = actuel !== 'yieldflow'
    if (entreeEnYieldflow || body.fenetre != null) {
      const v = validerFenetre(body.fenetre)
      if (!v.ok) return res.status(400).json({ error: v.error, code: v.code })
      fenetre = v.fenetre
    }
  }

  // Rien a faire n'est pas une erreur : l'ecran peut renvoyer l'etat courant.
  const memeFenetre = !fenetre || (fenetreDuBien(bien) && fenetreDuBien(bien).type === fenetre.type && fenetreDuBien(bien).valeur === fenetre.valeur)
  if (voulu === actuel && memeFenetre) {
    return res.status(200).json({ bien: bien.id, pilote: actuel, fenetre: fenetreDuBien(bien), change: false })
  }

  // ⚠ B BIS. Un bien en `rate_sync_mode = 'keep'` ne peut pas passer en
  // yieldflow : l'app ecrirait des prix que rien ne pousse. Le refus est
  // EXPLICITE et en francais — la regle et son message vivent dans le module.
  if (voulu === 'yieldflow' && actuel !== 'yieldflow') {
    const possible = peutPasserEnYieldflow(bien)
    if (!possible.ok) {
      console.log('[yield-pilote] REFUS bascule keep :', bien.id)
      return res.status(409).json({ error: possible.error, code: possible.code })
    }
  }

  // ⚠ LE COMPTE DANS LE `WHERE`, PAS SEULEMENT DANS LA GARDE. La garde a deja
  // tranche, mais une requete qui ne porte pas son cloisonnement finit par
  // etre recopiee dans un contexte qui n'en a plus.
  const maj = { pilote_tarifaire: voulu }
  if (voulu === 'calendrier') { maj.pilote_fenetre_type = null; maj.pilote_fenetre_valeur = null }
  else if (fenetre) { maj.pilote_fenetre_type = fenetre.type; maj.pilote_fenetre_valeur = fenetre.valeur }
  const { error } = await supabase.from('properties')
    .update(maj)
    .eq('id', bien.id).eq('user_id', compte)

  if (error) {
    console.error('[yield-pilote] ecriture', error.message)
    // La contrainte croisee de la base (filet de B bis) parle postgres : on
    // ne la laisse pas remonter telle quelle a l'hote.
    if (String(error.message || '').includes('properties_pilote_keep_ck')) {
      return res.status(409).json({
        error: peutPasserEnYieldflow({ ...bien, rate_sync_mode: 'keep' }).error,
        code: 'pilote_refuse_keep'
      })
    }
    return res.status(503).json({ error: 'Enregistrement impossible pour le moment. Réessayez.' })
  }

  // ⚠ BASCULER NE CHANGE AUCUN PRIX (§2 bis). Les lignes `calendar_inventory`
  // en place restent, le journal continue. C'est un changement d'ECRIVAIN, pas
  // de tarif — et rien n'est pousse ici.
  //
  // ⚠ CE QUI OUVRE, C'EST LE CRON. On efface le marqueur quotidien du moteur
  // pour que la fenetre s'ouvre (ou s'etende) au tick suivant. Un echec ici
  // n'annule pas le reglage : au pire, l'ouverture attend le lendemain.
  if (voulu === 'yieldflow') {
    const { error: eM } = await effacerMarqueur(supabase, bien.id)
    if (eM) console.error('[yield-pilote] marqueur non efface', bien.id, eM.message)
  }
  // Retour en calendrier : la main de l'hote n'a plus d'objet — ses prix vivent
  // dans le calendrier, qu'il tient lui-meme.
  if (voulu === 'calendrier' && actuel === 'yieldflow') await viderPrixHote(supabase, { userId: compte, propertyId: bien.id })
  console.log(`[yield-pilote] ${bien.id} : ${actuel} -> ${voulu}${fenetre ? ` (fenetre ${fenetre.valeur} ${fenetre.type})` : ''}`)
  return res.status(200).json({ bien: bien.id, pilote: voulu, fenetre: voulu === 'yieldflow' ? (fenetre || fenetreDuBien(bien)) : null, change: true,
    ouverture: voulu === 'yieldflow' ? 'Les dates s\'ouvriront automatiquement dans les 5 minutes, puis chaque jour.' : null })
}
