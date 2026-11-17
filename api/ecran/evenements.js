// api/ecran/evenements.js — L'APPEL D'ECRAN DE « CE QUI FAIT BOUGER VOS PRIX ».
// Lot 4 du chantier, sous-lot 4a, etape 1. Spec : docs/specs/spec-yf-ecran-evenements.md
// (§3 les donnees, §4 des dates aux positions, §8 la case performance).
//
// La page `/apps/yield/evenements` peint tout son premier affichage avec CET
// appel : la liste des logements, et pour le logement choisi, les evenements de
// douze mois (une occurrence chacun, avec la position de chacune de ses nuits),
// le niveau et le prix de chaque nuit, les reglages par position et la legende
// des niveaux. Mesure AVANT, en production le 9 novembre 2026, ancienne pop-up
// « Quand vos prix bougent » : 5 appels `/api` et 10 appels Supabase directs,
// 30 088 a 43 516 octets transferes, ecran complet en 2,5 a 2,7 s.
//
// ⚠ LECTURE SEULE DE TOUT CE QUI FAIT UN PRIX. Les gestes (poser un niveau, changer une largeur) restent
// sur `PUT` / `PATCH /api/yield-evenements`, avec leurs gardes d'ecriture et la
// confirmation par le nombre de nuits.
//
// ⚠ L'EN-TETE PRIVE AVANT TOUT REFUS, y compris celui de methode (dette 90) :
// c'est `contexteDEcran` qui le pose, en premier.
//
// ⚠ LE NIVEAU DE CHAQUE NUIT EST CALCULE A L'OUVERTURE (decision Q4 de Thierry,
// 9 novembre 2026), et MESURE : si l'ouverture depasse 1 s, il passe en resume
// quotidien. `calcule_a` dit l'heure du calcul — un chiffre sans son heure est
// un chiffre dont personne ne sait l'age.
//
// ⚠ UNE SEULE ECRITURE ICI, ET ELLE N'EST PAS UN REGLAGE (4b, spec §16.5) :
// `PUT` enregistre les COUCHES que la personne allume ou eteint (2025, 2024,
// 2023, puis les comparables). Decision S2 de Thierry, 11 novembre 2026 :
// « chacun le sien » — la ligne est cle (personne, compte, ecran), et le PUT
// n'ecrit QUE celle de l'appelant. Un membre en lecture seule l'ecrit aussi :
// c'est son affichage, pas un reglage du bien. Sur le meme endpoint plutot
// qu'une fonction Vercel de plus : tout l'ecran reste derriere un seul appel.

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran, UUID_RE } = require('../../lib/require-permission')
const { peutLire, peutEcrire } = require('../../lib/permissions')
const { compterRequetes, requetesJusquIci } = require('../../lib/compte-requetes')
const { sansArchives } = require('../../lib/biens-vivants')
const { assemblerEcranEvenements } = require('../../lib/yield/ecran-evenements')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ LE PLAFOND DE LA LISTE DES BIENS SE SIGNALE (meme discipline que la vue
// Annee) : on demande une ligne de plus que le plafond, et si elle revient, on
// le DIT au lieu de laisser croire que la liste est complete.
const BIENS_MAX = 500

// Le jour de PARIS, pas celui du process : la fonction tourne en UTC.
const jourDeParis = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())

const brut = v => (Array.isArray(v) ? v[0] : v)

// ─── LES COUCHES (4b) ───────────────────────────────────────────────────────
const ECRAN = 'evenements'
// ⚠ DES CLES RELATIVES (« l'an dernier », pas « 2025 ») : le choix tient d'une
// saison a l'autre. Et on garde ce qui est ETEINT : une couche nouvelle (les
// comparables, 4c) arrive allumee, comme la maquette le veut.
const COUCHES = ['n1', 'n2', 'n3', 'comparables']
const nettoyer = liste => COUCHES.filter(c => Array.isArray(liste) && liste.includes(c))

/**
 * Les couches eteintes par CETTE personne sur CE compte. ⚠ ILLISIBLE N'EST PAS
 * VIDE, MAIS L'ECRAN RESTE : tout est allume, et `lisibles: false` le dit.
 */
