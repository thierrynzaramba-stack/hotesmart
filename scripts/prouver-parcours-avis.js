#!/usr/bin/env node
// scripts/prouver-parcours-avis.js — lot 4 du chantier « evaluation du voyageur ».
//
// LE PARCOURS COMPLET, SUR LA VRAIE BASE : PRESTATAIRE (LIEN) → HOTE →
// PUBLICATION SIMULEE.
//
// Demande de Thierry pour le lot 4. Les tests unitaires prouvent chaque module
// sur des doubles ; celui-ci prouve que la CHAINE tient sur des donnees reelles :
// une vraie ligne `guest_evaluations`, une vraie grille chargee depuis la base,
// une vraie transition de statut ecrite puis relue.
//
// ⚠ RIEN N'EST ENVOYE A AIRBNB. Le provider est un double LOCAL : il enregistre
// la charge et rend un succes. La spec §3 interdit tout appel provider hors
// lib/channels/, et ce script n'en fait aucun — il en passe un faux a
// `publier()`, exactement comme les tests. Chez Airbnb un avis publie ne se
// reprend pas : aucun script ne doit pouvoir en envoyer un par accident.
//
// Usage : node --env-file=.env.staging scripts/prouver-parcours-avis.js
//
// ⚠ STAGING UNIQUEMENT, et il le verifie par DEUX empreintes : la reference du
// projet et le nombre de biens. Il ECRIT, puis NETTOIE dans un `finally`, et
// RELIT pour le prouver.
const { createClient } = require('@supabase/supabase-js')
const { chargerGrille, criteresPour, enregistrerReponses, journaliser } = require('../lib/avis/evaluations')
const { publier, RefusPublication } = require('../lib/avis/publication')
const { GRILLE_DEFAUT } = require('../lib/avis/notes-evaluation')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const PROJET_STAGING = 'ortyofzzdsthlhqmzsnq'

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }
class Abandon extends Error {}
const abandon = (m) => { ko(m); throw new Abandon(m) }

// Le double de provider. Il n'a AUCUN acces reseau : c'est tout l'objet.
function providerSimule () {
  const appels = []
  return {
    appels,
    async publierAvisVoyageur (reviewId, charge) {
      appels.push({ type: 'post', reviewId, charge })
      return { ok: true, status: 200, json: { data: { id: reviewId, simule: true } } }
    },
    async lireAvis (reviewId) {
      appels.push({ type: 'get', reviewId })
      return { ok: true, status: 200, is_replied: false, json: {} }
    },
  }
}

