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
const { readStatus } = require('../../lib/bookings-snapshot-status')
const {
  arriveesProches, verdictDuCode, codesParReservation, lireLesCodes
} = require('../../lib/ecran/etat-du-code')
const { etatMenage } = require('../../lib/cron-arrival-code')
const { notesDuPerimetre, derniersAvis } = require('../../lib/stats-avis')
// ⚠ TROIS MODULES, AUCUN CALCUL ICI. Le bloc « Revenus nets » compose des
// regles qui vivent toutes dans `lib/` : le net hote par canal, la date de
// versement par canal, et l'agregation par mois. Recopier l'une des trois ici
// ferait deux implementations qui divergent au premier correctif — la dette 17
// que le depot a deja soldee une fois.
// ⚠ LES TROIS IMPORTS DE CALCUL SONT PARTIS, ET C'EST LA MESURE DU CHANGEMENT.
// Cet endpoint composait `revenusDuMois`, `fenetreDeLecture` et
// `tableDesDelais` sur 1 436 payloads a chaque ouverture de l'accueil. Il ne
// calcule plus rien : deux appels d'agregat SQL, et la mise en forme de ce
// qu'ils rendent. C'est la regle d'architecture de CLAUDE.md prise au mot — un
// endpoint d'ecran ne lit que des donnees preparees.
//
// `lib/revenus/mois.js` reste au depot : il devient l'ORACLE du SQL. C'est lui
// que `scripts/verifier-parite-revenus.js` fait tourner sur les donnees reelles
// pour prouver que l'agregat dit la meme chose — un calcul remplace par un
// autre doit pouvoir etre compare, sinon la migration des chiffres se fait sur
// parole.

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
// Deux jours d'arrivees : 200 est large, mais un plafond se DIT.
const ARRIVEES_MAX = 200
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
  // ⚠ UNE BORNE QUI SE VIDE APRES TRI N'EST PAS UN PERIMETRE VIDE, ET ELLE
  // DOIT SE DIRE. Si le perimetre ne porte que des cles provider — possible,
  // `property_refs` et `property_ids` sont deux colonnes distinctes et c'est un
  // TRIGGER qui les garde d'accord —, `refsUuid` vaut `[]` alors que
  // `perimetreVide` est faux. `.in('id', [])` rend alors zero ligne SANS
  // erreur : l'ecran disait « vous n'avez aucun logement » comme un fait,
  // pendant que tous les blocs a cle TEXTE etaient correctement remplis.
  // Avant ce lot, le meme cas rendait un 22P02 — bruyant, mais au moins pousse
  // dans `indisponibles`. Echanger une panne visible contre un faux fait
  // silencieux serait une regression, pas un correctif.
  const uuidIntrouvable = Array.isArray(refsUuid) && refsUuid.length === 0 && !perimetreVide
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
  // ⚠ C'EST UN MAJORANT, PAS UN PLANCHER, ET L'ANNONCER « plancher » ETAIT
  // FAUX DANS L'AUTRE SENS. `awk '/async function etatMenage/,/^}/'` compte 4
  // `.from(` — j'avais d'abord ecrit 2 —, mais la fonction a trois sorties
  // anticipees : elle en fait souvent moins. Le compte annonce est donc un
  // ORDRE DE GRANDEUR, et le mot le dit.
  const LECTURES_ETAT_MENAGE = 4

  const jour = jourParis(0)
  const demain = jourParis(1)

  // ⚠ LE MOIS DEMANDE SE VALIDE, IL NE SE PREND PAS TEL QUEL. Le selecteur de
  // l'ecran envoie `?mois=YYYY-MM` ; par defaut, le mois courant A PARIS — le
  // meme fuseau que `jour`, et pas celui du serveur. Une valeur hors forme
  // retombe sur le mois courant plutot que de refuser l'ecran entier : le bloc
  // Revenus n'est pas la page.
  //
  // ⚠ ET LA VALIDATION REFUSE « 2026-13 », QUI PASSE LA FORME. `^\d{4}-\d{2}$`
  // l'accepte, et `Date.UTC(2026, 12, 1)` ROULE sur janvier 2027 : l'ecran
  // aurait servi les revenus de janvier sous l'etiquette « mois 13 ». Meme
  // garde que `fenetreDeLecture` et `moisDe` dans lib/revenus/mois.js — les
  // trois doivent s'accorder sur ce qu'est un mois.
  const moisDemande = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query && req.query.mois || ''))
    ? String(req.query.mois)
    : jour.slice(0, 7)
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
    if (!droits.reservations && !droits.menages) return null
    if (perimetreVide) return []
    if (uuidIntrouvable) {
      console.error('[ecran/aujourdhui]', 'perimetre sans cle UUID', { refs: refsTexte })
      indisponibles.push('biens')
      return null
    }
    let q = supabase.from('properties')
      .select('id, name, provider, provider_property_id, city, checkin_time, checkout_time, currency, photo_url')
      .eq('user_id', compte)
    q = bornerUuid(q, 'id')
    const { data, error } = await compter(q.order('name', { ascending: true }))
    // ⚠ `null`, PAS `[]`. Une liste vide dit « cet hote n'a aucun logement »,
    // un FAIT ; l'ecran masquait alors la section des biens, les notes et les
    // indicateurs sans explication, en laissant « + Ajouter un bien ». C'est
    // exactement le defaut que le commentaire du perimetre, vingt lignes plus
    // haut, condamne.
    if (error) { console.error('[ecran/aujourdhui]', 'biens', error.message); indisponibles.push('biens'); return null }
    return data || []
  }

  const lireTaches = async () => {
    if (!droits.messages) return null
    if (perimetreVide) return []
    // ⚠ `arrival` ET `departure` SONT DANS LE SELECT, ET ELLES MANQUAIENT.
    // `shared/aujourdhui.js` (`tachesOuvertes`) porte un REPLI documente :
    // quand les sejours ne sont pas lus, il garde une tache par
    // `t.departure >= aujourd'hui`. Sans la colonne, ce repli valait
    // TOUJOURS faux. Les deux cas qu'il couvre laissent justement
    // `etat.bookings` vide : un profil `messages: read` / `menages: none`, et
    // tout hote dont `/api/menages` echoue. Dans les deux, « A valider »
    // affichait « aucune tache » — un FAIT — sur un compte qui en porte 222.
    let q = supabase.from('agent_tasks')
      .select('id, book_id, property_id, guest_name, task_type, summary, '
        + 'suggested_reply, status, created_at, arrival, departure')
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
    // ⚠ TROIS TYPES, PLUS UN SEUL — ET C'EST UN CONSTAT DE THIERRY DU
    // 29 OCTOBRE 2026 : « une alerte sans geste possible ne sert a rien ».
    // Le bandeau ne montrait que `overbooking`. Les alertes d'envoi au voyageur
    // etaient donc ecrites en base, envoyees par e-mail au fondateur... et
    // INVISIBLES sur tous les ecrans — donc impossibles a acquitter, puisque le
    // bouton n'existe que sur une alarme affichee. Une alerte que personne ne
    // peut voir ni fermer n'est pas une alerte, c'est une ligne de journal.
    //   · `message_ota_a_verifier` : un envoi dont l'issue est INCERTAINE. Il ne
    //     repartira pas seul, et l'hote doit aller voir le fil chez l'OTA.
    //   · `message_ota_abandon`    : un message qui NE PARTIRA PAS. S'il le veut,
    //     c'est a lui de l'envoyer depuis /messages.
    // Les deux portent dans leur `detail` le voyageur, le texte et les trois pas
    // a suivre — le bandeau affiche ce `detail` tel quel.
    // ⚠ LE MEME ENSEMBLE QUE `api/incidents-acquitter.js`, A LA LETTRE : une
    // alarme affichee mais non acquittable laisse un bouton qui rend 404 et une
    // alarme a l'ecran pour toujours (constat HAUT d'une revue independante).
    const TYPES_ALARME = ['overbooking', 'message_ota_a_verifier',
      'message_ota_abandon', 'message_ota_arret']
    let q = supabase.from('automation_incidents')
      .select('id, type, property_id, detail, created_at, acquitted_at')
      .eq('user_id', compte).in('type', TYPES_ALARME).is('acquitted_at', null)
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
    const { data, error } = await compter(q.limit(ARRIVEES_MAX))
    if (error) { indisponibles.push('arrivees'); return [] }
    // Un plafond qui ne s'annonce pas est un compte faux : au-dela, des
    // arrivees du jour n'auraient pas d'etat de code, sans que rien ne le dise.
    if ((data || []).length >= ARRIVEES_MAX) tronquees.push('arrivees')
    return (data || []).map(r => ({
      bookId: String(r.booking_id),
      propertyId: String(r.property_id),
      firstNight: (r.snapshot || {}).arrival || null,
      // ⚠ PAR LE LECTEUR CANONIQUE, ET C'EST LA TROISIEME VALEUR QUE J'ECRIS ICI.
      // J'avais mis `|| 'confirmed'`, la premiere review a demande `|| null`
      // pour s'aligner sur `api/messages.js`, et la seconde a montre que les
      // DEUX etaient faux — pour des raisons opposees :
      //   · `null` fait sortir la reservation du filtre `arr && st && …` de
      //     `arriveesProches`. Or `lib/bookings-snapshot-status.js` dit
      //     explicitement « valeur vide/absente -> confirmed (comportement
      //     historique des 5 writers) », et `api/menages.js` filtre par
      //     `isActiveStatus`, donc cette reservation EST affichee comme arrivee
      //     du jour. Elle l'aurait ete sans etat de code et sans invite
      //     « Envoyer le code » : le voyageur arrive, l'hote ne voit rien.
      //   · `'confirmed'` en dur recopiait la regle au lieu de l'appeler, donc
      //     divergeait au premier correctif — et ne traduisait pas le
      //     vocabulaire BRUT des providers (`inquiry`, `black` sont des mots
      //     Beds24) que `canonicalStatus` sait mapper.
      // `readStatus` est la primitive, et elle tolere les lignes ecrites AVANT
      // ce module — c'est ce qui evite un backfill. `api/messages.js` l'utilise
      // aussi, donc les deux appelants de `arriveesProches` partagent enfin la
      // meme regle, ce que l'extraction promettait.
      status: readStatus(r.snapshot || {}, (r.snapshot || {}).provider),
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
    // ⚠ PAR CURSEUR, PAS PAR DECALAGE — ET J'AVAIS ECRIT `.range()`.
    // `messages.id` est un `gen_random_uuid()` : l'ordre est stable mais
    // ARBITRAIRE, et `.range` se traduit en `offset`. Un message entrant insere
    // entre deux pages prend une cle aleatoire qui peut tomber DANS la page
    // deja lue : toutes les lignes suivantes glissent d'un rang, et celle qui
    // etait a l'index 1000 n'est jamais rendue. Son `booking_id` manque alors
    // de `conversations`, donc la page envoie cette arrivee vers la fiche du
    // bien au lieu de sa conversation — differemment a chaque rechargement.
    // C'est le « defaut muet » que ce lot pretendait fermer, re-introduit par
    // son propre correctif. Un curseur (`.gt('id', dernier)`) ne peut pas
    // sauter une ligne qui existait au depart.
    // Le depot porte deja ce motif : `lirePagine` de `lib/logement/lecture.js`.
    const vus = new Set()
    let dernier = null
    for (let page = 0; page < CONVERSATIONS_PAGES_MAX; page++) {
      let q = supabase.from('messages').select('id, booking_id')
        .eq('user_id', compte).not('booking_id', 'is', null)
      q = bornerRef(q, 'property_id')
      if (dernier) q = q.gt('id', dernier)
      const { data, error } = await compter(
        q.order('id', { ascending: true }).limit(PAGE_POSTGREST))
      if (error) { indisponibles.push('conversations'); return null }
      const lot = data || []
      for (const r of lot) vus.add(String(r.booking_id))
      // ⚠ LE PLAFOND DU SERVEUR PEUT ETRE PLUS BAS QUE LE NOTRE. `db-max-rows`
      // est un reglage : si on en recoit MOINS que demande, c'est peut-etre la
      // fin, peut-etre le plafond. On ne conclut « fin » que sur un lot VIDE ou
      // strictement plus petit que ce que le serveur nous a deja rendu.
      if (!lot.length) return [...vus]
      dernier = String(lot[lot.length - 1].id)
      if (lot.length < PAGE_POSTGREST) return [...vus]
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

  // ⚠ LES TROIS DERNIERS COMMENTAIRES — bloc « Derniers avis » (spec §3).
  // Meme population et meme perimetre que `lireNotes` : la moyenne affichee en
  // tete du bloc et les cartes en dessous doivent parler des MEMES avis.
  //
  // ⚠ LE NOM DU VOYAGEUR EXIGE `reservations` EN PLUS D'`avis`, et la colonne
  // n'est pas selectionnee sans ce droit. C'est la regle deja tranchee pour les
  // dates de sejour (api/avis.js) : le CONTENU de l'avis suit `avis`, ce qu'il
  // dit du SEJOUR suit `reservations`. Un membre `avis: read` voit donc les
  // commentaires, sans savoir qui les a ecrits.
  const lireDerniersAvis = async () => {
    if (!droits.avis) return null
    // ⚠ UNE REQUETE, ET ELLE SE COMPTE. `derniersAvis` fait UNE lecture bornee
    // a trois lignes — pas de pagination, contrairement a `notesDuPerimetre`.
    // Le compteur de l'en-tete `Server-Timing` est un PLANCHER : l'y oublier le
    // rendrait faux de un, et c'est ce chiffre qui designe la cause quand une
    // reponse traine.
    requetes++
    const out = await derniersAvis(supabase, {
      userId: compte, periode: '30j', limite: 3,
      refs: refs === null ? null : refs.map(String),
      avecNom: droits.reservations
    })
    if (out && out.erreur) { indisponibles.push('derniers_avis'); return null }
    return out
  }

  // ─── Les revenus du MOIS, par bien (spec §4, etape 4) ─────────────────────
  //
  // ⚠ DROIT `reservations`, DECISION Q5 DE THIERRY du 24 octobre 2026 : « comme
  // aujourd'hui, lecture des reservations, limite aux biens du profil ». Le
  // montant d'un sejour EST une donnee de reservation ; un membre qui n'a pas ce
  // droit ne voit pas le bloc, et la garde est ICI parce que la cle de service
  // contourne la RLS.
  //
  // ⚠ DONNEE NON URGENTE, ET ELLE N'EST PLUS CALCULEE A LA LECTURE. Tout ce
  // paragraphe disait le contraire jusqu'au 26 octobre 2026, et c'est la review
  // du lot qui l'a releve : il decrivait l'implementation d'AVANT — « dette
  // assumee », « aucune table de resume n'existe », « avec `raw`, 3,8 Mo et
  // 569-961 ms », « TROIS appels PostgREST ». Plus un seul de ces faits n'etait
  // vrai apres le commit qui les laissait en place, et c'est le premier texte
  // qu'un lecteur rencontre. Le depot a paye six fois cette erreur les 23-24
  // octobre : une affirmation ecrite a la main est lue comme une mesure, et
  // elle ne rougit jamais.
  //
  // L'etat reel : le payload provider n'est lu qu'UNE FOIS, a l'ECRITURE de la
  // reservation (`lib/revenus/derive.js`, appele par le writer unique), qui pose
  // colonnes derivees. Cet endpoint ne fait plus que LIRE trois agregats
  // SQL — aucun `raw`, aucun `delais_versement`, aucune pagination.
  //
  // C'est l'architecture decidee par Thierry le 27 octobre 2026, et elle est la
  // forme generale de la regle de CLAUDE.md : une page non urgente lit des
  // donnees preparees a l'ecriture ou par le serveur, jamais un calcul sur les
  // donnees brutes a l'ouverture.
  const lireRevenus = async () => {
    // ⚠ GARDE SERVEUR DU DROIT, ET ELLE PRECEDE TOUTE LECTURE. Decision Q5 de
    // Thierry : « comme aujourd'hui, lecture des reservations, limite aux biens
    // du profil ». Le masquage de l'ecran est un confort ; celui-ci protege.
    // Le payload part dans le `localStorage` du membre pour 12 h.
    if (!droits.reservations) return null
    if (perimetreVide) return null
    // ⚠ UN PERIMETRE SANS CLE UUID NE REND PAS ZERO EURO, IL REND « JE NE SAIS
    // PAS » (constat de la review du lot). `uuidIntrouvable` est le cas d'un
    // membre dont la delegation n'est exprimee qu'en cles provider : `refsUuid`
    // vaut `[]` alors que le perimetre n'est pas vide. `lireBiens` le consulte
    // deja et pousse `indisponibles` ; ce bloc ne le faisait pas, donc il
    // passait `p_refs: []` — et `property_uuid = any('{}')` est FAUX POUR TOUT
    // LE MONDE. Zero ligne, total a zero, `revenus` absent de `indisponibles`,
    // et cet objet partait dans le `localStorage` du membre pour 12 h comme un
    // resultat valide.
    //
    // L'ecran etait sauve par coincidence : `lireBiens` rendant `null`, la
    // section se masquait. La coherence tenait a un AUTRE bloc — et le payload,
    // lui, affirmait « 0 € » la ou la bonne reponse est « non calculable ».
    if (uuidIntrouvable) {
      console.error('[ecran/aujourdhui]', 'revenus : perimetre sans cle UUID', { refs: refsTexte })
      indisponibles.push('revenus')
      return null
    }

    // ─── DEUX AGREGATS SQL, ET PLUS AUCUNE LECTURE DU PAYLOAD ─────────────
    //
    // ⚠ C'EST LE CŒUR DE L'ARCHITECTURE DECIDEE PAR THIERRY LE 27 OCTOBRE 2026.
    // Ce bloc lisait `bookings_snapshot.raw` — le payload provider INTEGRAL —
    // a chaque ouverture de l'accueil, pour en deduire le canal, le montant net
    // et la date de versement. Mesure du depot pour cette lecture exacte :
    // 3,8 Mo et 569-961 ms (docs/kb/performance.md), sur le chemin critique du
    // premier rendu. Et elle grossissait avec l'historique.
    //
    // Le payload n'est plus lu qu'UNE FOIS, a l'ECRITURE de la reservation
    // (`lib/revenus/derive.js`, appele par le writer unique). Ici, deux appels
    // qui rendent une ligne par logement : mesure sur staging, 0,1 Ko contre
    // 40,6 Ko pour la lecture qu'ils remplacent.
    //
    // ⚠ ET CE N'EST PAS UNE SOMME STOCKEE. Les totaux sont CALCULES, par un
    // agregat sur un index partiel — pas par du JavaScript sur 1 436 payloads.
    // Une somme maintenue a la main derive au premier correctif, et personne ne
    // le voit.

    // ⚠ LE JOUR DE REFERENCE EST CELUI DE PARIS, PASSE EN PARAMETRE. « Recu »
    // se compare a ce jour, et `current_date` cote Postgres est en UTC : une
    // comparaison faite en base se decalerait d'un jour chaque soir entre
    // minuit et 2 heures. Le depot a deja paye ce decalage.
    //
    // ⚠ ET LE PERIMETRE EST PASSE EN UUID. `refsUuid` est la liste des biens
    // confies a un membre delegue ; `null` veut dire titulaire, donc tout le
    // compte. C'est la fonction SQL qui applique la borne, et elle traite
    // `null` comme « aucune borne » — pas comme « aucun bien ».
    // ⚠ LES TROIS APPELS PARTENT ENSEMBLE. Sequentiels, ils coutaient trois
    // allers-retours sur le chemin critique du premier rendu ; en parallele, la
    // latence est celle du plus lent. C'est le seul endroit de ce bloc ou la
    // forme du code change le temps d'affichage.
    requetes += 3
    const [
      { data: parBien, error: eMois },
      { data: hors, error: eHors },
      { data: sonde, error: eSonde }
    ] = await Promise.all([
      supabase.rpc('revenus_du_mois', {
        p_user_id: compte,
        p_mois: moisDemande,
        p_aujourdhui: jour,
        p_refs: refsUuid === null ? null : refsUuid
      }),
      // ⚠ LE MOIS EST PASSE AUX RESERVES AUSSI, et il ne l'etait pas (constat
      // GRAVE 3 de la review du lot). La fonction n'avait AUCUNE borne de
      // mois : elle sommait les sejours orphelins de TOUTES les periodes, et
      // l'ecran affichait ce total sous un bandeau strictement mensuel. Mesure
      // du scenario : 4 sejours orphelins, un verse en novembre (500 €) et
      // trois en 2025 (2 500 €) — l'hote lisait un ecart de 500 € et, juste en
      // dessous, « 4 sejours rattaches a aucun de vos logements : 3 000,00 € ».
      // Le chiffre de la reserve additionnait de l'argent qui n'est PAS dans le
      // total qu'elle pretend expliquer.
      supabase.rpc('revenus_hors_mois', {
        p_user_id: compte,
        p_mois: moisDemande,
        p_refs: refsUuid === null ? null : refsUuid
      }),
      supabase.rpc('revenus_calcul_incomplet', {
        p_user_id: compte,
        p_refs: refsUuid === null ? null : refsUuid
      })
    ])

    // ⚠ UNE FONCTION QUI N'EXISTE PAS ENCORE EST UNE ATTENTE, PAS UNE PANNE.
    // Une migration se colle A LA MAIN dans ce depot : entre le push et le go
    // de Thierry, la base n'a ni les colonnes ni les agregats. L'ecran dit
    // alors « non calculable », ce qui est vrai — et ne crie pas au loup.
    //
    // ⚠ MAIS LA DETECTION AVALAIT UNE ERREUR DE DROITS, et c'est un constat de
    // la review du lot. Elle testait `texte.includes('revenus_du_mois')`, qui
    // attrape TOUT message nommant la fonction — donc aussi
    // « 42501 permission denied for function revenus_du_mois ». Un `grant`
    // oublie, ou des privileges non reportes par `create or replace`, auraient
    // vide le bloc pour TOUS les hotes sans une ligne dans les journaux. Le
    // code PostgREST `PGRST202` suffit a couvrir le cas « migration en
    // attente » ; on garde `does not exist` pour un appel direct hors
    // PostgREST, et c'est tout.
    const estAbsente = (e) => {
      const texte = `${(e && e.code) || ''} ${(e && e.message) || ''}`.toLowerCase()
      return texte.includes('pgrst202') ||
        (texte.includes('function') && texte.includes('does not exist'))
    }

    if (eMois) {
      if (!estAbsente(eMois)) {
        console.error('[ecran/aujourdhui] revenus_du_mois echec:', eMois.message)
      }
      indisponibles.push('revenus')
      return null
    }

    // ⚠⚠ LA SONDE DECIDE SI LE CHIFFRE A LE DROIT D'ETRE AFFICHE, et c'est le
    // constat GRAVE 1 de la review du lot. Les deux agregats filtrent sur
    // `statut_canonique = 'confirmed'` — une colonne NEUVE, qui vaut NULL tant
    // que le remplissage n'a pas passe. `NULL = 'confirmed'` rend NULL, donc
    // TOUTES les lignes sortent des deux agregats, et l'ecran affichait
    // « 0,00 € · Recu 0,00 € · A venir 0,00 € » AVEC L'APLOMB D'UN FAIT : pas
    // de reserve, pas de « non calculable », un mois vendu indistinguable d'un
    // mois vide. Et pire en remplissage PARTIEL — un total plausible mais
    // ampute, le script ayant une limite et le cron un plafond de 2 000 lignes.
    //
    // ⚠ SON ABSENCE REFUSE AUSSI, et ce n'est pas un exces de prudence : si la
    // migration de la sonde n'est pas collee, on ne peut PAS savoir si le
    // calcul est fini. Afficher le total serait reprendre exactement le pari
    // qu'on vient de perdre. L'ecran dit « non calculable », et l'ordre de
    // collage est donc contraint : la sonde AVANT que cet endpoint ne serve.
    if (eSonde) {
      if (!estAbsente(eSonde)) {
        console.error('[ecran/aujourdhui] revenus_calcul_incomplet echec:', eSonde.message)
      }
      indisponibles.push('revenus')
      return null
    }
    // ⚠ UNE REPONSE SANS ERREUR MAIS SANS DONNEE REFUSE AUSSI (constat de la
    // review). La doctrine du lot — « seul un `false` explicite autorise » —
    // etait appliquee a la sonde mais pas a la FORME des agregats : un `data`
    // nul sans `error` donnait un total a zero presente comme un fait. Peu
    // atteignable via PostgREST, mais c'est exactement l'asymetrie qu'on vient
    // de payer deux fois dans ce lot.
    if (!Array.isArray(parBien)) {
      console.error('[ecran/aujourdhui] revenus_du_mois : reponse sans donnee')
      indisponibles.push('revenus')
      return null
    }
    const ligneSonde = Array.isArray(sonde) ? sonde[0] : sonde
    if (!ligneSonde || ligneSonde.incomplet !== false) {
      // ⚠ `!== false` ET NON `=== true`. Une reponse vide, un champ absent ou
      // un `null` doivent refuser : la seule valeur qui autorise l'affichage
      // est un `false` explicite. L'inverse — autoriser sauf si `true` — fait
      // d'une reponse malformee un feu vert.
      indisponibles.push('revenus_calcul_en_cours')
      return null
    }

    // ⚠⚠ UN ECHEC DES RESERVES REFUSE LE BLOC ENTIER, et mon commentaire
    // precedent affirmait le contraire — « l'ecran affiche des totaux justes et
    // DIT qu'il ne sait pas compter ce qui en sort ». IL NE LE DISAIT PAS.
    // Constat BLOQUANT de la review du 26 octobre 2026 : `revenus_reserves`
    // n'etait lu par PERSONNE — une seule occurrence dans tout le depot, la
    // ligne qui l'ecrivait. Ni la page, ni un test.
    //
    // Consequence mesuree au banc DOM : les trois compteurs tombaient a zero,
    // les trois `if (… > 0)` de la page ne poussaient rien, et
    // `revenue-reserves` restait masque. Le bandeau affichait son total, aucune
    // ligne ne portait l'argent orphelin, et aucune reserve ne l'expliquait :
    // c'est mot pour mot G2 + G3, les deux constats que ce lot declare
    // refermes.
    //
    // ⚠ ET L'ORDRE DE COLLAGE QUE J'AVAIS ANNONCE CREAIT LA FENETRE : entre la
    // migration de la sonde et celle de `revenus_hors_mois`, la sonde repond et
    // les reserves rendent PGRST202. L'ordre est inverse dans les deux
    // en-tetes ; ce refus est la seconde ligne, pour le jour ou un `grant` sera
    // oublie apres le `drop`.
    //
    // Un total qu'on ne peut pas EXPLIQUER ne s'affiche pas. C'est plus strict
    // que mon intention d'origine, et c'est la seule version qui tient la
    // promesse du lot.
    if (eHors) {
      if (!estAbsente(eHors)) {
        console.error('[ecran/aujourdhui] revenus_hors_mois echec:', eHors.message)
      }
      indisponibles.push('revenus')
      return null
    }

    // ─── La mise en forme, et elle ne CALCULE rien ────────────────────────
    //
    // ⚠ UN GARDE-FOU DE CONVERSION, ET SON MOTIF ETAIT FAUX. J'avais ecrit
    // « LES SOMMES VIENNENT DE POSTGRES, EN `bigint`, DONC EN CHAINES » :
    // mesure sur staging, la reponse reelle est `{"sejours":2,"recu_cents":0}`
    // — des NOMBRES JSON. PostgREST sait rendre un `bigint` en nombre quand il
    // tient dans un double, et nos centimes y tiennent largement.
    //
    // Le garde-fou reste, parce qu'il protege de deux choses REELLES : un
    // `bigint` au-dela de 2^53 que PostgREST serialiserait alors en chaine, et
    // un `null` rendu par un agregat vide. Un `+` sur deux chaines les
    // CONCATENE — « 40000 » + « 30000 » donnerait « 4000030000 » — et
    // `Number(null)` vaut 0, pas NaN.
    //
    // Ce qui change : ce n'est plus « les sommes SONT des chaines », c'est
    // « elles peuvent l'etre, et on ne veut pas le savoir ici ».
    const n = (v) => {
      const x = Number(v)
      return Number.isFinite(x) ? x : 0
    }
    const vide = () => ({
      sejours: 0, recu_cents: 0, a_venir_cents: 0, total_cents: 0,
      bruts: 0, refuses: { montant: 0, date: 0 }, motifs: {}
    })
    const total = vide()
    const lignes = {}
    for (const r of parBien || []) {
      const l = {
        sejours: n(r.sejours),
        recu_cents: n(r.recu_cents),
        a_venir_cents: n(r.a_venir_cents),
        total_cents: n(r.total_cents),
        bruts: n(r.bruts),
        // ⚠ LE MOTIF N'EST PLUS DETAILLE PAR BIEN, et c'est assume : l'agregat
        // compte les refus, il ne les nomme pas. Le motif precis vit dans
        // `bookings_snapshot.motif_non_calculable`, ligne par ligne, pour qui
        // diagnostique. L'ecran, lui, a besoin du COMPTE — « 2 sans montant » —
        // et c'est ce que la ligne porte.
        refuses: { montant: n(r.sans_montant), date: 0 },
        motifs: {}
      }
      // ⚠ LA CLE EST L'UUID DU BIEN, PLUS LA CLE PROVIDER. C'est tout l'objet de
      // la colonne `property_uuid` : joindre par l'IDENTITE du bien et non par
      // le numero du provider, qu'un re-keying ou une bascule laisse derriere.
      // L'ecran joint donc desormais par `b.id`.
      lignes[String(r.property_uuid == null ? '' : r.property_uuid)] = l
      for (const c of ['sejours', 'recu_cents', 'a_venir_cents', 'total_cents', 'bruts']) {
        total[c] += l[c]
      }
      total.refuses.montant += l.refuses.montant
    }

    const h = (hors || [])[0] || {}
    return {
      mois: moisDemande,
      calcule_le: jour,
      par_bien: lignes,
      total,
      // Les sejours sans date de versement : tous mois confondus, par
      // construction — sans date, il n'y a pas de mois a leur attribuer.
      hors_mois: { ...vide(), sejours: n(h.sans_date), refuses: { montant: 0, date: n(h.sans_date) } },
      // ⚠ ET L'ARGENT RATTACHE A AUCUN BIEN CONNU, qui valait 1 000 EUR d'ecart
      // MUET entre le bandeau et les lignes avant d'avoir un compteur. Un
      // membre delegue n'en voit rien : la fonction SQL rend zero des que
      // `p_refs` est pose, parce que ces reservations ne lui sont pas
      // attribuables — elles ne sont rattachees a aucun bien.
      hors_biens: { ...vide(), sejours: n(h.hors_biens), total_cents: n(h.hors_biens_cents) },
      // ⚠ PLUS DE TRONCATURE POSSIBLE : l'agregat ne pagine pas, il groupe. Le
      // champ reste a `false` pour que l'ecran n'ait pas a distinguer deux
      // formes de reponse — et le jour ou un plafond revient, il aura sa place.
      tronque: false,
      source: 'agregat_sql'
    }
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
    // ⚠ `?? null`, PAS `|| 0` : un `count` absent est un INCONNU. Rendre 0
    // afficherait « l'IA n'a rien ecrit cette semaine », un fait — le faux zero
    // que la dette 66 interdit, a un caractere pres de son voisin `compterSi`.
    return count ?? null
  }

  const tDebutLectures = Date.now()
  // ⚠ LA PROMESSE DES BIENS EST CAPTUREE, PAS ATTENDUE, et c'est ce qui permet
  // a `lireRevenus` d'en dependre SANS serialiser les deux lectures. Il a
  // besoin des cles provider pour compter l'argent qui n'atterrira sur aucune
  // ligne — mais seulement A LA FIN, pour la comparaison : les deux requetes
  // qui coutent (les delais, puis les sejours) ne dependent pas des biens et
  // partent en parallele.
  //
  // ⚠ ET C'EST UN DEFAUT QUE J'AI INTRODUIT PUIS RATTRAPE DANS LA MEME HEURE :
  // ma premiere version lisait la variable `biens` depuis la closure, alors
  // qu'elle n'est affectee qu'APRES le `Promise.all` — elle valait donc
  // `undefined` a l'execution, `refsDesBiens` tombait a `null`, et le compteur
  // `hors_biens` restait muet. Le correctif d'un constat grave aurait ete
  // inerte, et aucun test ne l'aurait dit : `null` veut dire « je ne sais pas »,
  // donc le module ne compte rien et ne se plaint pas.
  const pBiens = sur('biens', lireBiens, null)
  const [biens, taches, alarmes, arrivees, notes, derniers, revenus, conversations, nMenages, nPrix, nSurresa, nIa] =
    await Promise.all([
      pBiens,
      sur('taches', lireTaches, null),
      sur('alarmes', lireAlarmes, null),
      sur('arrivees', lireArrivees, []),
      sur('notes', lireNotes, null),
      sur('derniers_avis', lireDerniersAvis, null),
      sur('revenus', lireRevenus, null),
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
  const assemblerEtatsDuCode = async () => {
  if (droits.messages && arrivees.length) {
    // ⚠ ON PASSE LES JOURS DEJA CALCULES, ON NE RELIT PAS L'HORLOGE.
    // `(d) => jourParis(d)` reconstruisait la date APRES la phase de lecture :
    // une requete commencee a 23 h 59 min 59 s interrogeait `bookings_snapshot`
    // pour [J, J+1] puis filtrait ses lignes sur [J+1, J+2]. Les lignes de J+1
    // survivaient, celles de J+2 n'avaient jamais ete lues, et la reponse
    // annoncait `jour: J`. Le meme decalage d'un jour que le correctif de
    // `jourParis` venait de fermer, laisse ouvert a l'interieur du correctif.
    const proches = arriveesProches(arrivees, (d) => (d === 0 ? jour : demain))
    if (proches.length) {
      const { lignes, erreur } = await compter(lireLesCodes(supabase,
        proches.map(a => a.bookId), proches.map(a => a.propertyId)))
      // ⚠ UNE LECTURE EN ECHEC N'AUTORISE PAS UN VERDICT. `indisponibles` etait
      // bien pousse, et le code CONTINUAIT : `codesParReservation([])` rend
      // `{}`, donc `verdictDuCode(undefined, …)` rend « aucun » — un verdict
      // DEFINITIF — pour CHAQUE arrivee du jour. La page ne traduit que « cree »
      // en invite « Envoyer le code » : la pastille et l'invite disparaissaient
      // en silence alors qu'un code existe. On s'arrete, et l'ecran dit qu'il
      // ne sait pas.
      if (erreur) {
        console.error('[ecran/aujourdhui]', 'access_codes', erreur)
        indisponibles.push('etats_arrivee')
        etatsArrivee = null
        return
      }
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
      // Meme regle : sans les messages sortants, « transmis » est indecidable,
      // et rendre « cree » ferait renvoyer un code deja envoye.
      if (eMsg) {
        console.error('[ecran/aujourdhui]', 'messages (preuve de transmission)', eMsg.message)
        indisponibles.push('etats_arrivee')
        etatsArrivee = null
        return
      }
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
  }
  try {
    await assemblerEtatsDuCode()
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
  // ⚠ LA PHASE DE LECTURE COMMENCE A LA GARDE, PAS APRES ELLE. `contexteDEcran`
  // fait un a trois allers-retours reseau — dont `chargerProfil` pour un membre
  // delegue — et ils tombaient dans `calc;dur` : la requete la plus lente du
  // produit, celle d'un membre delegue, se lisait « JavaScript lent ».
  const msDb = tFinLectures - t0
  res.setHeader('Server-Timing',
    `db;dur=${msDb};desc="${requetes} req (ordre de grandeur)", `
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
    derniers_avis: derniers,
    // ⚠ LE MOIS SERVI EST RENVOYE, et ce n'est pas une redondance : l'ecran a
    // demande un mois, il doit pouvoir verifier lequel il a REELLEMENT recu.
    // Une valeur hors forme retombe sur le mois courant — sans ce champ,
    // l'ecran afficherait « novembre » sur les chiffres d'octobre.
    mois: moisDemande,
    revenus,
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