async function lireCouches (userId, compte) {
  const { data, error } = await supabase.from('preferences_ecran').select('valeur')
    .eq('user_id', userId).eq('compte_id', compte).eq('ecran', ECRAN).maybeSingle()
  if (error) {
    console.error('[ecran/evenements] couches :', error.message)
    return { eteintes: [], lisibles: false }
  }
  return { eteintes: nettoyer(data && data.valeur && data.valeur.eteintes), lisibles: true }
}

function lireCorps (req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body !== 'string' || !req.body) return null
  try { return JSON.parse(req.body) } catch { return null }
}

async function ecrireCouches (req, rendre, userId, compte) {
  const corps = lireCorps(req)
  const eteintes = corps && corps.couches ? corps.couches.eteintes : undefined
  // ⚠ UNE LISTE INCONNUE EST REFUSEE, PAS FILTREE : un nom de couche mal
  // ecrit serait sinon enregistre comme « tout allume » sans que rien ne le
  // dise.
  if (!Array.isArray(eteintes) || eteintes.length > COUCHES.length ||
      eteintes.some(c => !COUCHES.includes(c))) {
    return rendre(400, { error: 'couches_invalides' })
  }
  const valeur = { eteintes: nettoyer(eteintes) }
  // ⚠ LA LIGNE DE L'APPELANT, JAMAIS UNE AUTRE : `user_id` vient de la
  // session, `compte_id` de la garde — rien du corps ne les designe.
  const { error } = await supabase.from('preferences_ecran').upsert({
    user_id: userId, compte_id: compte, ecran: ECRAN, valeur, mis_a_jour_le: new Date().toISOString()
  }, { onConflict: 'user_id,compte_id,ecran' })
  if (error) {
    console.error('[ecran/evenements] couches, ecriture :', error.message)
    return rendre(503, { error: 'ecriture_impossible' })
  }
  return rendre(200, { couches: { eteintes: valeur.eteintes, lisibles: true } })
}

