// api/ecran/aujourdhui.js
// L'ECRAN D'ACCUEIL EN UN APPEL — lot (b) du chantier performance.
// DOC : docs/specs/spec-performance-pages.md (modif = MEME COMMIT)
//
// ⚠ CE QUE CET ENDPOINT REMPLACE, MESURE LE 22 OCTOBRE 2026 CONTRE LA
// PRODUCTION, compte reel a 4 logements : l'ecran d'accueil coutait
// 13 appels HTTP, 100 requetes Supabase et 1 047 556 OCTETS. Dont :
//   · `/api/yield`, DEUX fois par bien : 72 requetes et 586 Ko ;
//   · `/api/messages` : 18 requetes et 437 Ko — 42 % du poids — POUR UN SEUL
//     CHAMP, l'etat du code d'acces d'une arrivee.
//
// ⚠ CE QU'IL NE FAIT PAS, ET POURQUOI.
// · IL N'APPELLE PAS `/api/messages`. La spec l'interdit explicitement au
//   lot (b) : un ecran qui appelle l'endpoint d'un AUTRE ecran paie son
//   assemblage entier. L'etat du code se lit ici, borne aux arrivees du jour et
//   du lendemain — deux reservations, pas tous les fils du compte.
// · IL NE TOUCHE PAS AU DOMAINE MENAGE (decision de Thierry du 23 octobre
//   2026). La fenetre de 400 jours vit dans `api/menages.js`, en 258 lignes
//   rendant sept champs : la dupliquer ferait deux lecteurs de la meme donnee —
//   le defaut le plus paye de ce depot — et l'extraire maintenant obligerait a
//   refaire ce travail au lot (d), quand `/api/menages` deviendra
//   `/api/ecran/menages`. `/api/menages` reste donc un second appel jusque-la.
// · IL NE CALCULE NI CA NI TO. Ils arrivent au lot (c), lus dans des tables de
//   resume. D'ici la, `/api/yield` reste appele par la page.
//   La trajectoire validee : 13 appels -> 3 ici, -> 2 au lot (c), -> 1 au
//   lot (d).
//
// ⚠ ET IL NE CALCULE RIEN DE NON URGENT. Regle d'architecture de CLAUDE.md :
// tout ce qu'il rend est TEMPS REEL — arrivees, departs, taches, alarmes,
// etat du code — sauf les notes, qui viennent de `lib/stats-avis.js` et
// passeront en table de resume au lot (c). Le test
// `tests/ecran-ne-calcule-pas.test.js` viendra avec elles.

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran } = require('../../lib/require-permission')
const { refsDuPerimetre, peutLire, estTitulaireDuCompte } = require('../../lib/permissions')
const {
  arriveesProches, verdictDuCode, codesParReservation, lireLesCodes
} = require('../../lib/ecran/etat-du-code')
const { etatMenage } = require('../../lib/cron-arrival-code')
const { notesDuPerimetre } = require('../../lib/stats-avis')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le jour de Paris, celui des biens — jamais un pas de 24 h (heure d'ete).
const jourParis = (decalage = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })
    .format(new Date(Date.now() + decalage * 86400000))

const TACHES_MAX = 200
// Les identifiants de fil : une seule colonne, donc on peut en lire beaucoup.
// 1 923 lignes `messages` en production le 23 octobre 2026.
const CONVERSATIONS_MAX = 5000
const JOURS_FAIT_POUR_VOUS = 7

