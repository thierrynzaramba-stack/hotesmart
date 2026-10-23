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
const { UUID_RE } = require('../../lib/require-permission')
const { colonneAbsente } = require('../../lib/colonne-absente')
const {
  arriveesProches, verdictDuCode, codesParReservation, lireLesCodes
} = require('../../lib/ecran/etat-du-code')
const { etatMenage } = require('../../lib/cron-arrival-code')
const { notesDuPerimetre } = require('../../lib/stats-avis')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le jour de Paris, celui des biens.
//
// ⚠ ET LE DECALAGE EST CALENDAIRE, PAS 24 h — LE COMMENTAIRE LE DISAIT DEJA,
// LE CODE FAISAIT L'INVERSE, ET LA REVIEW L'A MESURE. `Date.now() + n * 86400000`
// glisse au changement d'heure : le 24 octobre 2026 a 22 h 30 UTC (Paris
// 25 octobre 00 h 30, le jour de 25 heures), `jourParis(0)` et `jourParis(1)`
// rendaient TOUS DEUX « 2026-10-25 ». La fenetre des arrivees devenait un seul
// jour, et aucune arrivee du 26 n'avait d'etat de code — donc aucune invite
// « Envoyer le code » pour le voyageur du lendemain. Au printemps, le miroir :
// le 27 mars 2027 a 22 h 30 UTC, `jourParis(1)` rendait le 29 et SAUTAIT le 28.
// On lit donc la date civile de Paris, puis on ajoute les jours a la DATE —
// `Date.UTC` gere le debordement de mois et d'annee. C'est la meme regle que
// `ajouterJours` de shared/aujourdhui.js, qui porte le meme avertissement.
// ⚠ Cette fonction se declenchait DEUX JOURS apres le commit du lot.
const jourParis = (decalage = 0) => {
  const [a, m, j] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })
    .format(new Date()).split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, j + decalage)).toISOString().slice(0, 10)
}