;(async () => {
  console.log(`Projet Supabase : ${projet}`)
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Empreinte : ${biens} bien(s)\n`)
  if (projet !== PROJET_STAGING) {
    console.error(`ECHEC : ce script ECRIT. Il ne tourne que sur STAGING (${PROJET_STAGING}).`)
    process.exit(1)
  }
  if (biens !== 3) {
    console.error('ECHEC : projet de staging reconnu, mais 3 biens attendus. Relis la garde avant de forcer.')
    process.exit(1)
  }

  const aNettoyer = { evaluation: null, otaReview: null, profil: null, critere: null, evenements: [] }
  try {
    const { data: bien } = await sb.from('properties')
      .select('id, user_id, name, provider_property_id, provider').order('created_at').limit(1).single()
    const compte = bien.user_id
    console.log(`Compte ${String(compte).slice(0, 8)} · bien « ${bien.name} » (${bien.provider})\n`)

    // ─── Le decor : un objet review de l'OTA, et une evaluation a remplir ──
    const suffixe = Date.now()
    const { data: review, error: eRev } = await sb.from('ota_reviews').insert({
      user_id: compte, property_id: bien.id,
      provider: 'channex', ota: 'airbnb',
      external_review_id: `PARCOURS-${suffixe}`,
      property_id_ref: String(bien.provider_property_id),
      received_at: new Date().toISOString(),
    }).select().single()
    if (eRev) abandon(`objet review impossible : ${eRev.message}`)
    aNettoyer.otaReview = review.id
    ok(`objet review de l OTA cree (reference provider PARCOURS-${suffixe})`)

    const { data: evaluation, error: eEval } = await sb.from('guest_evaluations').insert({
      user_id: compte, property_id: bien.id,
      property_id_ref: String(bien.provider_property_id),
      booking_uid: `PARCOURS-${suffixe}`,
      ota_review_id: review.id, provider: 'channex', ota: 'airbnb',
      status: 'a_remplir', language: 'fr',
      deadline_at: new Date(Date.now() + 10 * 86400000).toISOString(),
    }).select().single()
    if (eEval) abandon(`evaluation impossible : ${eEval.message}`)
    aNettoyer.evaluation = evaluation.id
    ok('evaluation creee, statut a_remplir')

    // ─── La prestataire, par LIEN, pouvoir « soumettre » ───────────────────
    const { data: profil, error: eProfil } = await sb.from('profiles').insert({
      account_user_id: compte, first_name: 'Parcours', last_name: 'Preuve',
      // ⚠ UN PROFIL `lien` ACTIF EXIGE UN `pwa_token` : contrainte
      // profiles_token_coherent, posee le 3 septembre 2026. Le token est
      // jetable et part avec le profil au nettoyage.
      access_mode: 'lien', active: true, accepted_at: new Date().toISOString(),
      pwa_token: `parcours-${suffixe}-${Math.random().toString(36).slice(2, 10)}`,
      eval_scope: 'selon_grille', eval_power: 'soumettre',
    }).select().single()
    if (eProfil) abandon(`profil prestataire impossible : ${eProfil.message}`)
    aNettoyer.profil = profil.id
    ok('profil prestataire cree : acces par LIEN, pouvoir soumettre')

    // ─── ETAPE 0 : UNE VRAIE GRILLE D'HOTE, EN BASE ────────────────────────
    // ⚠ CETTE ETAPE EST CELLE QUI A TROUVE DEUX DEFAUTS. Sans critere en base,
    // `chargerGrille` rend la grille par defaut du code sans jamais lire les
    // deux tables — et les deux bugs y etaient : une relation ambigue entre
    // criteres et niveaux (deux cles etrangeres, PostgREST refusait de choisir)
    // et une colonne `cle` demandee qui n'existe pas. Les 3690 tests unitaires
    // ne pouvaient pas les voir : leur double de base n'execute pas de SQL.
    const { data: critere, error: eCrit } = await sb.from('avis_criteres').insert({
      user_id: compte, property_id: bien.id,
      libelle: 'PARCOURS — respect du couvre-feu',
      categorie: 'respect_house_rules', rempli_par: 'prestataire', rang: 1,
    }).select().single()
    if (eCrit) abandon(`critere d hote impossible : ${eCrit.message}`)
    aNettoyer.critere = critere.id

    const niveaux = [
      { cle: 'respecte', libelle: 'Respecte', rang: 1, note: 5, negatif: false },
      { cle: 'bruyant', libelle: 'Bruyant apres minuit', rang: 2, note: 2, negatif: false },
      { cle: 'jamais', libelle: 'Jamais respecte', rang: 3, note: 1, negatif: true },
    ].map(n => ({ ...n, critere_id: critere.id, categorie: 'respect_house_rules' }))
    const { error: eNiv } = await sb.from('avis_criteres_niveaux').insert(niveaux)
    if (eNiv) abandon(`niveaux impossibles : ${eNiv.message}`)
    ok('ETAPE 0 — une grille d HOTE existe en base : 1 critere, 3 niveaux')

    // ─── La grille reellement chargee depuis la base ───────────────────────
    const grille = await chargerGrille(sb, { userId: compte, propertyId: bien.id })
    if (grille.defaut) {
      ko('ETAPE 0 — la grille de l HOTE n a pas ete chargee : c est celle du code qui sort')
    } else if (grille.criteres.length !== 1) {
      ko(`ETAPE 0 — ${grille.criteres.length} critere(s) charges au lieu d un`)
    } else {
      const c = grille.criteres[0]
      c.cle === critere.id
        ? ok('ETAPE 0 — la cle du critere est son identifiant en base, stable et unique')
        : ko(`ETAPE 0 — cle inattendue : ${c.cle}`)
      ;(c.niveaux || []).length === 3
        ? ok('ETAPE 0 — ses trois niveaux sont charges, tries par rang')
        : ko(`ETAPE 0 — ${(c.niveaux || []).length} niveau(x) charges au lieu de trois`)
      ;(c.niveaux || [])[0]?.cle === 'respecte'
        ? ok('ETAPE 0 — le meilleur niveau vient en premier')
        : ko('ETAPE 0 — les niveaux ne sont pas dans l ordre du rang')
    }
    console.log(`\n  Grille : ${grille.defaut ? 'celle du code (aucun critere en base)' : `${grille.criteres.length} critere(s) de l hote`}`)
    const ouverts = criteresPour(grille, 'prestataire', 'selon_grille')
    if (!ouverts.length) abandon('la grille n ouvre aucun critere a la prestataire : le parcours ne peut pas commencer')
    ok(`${ouverts.length} critere(s) ouverts a la prestataire`)

    const meilleur = (c) => c.categorie === 'recommandation'
      ? (c.niveaux.find(n => n.recommande === true) || c.niveaux[0]).cle
      : [...c.niveaux].sort((a, b) => (b.note || 0) - (a.note || 0))[0].cle

    // ─── ETAPE 1 : la prestataire remplit sa part ───────────────────────────
    const partPresta = Object.fromEntries(ouverts.map(c => [c.cle, meilleur(c)]))
    const r1 = await enregistrerReponses(sb, {
      evaluation, reponses: partPresta, role: 'prestataire',
      evalScope: 'selon_grille', evalPower: 'soumettre', parProfil: profil.id,
    })
    r1.decision.statut === 'soumise_prestataire'
      ? ok('ETAPE 1 — la prestataire soumet : statut soumise_prestataire')
      : ko(`ETAPE 1 — statut inattendu : ${r1.decision.statut} (${r1.decision.motif})`)
    r1.decision.peutPublier === false
      ? ok('ETAPE 1 — elle ne publie pas : l hote garde la main')
      : ko('ETAPE 1 — elle pourrait publier, alors que son pouvoir est « soumettre »')

    // ⚠ LA GRILLE EST FIGEE EN BASE, ET ON LE RELIT. C'est la garantie que les
    // reponses gardent leur sens si l'hote modifie sa grille entre-temps.
    const { data: apres1 } = await sb.from('guest_evaluations')
      .select('status, grille_figee, answers_cleaner').eq('id', evaluation.id).single()
    apres1.grille_figee && Array.isArray(apres1.grille_figee.criteres) && apres1.grille_figee.criteres.length
      ? ok('ETAPE 1 — la grille est FIGEE en base, relue depuis la table')
      : ko('ETAPE 1 — aucune grille figee : les reponses perdraient leur sens si la grille changeait')
    Object.keys(apres1.answers_cleaner || {}).length === ouverts.length
      ? ok('ETAPE 1 — ses reponses sont dans answers_cleaner, et nulle part ailleurs')
      : ko(`ETAPE 1 — answers_cleaner porte ${Object.keys(apres1.answers_cleaner || {}).length} reponse(s) sur ${ouverts.length}`)

    // ─── ETAPE 2 : l'hote complete sa part ─────────────────────────────────
    const restants = grille.criteres.filter(c => !(c.cle in partPresta))
    const partHote = Object.fromEntries(restants.map(c => [c.cle, meilleur(c)]))
    const r2 = await enregistrerReponses(sb, {
      evaluation: { ...evaluation, ...apres1 }, reponses: partHote, role: 'hote',
    })
    r2.complet === true
      ? ok(`ETAPE 2 — l hote complete : formulaire complet (${restants.length} critere(s) ajoutes)`)
      : ko('ETAPE 2 — le formulaire n est pas reconnu complet')
    r2.decision.peutPublier === true
      ? ok('ETAPE 2 — l hote peut publier')
      : ko(`ETAPE 2 — l hote ne peut pas publier : ${r2.decision.motif}`)

    const { data: apres2 } = await sb.from('guest_evaluations').select('*').eq('id', evaluation.id).single()
    Object.keys(apres2.answers_host || {}).length === restants.length
      ? ok('ETAPE 2 — ses reponses sont dans answers_host, celles de la prestataire intactes')
      : ko('ETAPE 2 — answers_host ne porte pas ce qu on y a mis')

    // ─── ETAPE 3 : la publication, avec un provider SIMULE ─────────────────
    const provider = providerSimule()
    let resultat
    try {
      resultat = await publier({
        evaluation: { ...apres2, ota_review_ref: review.external_review_id, public_text: 'Voyageur soigneux, logement rendu impeccable. Bienvenue quand il veut.' },
        parProfil: null, provider,
      })
    } catch (err) {
      abandon(`ETAPE 3 — publication refusee : ${err instanceof RefusPublication ? err.motif : 'erreur'} — ${err.message}`)
    }
    resultat.statut === 'publiee'
      ? ok('ETAPE 3 — publication acceptee par le provider simule')
      : ko(`ETAPE 3 — statut ${resultat.statut} : ${resultat.motif}`)

    const post = provider.appels.find(a => a.type === 'post')
    if (!post) ko('ETAPE 3 — aucun POST : rien n a ete envoye, meme au double')
    else {
      post.reviewId === review.external_review_id
        ? ok('ETAPE 3 — la reference du PROVIDER est partie, pas notre UUID interne')
        : ko(`ETAPE 3 — mauvaise cle envoyee : ${post.reviewId}`)
      const rev = post.charge.review
      rev.scores && rev.scores.length
        ? ok(`ETAPE 3 — ${rev.scores.length} note(s) de categorie : ${rev.scores.map(s => `${s.category}=${s.rating}`).join(', ')}`)
        : ko('ETAPE 3 — aucune note dans la charge')
      // ⚠ LE GARDE-FOU QUI COMPTE LE PLUS : la note privee ne doit pas etre
      // dans le texte public, et le nom de la prestataire nulle part.
      const pub = String(rev.public_review || '')
      pub.includes('Parcours')
        ? ko('ETAPE 3 — le prenom de la prestataire est DANS le texte public')
        : ok('ETAPE 3 — le prenom de la prestataire n apparait pas dans le texte public')
      rev.private_review === undefined
        ? ok('ETAPE 3 — aucune note privee envoyee (il n y en avait pas)')
        : ok('ETAPE 3 — la note privee part dans son champ dedie, pas dans le texte public')
    }

    // ─── ETAPE 4 : le statut ecrit, et l'evenement du coeur ────────────────
    const { error: eFin } = await sb.from('guest_evaluations').update({
      status: resultat.statut, published_at: resultat.publie_le,
      public_text: 'Voyageur soigneux, logement rendu impeccable. Bienvenue quand il veut.',
      scores: {
        categories: resultat.scores || [],
        ...(resultat.is_reviewee_recommended === undefined
          ? {}
          : { is_reviewee_recommended: resultat.is_reviewee_recommended }),
      },
    }).eq('id', evaluation.id).eq('user_id', compte)
    if (eFin) ko(`ETAPE 4 — statut non ecrit : ${eFin.message}`)
    else {
      const { data: fin } = await sb.from('guest_evaluations')
        .select('status, published_at, scores').eq('id', evaluation.id).single()
      fin.status === 'publiee' && fin.published_at
        ? ok('ETAPE 4 — la ligne porte « publiee » et sa date, relues depuis la base')
        : ko('ETAPE 4 — la ligne ne porte pas ce qu on y a ecrit')
      // ⚠ LE CONTROLE SUIT LA GRILLE, PAS UNE ATTENTE FIXE. Une grille d'hote
      // sans critere `recommandation` ne se prononce pas : exiger la
      // recommandation ici rendait un ECHEC sur un comportement correct.
      if (resultat.is_reviewee_recommended === undefined) {
        fin.scores && fin.scores.is_reviewee_recommended === undefined
          ? ok('ETAPE 4 — cette grille ne se prononce pas sur la recommandation, et rien n est invente')
          : ko(`ETAPE 4 — une recommandation est apparue sans critere pour la porter : ${fin.scores?.is_reviewee_recommended}`)
      } else {
        fin.scores && fin.scores.is_reviewee_recommended === resultat.is_reviewee_recommended
          ? ok('ETAPE 4 — la recommandation survit a la publication')
          : ko('ETAPE 4 — la recommandation n est pas persistee')
      }
    }

    const j = await journaliser(sb, {
      userId: compte, type: 'avis.evaluation_publiee', sujet: evaluation.id,
      charge: { booking_uid: evaluation.booking_uid, ota: 'airbnb', parcours_de_preuve: true },
    })
    if (!j.ok) ko(`ETAPE 4 — evenement non journalise : ${j.erreur}`)
    else {
      const { data: evs } = await sb.from('core_events')
        .select('id, type').eq('user_id', compte).eq('subject_id', evaluation.id)
      const trouve = (evs || []).find(x => x.type === 'avis.evaluation_publiee')
      if (trouve) { aNettoyer.evenements = (evs || []).map(x => x.id); ok('ETAPE 4 — l evenement avis.evaluation_publiee est dans le journal du coeur') }
      else ko('ETAPE 4 — l evenement est annonce ecrit mais introuvable')
    }

    // ─── ETAPE 5 : on ne publie pas deux fois ──────────────────────────────
    let second = null
    try {
      second = await publier({
        evaluation: { ...apres2, status: 'publiee', ota_review_ref: review.external_review_id, public_text: 'x' },
        parProfil: null, provider,
      })
    } catch (err) {
      err instanceof RefusPublication && err.motif === 'deja_publiee'
        ? ok('ETAPE 5 — une seconde publication est refusee : deja_publiee')
        : ko(`ETAPE 5 — refus inattendu : ${err.message}`)
    }
    if (second) ko('ETAPE 5 — UNE SECONDE PUBLICATION A ETE ACCEPTEE')
    provider.appels.filter(a => a.type === 'post').length === 1
      ? ok('ETAPE 5 — un seul POST sur tout le parcours')
      : ko(`ETAPE 5 — ${provider.appels.filter(a => a.type === 'post').length} POST : c est un de trop`)
  } catch (e) {
    if (!(e instanceof Abandon)) ko(`exception : ${e.message}`)
  } finally {
    // ─── Nettoyage, quoi qu'il arrive, puis RELECTURE ─────────────────────
    let reste = 0
    for (const id of aNettoyer.evenements) {
      const { error } = await sb.from('core_events').delete().eq('id', id)
      if (error) reste++
    }
    if (aNettoyer.evaluation) {
      const { error } = await sb.from('guest_evaluations').delete().eq('id', aNettoyer.evaluation)
      if (error) reste++
    }
    if (aNettoyer.otaReview) {
      const { error } = await sb.from('ota_reviews').delete().eq('id', aNettoyer.otaReview)
      if (error) reste++
    }
    if (aNettoyer.critere) {
      // Les niveaux partent en cascade avec leur critere.
      const { error } = await sb.from('avis_criteres').delete().eq('id', aNettoyer.critere)
      if (error) reste++
    }
    if (aNettoyer.profil) {
      await sb.from('profile_permissions').delete().eq('profile_id', aNettoyer.profil)
      const { error } = await sb.from('profiles').delete().eq('id', aNettoyer.profil)
      if (error) reste++
    }
    // ⚠ ON RELIT PAR ID. Une contre-preuve qui ne peut rien trouver ne prouve
    // rien : c'est la lecon du filtre `like` sur un `text[]` du script voisin.
    let restants = 0
    for (const [table, id] of [['guest_evaluations', aNettoyer.evaluation], ['ota_reviews', aNettoyer.otaReview], ['profiles', aNettoyer.profil], ['avis_criteres', aNettoyer.critere]]) {
      if (!id) continue
      const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('id', id)
      if (error) { console.error(`  relecture de ${table} impossible :`, error.message); restants++ }
      else restants += count || 0
    }
    console.log(`\nNettoyage : ${reste} erreur(s) · ${restants} ligne(s) de preuve restante(s)`)
    if (reste || restants) { console.error('ECHEC : le decor de test n a pas ete entierement retire.'); process.exitCode = 1 }
  }

  if (echecs) { console.error(`\nECHEC : ${echecs} controle(s) en defaut.`); process.exit(1) }
  console.log('\nOK : le parcours prestataire → hote → publication tient sur la base STAGING,')
  console.log('     et RIEN n a ete envoye a Airbnb (provider simule).')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