module.exports = async (req, res) => {
  const t0 = Date.now()
  // Pose l'en-tete prive avant tout, y compris avant un refus de methode.
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { accountUserId: compte, contexte } = garde

  // ─── LE PERIMETRE, ET SES TROIS ETATS ──────────────────────────────────────
  //
  // ⚠ C'EST LE SEUL ENDROIT DE CE LOT OU UNE ERREUR D'UNE LIGNE EST UNE FUITE
  // INTER-COMPTES, et les dix fuites du chantier profils et droits sont nees de
  // cette famille. `refsDuPerimetre` rend TROIS choses :
  //   · `null`  -> aucun filtre (titulaire, ou `property_scope: 'all'`) ;
  //   · `[]`    -> perimetre VIDE : le membre ne voit RIEN ;
  //   · [refs]  -> la liste de ses biens.
  // Le piege est que `[]` est « falsy-adjacent » : un `if (refs) filtrer()`
  // laisserait un perimetre vide SANS filtre, donc TOUT le compte visible.
  // On teste donc `Array.isArray` et la longueur, explicitement, et le cas vide
  // rend un ecran vide — jamais un ecran complet.
  //
  // ⚠ ET ON LIT EN `.in(...)`, PAS EN `.or(...)`. `postgrest-js` parametre
  // `.in` : un tableau vide rend zero ligne, et une reference malformee ne
  // matche rien. `.or(expression)` INTERPOLE, et c'est pour lui qu'existe le
  // tamis `REF_SQL_SURE` de `filtrePerimetreSql` — dont la valeur `''` est
  // falsy et a deja piege ce depot. En n'utilisant que `.in`, ce lot se tient
  // hors de cette classe de defauts.
  //
  // ⚠ ET UNE SEULE LISTE BORNE LES DEUX FORMES DE CLE, PARCE QU'ELLE CONTIENT
  // LES DEUX. `refsDuPerimetre` rend l'UNION de `property_ids` (les UUID de
  // `properties.id`) et de `property_refs` (les cles provider, TEXT, des tables
  // enfant) — c'est la regle dure du depot : « properties.id = UUID ;
  // property_id des tables enfant = TEXT ». Un `.in` sur la mauvaise forme ne
  // matche rien : si un membre n'a que des UUID, il ne voit aucune ligne
  // enfant ; s'il n'a que des refs, aucun bien. Dans les deux cas il voit
  // MOINS, jamais plus — la seule direction acceptable.
  // Les deux fonctions ci-dessous sont donc volontairement identiques : elles
  // nomment la COLONNE visee, pour qu'on lise au point d'appel laquelle des
  // deux formes est attendue, et pour qu'un jour ou elles divergeraient, ce
  // soit un changement explicite et non un oubli.
  const refs = refsDuPerimetre(contexte)
  const perimetreVide = Array.isArray(refs) && refs.length === 0
  const bornerUuid = (q, colonne) =>
    (refs === null ? q : q.in(colonne, refs.map(String)))
  const bornerRef = (q, colonne) =>
    (refs === null ? q : q.in(colonne, refs.map(String)))

  const droits = {
    reservations: peutLire(contexte, 'reservations'),
    menages:      peutLire(contexte, 'menages'),
    messages:     peutLire(contexte, 'messages'),
    avis:         peutLire(contexte, 'avis'),
    reglages:     peutLire(contexte, 'reglages'),
    titulaire:    estTitulaireDuCompte(contexte)
  }

  // Chaque lecture s'annonce : le compte part dans `Server-Timing`, parce que
  // la duree seule ne dit pas d'ou elle vient (lecon du lot de mesure du cron).
  let requetes = 0
  const compter = async (p) => { requetes++; return p }

  const jour = jourParis(0)
  const demain = jourParis(1)
  const depuis7j = new Date(Date.now() - JOURS_FAIT_POUR_VOUS * 86400000).toISOString()

  // `indisponibles` : ce qu'on n'a PAS pu lire. Un bloc absent de la reponse
  // n'est pas un bloc vide — l'ecran doit pouvoir dire « indisponible » plutot
  // que d'afficher zero avec aplomb (regle de restitution du depot).
  const indisponibles = []
  // Les listes qui ont touche leur plafond : un ecran doit pouvoir dire « 200+ »
  // au lieu d'un nombre faux.
  const tronquees = []
  const refuses = Object.entries(droits).filter(([, v]) => !v).map(([k]) => k)

  // ─── Les blocs, EN PARALLELE ───────────────────────────────────────────────
  const vide = async () => null

  const lireBiens = async () => {
    if (!droits.reservations && !droits.menages) return []
    if (perimetreVide) return []
    let q = supabase.from('properties')
      .select('id, name, provider, provider_property_id, city, checkin_time, checkout_time, currency, photo_url')
      .eq('user_id', compte)
    q = bornerUuid(q, 'id')
    const { data, error } = await compter(q.order('name', { ascending: true }))
    if (error) { indisponibles.push('biens'); return [] }
    return data || []
  }

  const lireTaches = async () => {
    if (!droits.messages) return null
    if (perimetreVide) return []
    let q = supabase.from('agent_tasks')
      .select('id, book_id, property_id, guest_name, task_type, summary, suggested_reply, status, created_at')
      .eq('user_id', compte)
      .in('status', ['pending', 'pending_validation'])
    q = bornerRef(q, 'property_id')
    const { data, error } = await compter(q.order('created_at', { ascending: false }).limit(TACHES_MAX))
    if (error) { indisponibles.push('taches'); return null }
    // ⚠ UNE LISTE PLAFONNEE DOIT LE DIRE. Mesure du 23 octobre 2026 : le compte
    // de Thierry porte 222 taches ouvertes pour un plafond de 200 — la liste
    // est donc DEJA tronquee aujourd'hui, et la page (qui portait le meme
    // plafond) en tire son badge « a traiter ». Un compte faux affiche avec
    // aplomb est exactement la famille de defauts que ce depot a payee trois
    // fois. Le plafond reste — l'ecran n'affiche pas 222 cartes — mais il
    // s'annonce, et l'ecran pourra dire « 200+ » plutot qu'un nombre faux.
    if ((data || []).length >= TACHES_MAX) tronquees.push('taches')
    return data || []
  }

  const lireAlarmes = async () => {
    if (!droits.reglages) return null
    if (perimetreVide) return []
    // ⚠ `acquitted_at`, PAS `acquitte_le` — ET J'AVAIS ECRIT LE SECOND.
    // La colonne s'appelle `acquitted_at` (avec `acquitted_by`). J'ai ecrit un
    // nom francais par analogie avec le reste du depot, et la lecture echouait
    // EN ENTIER : le bloc des alarmes rendait `null` meme pour le titulaire.
    // Trouve par ma propre mesure sur les donnees reelles, pas par un test —
    // c'est la deuxieme fois de la journee que j'invente un nom au lieu de lire
    // le schema (la premiere : `STATUTS_SANS_ARRIVEE`).
    // ⚠ ET `tests/garde-colonne-selectionnee.test.js` NE L'AURAIT PAS VU : il
    // verifie qu'une colonne LUE est SELECTIONNEE, pas qu'elle EXISTE. Les deux
    // defauts se ressemblent et n'ont pas le meme filet.
    let q = supabase.from('automation_incidents')
      .select('id, type, property_id, detail, created_at, acquitted_at')
      .eq('user_id', compte).eq('type', 'overbooking').is('acquitted_at', null)
    q = bornerRef(q, 'property_id')
    const { data, error } = await compter(q.order('created_at', { ascending: false }).limit(50))
    if (error) { indisponibles.push('alarmes'); return null }
    return data || []
  }

  // Les arrivees du jour et du lendemain, et elles SEULES : c'est tout ce dont
  // l'etat du code a besoin. Deux jours, pas quatre cents.
  const lireArrivees = async () => {
    if (!droits.reservations && !droits.menages) return []
    if (perimetreVide) return []
    let q = supabase.from('bookings_snapshot')
      .select('booking_id, property_id, snapshot')
      .eq('user_id', compte)
      .gte('snapshot->>arrival', jour)
      .lte('snapshot->>arrival', demain)
    q = bornerRef(q, 'property_id')
    const { data, error } = await compter(q.limit(200))
    if (error) { indisponibles.push('arrivees'); return [] }
    return (data || []).map(r => ({
      bookId: String(r.booking_id),
      propertyId: String(r.property_id),
      firstNight: (r.snapshot || {}).arrival || null,
      status: (r.snapshot || {}).status || 'confirmed',
      provider: (r.snapshot || {}).provider || null,
      snapshot: r.snapshot || {}
    }))
  }

  // ⚠ LES RESERVATIONS QUI ONT UN FIL, ET POURQUOI C'EST UN BLOC A PART.
  // La page decide la cible du lien d'une ligne avec
  // `etat.conversations.has(e.bookingId)` : un fil existe -> on ouvre le fil,
  // sinon la fiche du bien. Et elle le fait pour TOUS les evenements de la
  // fenetre de 400 jours, pas pour les seules arrivees du jour. C'est de la
  // que venait l'appel a `/api/messages` : il rendait tous les fils.
  // On ne lit donc QUE les identifiants — une colonne, pas un assemblage —
  // et le poids s'effondre : la liste des `booking_id` distincts pese quelques
  // kilo-octets la ou l'assemblage des fils en pesait 437.
  // ⚠ ET LE PLAFOND SE DIT. Au-dela, la page afficherait « pas de fil » sur des
  // reservations qui en ont une, et l'hote cliquerait vers la fiche du bien au
  // lieu de la conversation — un defaut muet.
  const lireConversations = async () => {
    if (!droits.messages) return null
    if (perimetreVide) return []
    let q = supabase.from('messages').select('booking_id')
      .eq('user_id', compte).not('booking_id', 'is', null)
    q = bornerRef(q, 'property_id')
    const { data, error } = await compter(q.limit(CONVERSATIONS_MAX))
    if (error) { indisponibles.push('conversations'); return null }
    if ((data || []).length >= CONVERSATIONS_MAX) tronquees.push('conversations')
    return [...new Set((data || []).map(r => String(r.booking_id)))]
  }

  const lireNotes = async () => {
    if (!droits.avis) return null
    // ⚠ `refs: []` EST DEJA SUR ICI. `notesDuPerimetre` traite un perimetre
    // vide en zero, jamais en « tous » — et il le dit dans son propre code.
    const out = await compter(notesDuPerimetre(supabase, {
      userId: compte, periode: '30j', refs: refs === null ? null : refs.map(String)
    }))
    if (out && out.erreur) { indisponibles.push('notes'); return null }
    return out
  }

  // « Fait pour vous », 7 jours : des COMPTAGES, donc `head: true` — aucune
  // ligne ne traverse le reseau.
  const compterSi = async (autorise, table, ajuster, colonneBien) => {
    if (!autorise) return null
    if (perimetreVide) return 0
    let q = supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', compte)
    q = ajuster(q)
    if (colonneBien) q = bornerRef(q, colonneBien)
    const { count, error } = await compter(q)
    if (error) { indisponibles.push(`compteur:${table}`); return null }
    return count
  }

  // ⚠ LA TUILE « MESSAGES ECRITS PAR L'IA », ET JE L'AVAIS OUBLIEE.
  // Elle venait de `/api/messages?stats=ia`, un des cinq appels que cet
  // endpoint remplace — et je ne l'avais pas reportee. Un TEST EXISTANT l'a
  // trouve (`tests/aujourdhui.test.js`, « dette 66 : la tuile IA compte la
  // COLONNE seule, au serveur, jamais un faux zero ») : la tuile disparaissait
  // en silence, parce que `fait_pour_vous.messages_ia` valait `undefined` et
  // que la page filtre les compteurs nuls. Un bloc oublie dans un endpoint qui
  // en regroupe six ne se voit pas a la lecture du code.
  //
  // ⚠ ET LA DETTE 66 TIENT : `indisponible` N'EST PAS ZERO. La colonne
  // `origine` peut ne pas exister (migration non appliquee). Rendre 0 dirait
  // « l'IA n'a rien ecrit cette semaine », un FAIT. On rend `null`, et la page
  // masque la tuile — exactement ce que faisait l'ancien appel.
  const lireMessagesIa = async () => {
    if (!droits.messages) return null
    if (perimetreVide) return 0
    let q = supabase.from('messages').select('id', { count: 'exact', head: true })
      .eq('user_id', compte).eq('direction', 'outbound')
      .in('origine', ['ia_validee', 'ia_modifiee', 'ia_auto'])
      .gte('sent_at', depuis7j)
    q = bornerRef(q, 'property_id')
    const { count, error } = await compter(q)
    if (error) {
      // La colonne absente n'est pas une panne : la tuile se masque, sans bruit.
      if (!/origine/.test(error.message || '')) indisponibles.push('messages_ia')
      return null
    }
    return count || 0
  }

  const [biens, taches, alarmes, arrivees, notes, conversations, nMenages, nPrix, nSurresa, nIa] =
    await Promise.all([
      lireBiens(), lireTaches(), lireAlarmes(), lireArrivees(), lireNotes(), lireConversations(),
      compterSi(droits.menages, 'menages',
        q => q.gte('accepted_at', depuis7j).neq('status', 'cancelled'), 'property_id'),
      // `price_display_log` : RLS `user_id = auth.uid()`, lisible du seul
      // titulaire. Le service key contourne la RLS, donc le droit se verifie
      // ICI — c'est exactement la raison d'etre de `requirePermission`.
      compterSi(droits.titulaire, 'price_display_log',
        q => q.eq('source', 'engine').gte('created_at', depuis7j), 'property_id'),
      compterSi(droits.reglages, 'automation_incidents',
        q => q.eq('type', 'overbooking').gte('created_at', depuis7j), 'property_id'),
      lireMessagesIa()
    ])

  // ─── L'etat du code d'acces, pour les arrivees proches ─────────────────────
  //
  // ⚠ LE VERDICT VIENT DE `lib/ecran/etat-du-code.js`, PARTAGE AVEC
  // `api/messages.js`. Le recopier aurait fait deux regles qui divergent au
  // premier correctif.
  let etatsArrivee = null
  if (droits.messages && arrivees.length) {
    const proches = arriveesProches(arrivees, (d) => jourParis(d))
    if (proches.length) {
      const { lignes, erreur } = await compter(lireLesCodes(supabase,
        proches.map(a => a.bookId), proches.map(a => a.propertyId)))
      if (erreur) indisponibles.push('etats_arrivee')
      const parResa = codesParReservation(lignes)
      // Les messages SORTANTS de ces seules reservations : la preuve de
      // transmission du code. Borne aux reservations en main, pas au compte.
      const { data: msgs, error: eMsg } = await compter(supabase.from('messages')
        .select('booking_id, direction, body, sent_at')
        .eq('user_id', compte)
        .in('booking_id', proches.map(a => a.bookId))
        .eq('direction', 'outbound')
        .limit(500))
      if (eMsg) indisponibles.push('etats_arrivee')
      const parBooking = {}
      for (const m of msgs || []) {
        const k = String(m.booking_id)
        ;(parBooking[k] = parBooking[k] || []).push(m)
      }
      etatsArrivee = {}
      for (const a of proches) {
        const ligne = parResa[`${a.propertyId}|${a.bookId}`]
        let menage = 'inconnu'
        if (droits.menages) {
          try {
            // ⚠ SA SIGNATURE NE PREND PAS DE CLIENT : `etatMenage` utilise
            // celui de `lib/cron-shared`. J'avais ecrit `etatMenage(supabase,
            // …)` par analogie avec les autres lectures de ce fichier — le
            // premier argument serait devenu le `userId`, et la fonction
            // aurait cherche le suivi menage d'un compte nomme « [object
            // Object] ». Verifie dans la source, pas suppose.
            requetes += 2   // elle lit bookings_snapshot puis le suivi menage
            menage = await etatMenage(compte, a.propertyId,
              { arrival: a.firstNight, id: a.bookId }, a.provider || 'beds24')
          } catch { menage = 'inconnu' }
        }
        etatsArrivee[a.bookId] = { menage, codeEtat: verdictDuCode(ligne, parBooking[a.bookId] || []) }
      }
    } else {
      etatsArrivee = {}
    }
  }

  // ─── Server-Timing : la duree ET le nombre de requetes ─────────────────────
  //
  // ⚠ LE COMPTE, PAS SEULEMENT LA DUREE. C'est la lecon du lot de mesure du
  // cron : le temps designe une tache lente, le nombre de requetes designe la
  // CAUSE. Mesure du 23 octobre 2026 : aucun endpoint du produit ne rendait
  // d'en-tete `Server-Timing`.
  const total = Date.now() - t0
  res.setHeader('Server-Timing',
    `db;desc="${requetes} req", total;dur=${total}`)

  return res.status(200).json({
    jour,
    biens,
    taches,
    alarmes,
    arrivees,
    conversations,
    etats_arrivee: etatsArrivee,
    notes,
    fait_pour_vous: { messages_ia: nIa, menages: nMenages, prix: nPrix, surreservation: nSurresa, jours: JOURS_FAIT_POUR_VOUS },
    droits,
    refuses,
    indisponibles,
    tronquees,
    perimetre_vide: perimetreVide,
    // ⚠ L'HEURE DU CALCUL, exigee par la regle d'architecture. Ici tout est
    // temps reel, donc c'est l'instant de la lecture ; au lot (c), les blocs
    // resumes porteront la leur, qui sera plus ancienne.
    calcule_le: new Date().toISOString(),
    cout: { requetes, ms: total }
  })
}