const TACHES_MAX = 200
// ⚠ LE PLAFOND DE POSTGREST EST 1000, ET IL NE S'ANNONCE PAS.
// J'avais ecrit `CONVERSATIONS_MAX = 5000` en pensant plafonner au-dessus du
// besoin. `db-max-rows` coupe a 1000 SANS erreur : la mesure du 23 octobre
// 2026 donne 1843 lignes reelles et `.limit(5000)` en rend 1000 — donc le
// drapeau `tronquees` (`length >= 5000`) ne pouvait JAMAIS se lever, et la
// liste etait deja tronquee ce jour-la, en silence. Consequence a l'ecran :
// une arrivee dont les messages tombaient hors des 1000 lus renvoyait vers la
// fiche du bien au lieu de sa conversation, differemment a chaque
// rechargement — exactement le « defaut muet » que le commentaire plus bas
// pretendait garder.
// On PAGINE donc, avec un ordre stable, et on s'arrete a un nombre de pages
// borne : au-dela on le DIT.
const PAGE_POSTGREST = 1000
const CONVERSATIONS_PAGES_MAX = 10
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
  // ⚠ ET LA FORME DE LA CLE SE TRIE PAR COLONNE — J'AVAIS ECRIT LE CONTRAIRE,
  // ET LA REVIEW L'A MESURE CONTRE LA PRODUCTION. `refsDuPerimetre` rend
  // l'UNION de `property_ids` (les UUID de `properties.id`) et de
  // `property_refs` (les cles provider des tables enfant). J'avais passe cette
  // union TELLE QUELLE aux deux familles de colonnes, en pensant qu'une forme
  // qui ne correspond pas « ne matche rien ». C'est faux : une colonne `uuid`
  // ne compare pas, elle REFUSE.
  //   mesure du 23 octobre 2026 : `.in('id', [uuid, '209413'])` sur
  //   `properties.id` rend `22P02 invalid input syntax for type uuid`, donc
  //   `indisponibles.push('biens'); return []` — un ecran VIDE presente comme
  //   un fait (« vous n'avez aucun logement ») a tout membre delegue.
  // Inerte aujourd'hui, parce que les cinq biens sont Channex et que leur cle
  // provider est elle-meme un UUID. Le dual-provider Beds24 est PERMANENT
  // (CLAUDE.md) et ses cles sont numeriques : le premier hote Beds24 avec un
  // membre delegue tombait dessus. Le depot avait deja ecrit ce piege trois
  // fois (api/channel-property.js « LE PIEGE UUID, POUR LA TROISIEME FOIS »,
  // lib/require-permission.js, api/calendar.js) et exporte `UUID_RE` pour lui.
  //
  // Colonnes mesurees le 23 octobre 2026 :
  //   `uuid`  -> properties.id, price_display_log.property_id
  //   `text`  -> agent_tasks, automation_incidents, messages, menages,
  //              bookings_snapshot (.property_id)
  //
  // ⚠ ET UNE LISTE VIDE APRES TRI RESTE UN FILTRE. `.in(col, [])` rend zero
  // ligne : le membre voit MOINS. Un `if (liste.length)` rendrait la requete
  // SANS filtre, donc tout le compte — le piege `[]` falsy-adjacent, en
  // deuxieme exemplaire.
  const refs = refsDuPerimetre(contexte)
  const perimetreVide = Array.isArray(refs) && refs.length === 0
  const refsUuid = refs === null ? null : refs.map(String).filter(r => UUID_RE.test(r))
  const refsTexte = refs === null ? null : refs.map(String)
  const bornerUuid = (q, colonne) =>
    (refsUuid === null ? q : q.in(colonne, refsUuid))
  const bornerRef = (q, colonne) =>
    (refsTexte === null ? q : q.in(colonne, refsTexte))

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
  // ⚠ C'EST UN PLANCHER, ET L'ANNONCER AINSI EST LE POINT. Deux appels ne se
  // comptent pas exactement : `etatMenage` vit dans un autre module avec son
  // propre client (4 lectures possibles, comptees ci-dessous), et
  // `notesDuPerimetre` pagine — une boucle de curseur compte pour 1 ici. Un
  // instrument pose pour « designer la CAUSE » qui se donnerait pour exact
  // serait pire que pas d'instrument.
  let requetes = 0
  const compter = async (p) => { requetes++; return p }
  // Mesure : `awk '/async function etatMenage/,/^}/' lib/cron-arrival-code.js`
  // compte 4 `.from(`. J'avais ecrit 2.
  const LECTURES_ETAT_MENAGE = 4

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
  //
  // ⚠ CHAQUE BLOC EST ENVELOPPE, ET TOUTE LA CONCEPTION EN DEPEND. Les dix
  // blocs sont rassembles par `Promise.all` : UNE seule exception emporte les
  // neuf autres, l'endpoint rejette sans corps, Vercel rend 500, et la page
  // degrade TOUT d'un coup — biens vides, taches indisponibles, et l'alarme de
  // surreservation qui disparait avec le reste. Les vingt lignes de conception
  // d'`indisponibles` — « un bloc absent n'est pas un bloc vide » — sont
  // annulees par une seule levee.
  // Neuf blocs n'inspectaient que le champ `error` de PostgREST, qui ne leve
  // pas. Le dixieme, `lireNotes`, appelle un module tiers qui leve PAR
  // CONCEPTION (`lib/stats-avis.js` : « `<option>` n'est pas honore »), et il
  // etait le seul appel etranger non garde du fichier — `etatMenage`, l'autre,
  // l'etait. L'asymetrie etait le signe.
  // Et l'enveloppe TRACE : `api/messages.js` ecrivait un `console.error` sur
  // l'echec de la lecture des codes, que cette extraction avait perdu. Une
  // lecture qui echoue en silence s'affiche « aucun » sans laisser de trace.
  const sur = (nom, fn, repli) => {
    try {
      return Promise.resolve(fn()).catch(e => {
        console.error('[ecran/aujourdhui]', nom, (e && e.message) || e)
        indisponibles.push(nom)
        return repli
      })
    } catch (e) {
      console.error('[ecran/aujourdhui]', nom, (e && e.message) || e)
      indisponibles.push(nom)
      return Promise.resolve(repli)
    }
  }

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
    // ⚠ `reservations`, PAS `reglages` — ET J'AVAIS PRIS LE DROIT DE LA TUILE.
    // L'ancienne page lisait les alarmes par `GET /api/incidents-acquitter`,
    // garde par `requirePermission({ domaine: 'reservations' })` avec sa raison
    // ecrite : « une surreservation est un conflit de reservations ». J'ai
    // recopie le droit du COMPTEUR de la tuile (`reglages`), qui n'est pas le
    // meme. Le droit bougeait dans les DEUX sens : un profil `proprietaire`
    // (`reservations: read`, `reglages: none`) perdait les alarmes des biens
    // qu'il gere, alors que la page lui montre toujours le bouton
    // d'acquittement ; et un membre `reglages: read` / `reservations: none`
    // recevait le detail de l'incident — nom du bien, nuits en conflit,
    // identifiants des reservations en cause — en contournant la RLS.
    if (!droits.reservations) return null
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
      // ⚠ `|| null`, COMME `api/messages.js:585` — ET J'AVAIS MIS `'confirmed'`.
      // `arriveesProches` filtre par `arr && st && !STATUTS_SANS_ARRIVEE.has(st)`
      // : un snapshot sans `status` est donc EXCLU chez l'autre appelant et
      // etait INCLUS ici. Les deux ecrans auraient dit le contraire l'un de
      // l'autre sur la meme reservation le meme jour — et la banniere du
      // module promet que le verdict ne bouge pas d'un iota. Une extraction qui
      // modifie la regle est pire que pas d'extraction.
      status: (r.snapshot || {}).status || null,
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
    const vus = new Set()
    for (let page = 0; page < CONVERSATIONS_PAGES_MAX; page++) {
      let q = supabase.from('messages').select('id, booking_id')
        .eq('user_id', compte).not('booking_id', 'is', null)
      q = bornerRef(q, 'property_id')
      // ⚠ UN ORDRE STABLE EST OBLIGATOIRE POUR PAGINER. Sans `.order`, deux
      // pages peuvent rendre la meme ligne et en sauter une autre.
      const { data, error } = await compter(
        q.order('id', { ascending: true })
          .range(page * PAGE_POSTGREST, page * PAGE_POSTGREST + PAGE_POSTGREST - 1))
      if (error) { indisponibles.push('conversations'); return null }
      for (const r of data || []) vus.add(String(r.booking_id))
      if ((data || []).length < PAGE_POSTGREST) return [...vus]
      if (page === CONVERSATIONS_PAGES_MAX - 1) tronquees.push('conversations')
    }
    return [...vus]
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
  const compterSi = async (autorise, table, ajuster, colonneBien, borner = bornerRef) => {
    if (!autorise) return null
    if (perimetreVide) return 0
    let q = supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_id', compte)
    q = ajuster(q)
    if (colonneBien) q = borner(q, colonneBien)
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
      // ⚠ PAR LE CODE 42703, PAS PAR LE MOT « origine » DANS LE MESSAGE.
      // Mon test `/origine/` classait « colonne absente, rien a signaler »
      // TOUTE erreur dont le message contient ces sept lettres — un timeout
      // qui cite la requete, par exemple. La tuile disparaissait alors sans
      // rien pousser dans `indisponibles` : exactement l'inverse de ce que la
      // dette 66 demande. `lib/colonne-absente.js` existe pour ca.
      if (!colonneAbsente(error)) indisponibles.push('messages_ia')
      return null
    }
    return count || 0
  }

  const tDebutLectures = Date.now()
  const [biens, taches, alarmes, arrivees, notes, conversations, nMenages, nPrix, nSurresa, nIa] =
    await Promise.all([
      sur('biens', lireBiens, []),
      sur('taches', lireTaches, null),
      sur('alarmes', lireAlarmes, null),
      sur('arrivees', lireArrivees, []),
      sur('notes', lireNotes, null),
      sur('conversations', lireConversations, null),
      sur('compteur:menages', () => compterSi(droits.menages, 'menages',
        q => q.gte('accepted_at', depuis7j).neq('status', 'cancelled'), 'property_id'), null),
      // `price_display_log` : RLS `user_id = auth.uid()`, lisible du seul
      // titulaire. Le service key contourne la RLS, donc le droit se verifie
      // ICI — c'est exactement la raison d'etre de `requirePermission`.
      // ⚠ `price_display_log.property_id` est une colonne `uuid` (mesure du
      // 23 octobre 2026), pas une cle provider : elle se borne en UUID. Le cas
      // est inerte — `droits.titulaire` implique `refs === null` — mais le
      // laisser faux serait poser une mine pour le jour ou ce compteur
      // deviendrait delegable.
      sur('compteur:price_display_log', () => compterSi(droits.titulaire, 'price_display_log',
        q => q.eq('source', 'engine').gte('created_at', depuis7j), 'property_id', bornerUuid), null),
      // Meme donnee, meme droit que la liste ci-dessus : la tuile comptait sur
      // `reglages` dans l'ancienne page, ce qui faisait deux droits pour une
      // table. On aligne sur l'endpoint qui l'ecrit.
      sur('compteur:automation_incidents', () => compterSi(droits.reservations, 'automation_incidents',
        q => q.eq('type', 'overbooking').gte('created_at', depuis7j), 'property_id'), null),
      sur('messages_ia', lireMessagesIa, null)
    ])

  // ─── L'etat du code d'acces, pour les arrivees proches ─────────────────────
  //
  // ⚠ LE VERDICT VIENT DE `lib/ecran/etat-du-code.js`, PARTAGE AVEC
  // `api/messages.js`. Le recopier aurait fait deux regles qui divergent au
  // premier correctif.
  let etatsArrivee = null
  try {
  if (droits.messages && arrivees.length) {
    const proches = arriveesProches(arrivees, (d) => jourParis(d))
    if (proches.length) {
      const { lignes, erreur } = await compter(lireLesCodes(supabase,
        proches.map(a => a.bookId), proches.map(a => a.propertyId)))
      if (erreur) indisponibles.push('etats_arrivee')
      const parResa = codesParReservation(lignes)
      // Les messages SORTANTS de ces seules reservations : la preuve de
      // transmission du code. Borne aux reservations en main, pas au compte.
      // ⚠ BORNEE AU BIEN, ET PAS SEULEMENT A LA RESERVATION — C'EST LE MEME
      // TROU QUE SA VOISINE `access_codes`, QUE J'AI FERME DIX LIGNES PLUS
      // HAUT SANS VOIR CELUI-CI. Un identifiant de reservation Beds24 est
      // numerique et n'est unique QUE par bien : reutilise sur un autre
      // logement du meme compte, il melangeait les messages sortants de cet
      // autre logement dans le sac de celui-ci. Si l'un d'eux contenait les
      // chiffres du code bornes par des non-chiffres (un prix, un autre code
      // de porte), `verdictDuCode` rendait « transmis » pour une arrivee dont
      // le code n'a jamais ete envoye : l'hote ne fait pas l'envoi manuel, et
      // le voyageur arrive devant une porte fermee.
      // Et pour un membre delegue, c'etait une lecture HORS PERIMETRE qui
      // nourrissait un verdict affiche.
      const { data: msgs, error: eMsg } = await compter(bornerRef(supabase.from('messages')
        .select('booking_id, property_id, direction, body, sent_at')
        .eq('user_id', compte)
        .in('booking_id', proches.map(a => a.bookId))
        .eq('direction', 'outbound'), 'property_id')
        .order('sent_at', { ascending: false })
        .limit(PAGE_POSTGREST))
      if (eMsg) indisponibles.push('etats_arrivee')
      // ⚠ LE SAC EST CLE SUR LE COUPLE `bien|reservation`, comme
      // `codesParReservation` l'est deja — et sur un objet SANS PROTOTYPE :
      // une reservation nommee `constructor` faisait lever `.push` sur la
      // methode heritee, donc un 500 pour tout l'ecran.
      const parBooking = Object.create(null)
      for (const m of msgs || []) {
        const k = `${String(m.property_id)}|${String(m.booking_id)}`
        ;(parBooking[k] = parBooking[k] || []).push(m)
      }
      etatsArrivee = Object.create(null)
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
            requetes += LECTURES_ETAT_MENAGE
            menage = await etatMenage(compte, a.propertyId,
              { arrival: a.firstNight, id: a.bookId }, a.provider || 'beds24')
          } catch { menage = 'inconnu' }
        }
        etatsArrivee[a.bookId] = { menage,
          codeEtat: verdictDuCode(ligne, parBooking[`${a.propertyId}|${a.bookId}`] || []) }
      }
    } else {
      etatsArrivee = Object.create(null)
    }
  }
  } catch (e) {
    // Meme regle que les dix blocs : un echec ici ne rend pas l'ecran entier.
    console.error('[ecran/aujourdhui]', 'etats_arrivee', (e && e.message) || e)
    indisponibles.push('etats_arrivee')
    etatsArrivee = null
  }
  const tFinLectures = Date.now()

  // ─── Server-Timing : la duree ET le nombre de requetes ─────────────────────
  //
  // ⚠ LE COMPTE, PAS SEULEMENT LA DUREE. C'est la lecon du lot de mesure du
  // cron : le temps designe une tache lente, le nombre de requetes designe la
  // CAUSE. Mesure du 23 octobre 2026 : aucun endpoint du produit ne rendait
  // d'en-tete `Server-Timing`.
  const total = Date.now() - t0
  // ⚠ `db;dur` ET `calc;dur`, EXIGES PAR LA SPEC §7.2, et je ne les avais pas
  // poses. C'est precisement la coupe qui attribue une reponse lente a la base
  // ou au JavaScript : sans elle, `total` seul ne designe rien.
  // `db;dur` est le temps de MUR de la phase de lecture (les dix blocs en
  // parallele, puis l'etat du code) — pas la somme des requetes, qui n'est pas
  // mesurable d'ici. `db;desc` reste un PLANCHER (voir `requetes`).
  const msDb = tFinLectures - tDebutLectures
  res.setHeader('Server-Timing',
    `db;dur=${msDb};desc="${requetes} req (plancher)", `
    + `calc;dur=${Math.max(0, total - msDb)}, total;dur=${total}`)

  return res.status(200).json({
    jour,
    biens,
    taches,
    alarmes,
    // ⚠ `arrivees` NE PART PLUS DANS LA REPONSE, ET C'ETAIT UNE FUITE DE
    // CONFORT. La page ne la lit nulle part (`grep -n 'ecran\.' pages/aujourdhui.html`
    // : alarmes, biens, fait_pour_vous, notes, taches — pas arrivees) : elle ne
    // servait qu'a calculer `etats_arrivee` ICI. Mais elle emportait le
    // `snapshot` INTEGRAL de 200 reservations — courriel, telephone, nom et
    // prenom du voyageur, montant, commission — vers le navigateur, et le
    // cache d'ecran les ecrivait sur le disque. On rend le COMPTE, qui est
    // tout ce qu'un ecran pourrait vouloir en dire.
    arrivees_nombre: Array.isArray(arrivees) ? arrivees.length : null,
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