async function traiter (req, res, t0) {
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { accountUserId: compte, userId, contexte } = garde
  const rendre = (code, corps) => {
    // ⚠ LE COMPTE PART DU DEBUT DE LA REQUETE, garde comprise : c'est ce que
    // l'ecran paie, pas seulement ses lectures metier.
    res.setHeader('Server-Timing', `total;dur=${Date.now() - t0};desc="${requetesJusquIci()} requêtes"`)
    return res.status(code).json(corps)
  }

  // ⚠ LE MEME DROIT QUE `GET /api/yield-evenements` : la LECTURE des
  // reservations (un niveau « Haut » en plein mai doit pouvoir s'expliquer a
  // qui regarde), l'ECRITURE des reglages pour les gestes. Refus AVANT toute
  // lecture. Les couches suivent le meme droit : elles n'ont de sens que pour
  // qui voit l'ecran.
  if (!peutLire(contexte, 'reservations')) {
    return rendre(403, { error: 'Droit « réservations » requis' })
  }
  if (req.method === 'PUT') return ecrireCouches(req, rendre, userId, compte)
  const demande = brut(req.query && req.query.bien)
  if (demande != null && demande !== '' && !UUID_RE.test(String(demande))) {
    return rendre(400, { error: 'bien_invalide' })
  }

  // ─── LES LOGEMENTS DU SELECTEUR ──────────────────────────────────────────
  // ⚠ UN BIEN ARCHIVE N'Y PARAIT PAS (`sansArchives`, demande de Thierry du
  // 3 novembre 2026), et le PERIMETRE d'un membre se juge par la regle des
  // droits elle-meme (`peutLire` avec le bien), pas par un filtre recopie :
  // deux copies d'une regle de droits divergent, c'est ainsi que dix fuites
  // sont nees (docs/kb/profils-et-droits.md).
  const { data: lus, error: eBiens } = await sansArchives(
    supabase.from('properties').select('id, name, provider_property_id').eq('user_id', compte)
  ).order('name').limit(BIENS_MAX + 1)
  if (eBiens) {
    console.error('[ecran/evenements] properties :', eBiens.message)
    return rendre(503, { error: 'lecture_impossible' })
  }
  const tronquee = (lus || []).length > BIENS_MAX
  const visibles = (lus || []).slice(0, BIENS_MAX)
    .filter(b => peutLire(contexte, 'reservations', { id: b.id, ref: b.provider_property_id }))
  const biens = visibles.map(b => ({ id: b.id, nom: b.name }))
  const aujourdhui = jourDeParis()
  const entete = { aujourdhui, biens, ...(tronquee ? { biens_tronques: true } : {}) }

  if (!visibles.length) return rendre(200, { ...entete, bien: null })
  // ⚠ UN BIEN DEMANDE HORS DE LA LISTE N'EST PAS SERVI : ni archive, ni d'un
  // autre compte, ni hors du perimetre. On ne dit pas lequel des trois.
  // ⚠ EN MINUSCULES : `UUID_RE` accepte les majuscules, la base rend des
  // minuscules — sans cela, un identifiant valide recevait 404 (review).
  // ⚠ PAR DEFAUT, LE PREMIER BIEN RACCORDE : un bien sans canal n'a rien a
  // calculer, et la page s'ouvrirait sur un motif plutot que sur un ecran.
  const choisi = demande
    ? visibles.find(b => b.id === String(demande).toLowerCase())
    : (visibles.find(b => b.provider_property_id) || visibles[0])
  if (!choisi) return rendre(404, { error: 'bien_introuvable' })

  // ⚠ LA FICHE COMPLETE, PAS CELLE DE LA LISTE — le defaut du 11 septembre :
  // sans `zone_scolaire`, toutes les vacances partent en « autre zone ».
  // Les couches se lisent EN MEME TEMPS : une requete de plus, pas un
  // aller-retour de plus.
  const [{ data: bien, error: eBien }, couches] = await Promise.all([
    supabase.from('properties').select('*').eq('id', choisi.id).maybeSingle(),
    lireCouches(userId, compte)
  ])
  if (eBien) {
    console.error('[ecran/evenements] fiche du bien :', eBien.message)
    return rendre(503, { error: 'lecture_impossible' })
  }
  if (!bien) return rendre(404, { error: 'bien_introuvable' })
  const droitsEcriture = peutEcrire(contexte, 'reglages', { id: bien.id, ref: bien.provider_property_id })
  const sansCalcul = motif => rendre(200, { ...entete, bien: bien.id, droits_ecriture: droitsEcriture, couches, indisponible: motif })
  // ⚠ LA COLONNE ABSENTE SE DIT, elle ne se subit pas.
  if (!Object.prototype.hasOwnProperty.call(bien, 'zone_scolaire')) {
    console.error('[ecran/evenements] colonne zone_scolaire absente')
    return sansCalcul('configuration_incomplete')
  }
  // Les nuits vendues se lisent par la cle du canal : sans elle, pas de calcul.
  if (!bien.provider_property_id) return sansCalcul('bien_non_raccorde')

  let ecran
  try {
    ecran = await assemblerEcranEvenements(supabase, bien, compte, { aujourdHui: aujourdhui })
  } catch (e) {
    // ⚠ LE SELECTEUR SURVIT A UN CALCUL EN PANNE : l'hote peut changer de
    // logement, et la page dit pourquoi celui-ci ne s'affiche pas.
    console.error('[ecran/evenements] calcul :', e && e.message)
    return sansCalcul('calcul_impossible')
  }
  return rendre(200, {
    ...entete,
    bien: bien.id,
    droits_ecriture: droitsEcriture,
    calcule_a: new Date().toISOString(),
    couches,
    ...ecran
  })
}

module.exports = async (req, res) => {
  const t0 = Date.now()
  try {
    await compterRequetes(() => traiter(req, res, t0))
  } catch (e) {
    console.error('[ecran/evenements] lecture echec :', e && e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'Lecture impossible' })
  }
}
