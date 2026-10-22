// lib/metriques-cron.js
// ═══════════════════════════════════════════════════════════════════════════
// LE COMPTEUR DU CYCLE — duree, requetes Supabase, appels externes et travail
// fait, PAR TACHE et PAR PASSAGE.
//
// ⚠ OBSERVATION SEULE. Aucune decision du cycle ne lit ce module : il mesure,
// il n'arbitre pas. Un compteur qui change le comportement qu'il mesure ne
// mesure plus rien, et c'est tout l'interet du lot : le decoupage du cron sera
// decide sur des chiffres, pas sur des intuitions.
//
// ⚠ LE COMPTEUR EST POSE SUR LE CLIENT, PAS A LA MAIN DANS CHAQUE MODULE
// (demande de Thierry du 22 octobre 2026). Un compteur recopie dans trente
// modules est faux des le trente-et-unieme : le module neuf ne compte pas, et
// son absence du classement se lit « il ne coute rien ». On intercepte donc
// `fetch`, par lequel passent TOUTES les requetes Supabase (mesure faite :
// `@supabase/postgrest-js` resout `fetch` au moment de la requete, donc meme
// les clients construits avant la pose sont comptes) et tous les appels aux
// partenaires.
//
// ⚠ UNE EXCEPTION, ET ELLE EST MESUREE : LE SDK ANTHROPIC. Il capture `fetch`
// A LA CONSTRUCTION du client — mesure du 22 octobre 2026 : un compteur pose
// apres `new Anthropic(...)` voit ZERO appel. Les appels Haiku sont donc
// comptes a l'enveloppe du journal IA (`lib/ia/journal.js`, `surAppel`), et
// l'hote `anthropic.com` est VOLONTAIREMENT ignore par l'interception pour
// qu'un futur client construit apres la pose ne soit pas compte deux fois.
//
// ⚠ L'ATTRIBUTION VA A LA TACHE LA PLUS INTERIEURE. `api/cron.js` emboite les
// mesures (un bien dans un compte). Une requete faite dans `snapshots[209413]`
// est comptee LA, et pas aussi dans `user_abc` : sinon le total du passage
// vaudrait le double et le classement serait faux. La DUREE, elle, ne peut pas
// se desemboiter — une etape parente dure forcement le temps de ses enfants —
// donc chaque tache porte les deux : `ms` (horloge, enfants compris) et
// `ms_seul` (sans ses enfants). Le classement trie sur `ms_seul`, le seul dont
// la somme vaut le passage.
// ═══════════════════════════════════════════════════════════════════════════

// Plafond du detail d'un passage : au-dela, les taches les moins couteuses
// sont agregees en une ligne. Un cycle a 4 biens en pose ~25 ; le plafond
// existe pour le jour ou le parc en compte 200 — une colonne JSON de 2 Mo par
// passage couterait plus cher que ce qu'elle mesure.
// ⚠ PLAFOND RELEVE DE 40 A 80 APRES COMPTAGE REEL (constat de review).
// `api/cron.js` pose 27 taches de premier niveau, plus `(hors tache)`, plus
// par compte Beds24 trois etapes et QUATRE sous-taches nommees par bien : un
// seul compte a trois biens fait deja 43 taches. Le plafond mordait donc des
// aujourd'hui, et le commentaire qui disait « pour le jour ou le parc en
// compte 200 » etait faux. A 80, une ligne pese ~12 Ko au pire et la table est
// purgee a 30 jours.
const TACHES_MAX = 80
const HORS_TACHE = '(hors tache)'
const AUTRES_TACHES = '(autres taches)'

// Le passage en cours. `null` = on ne compte RIEN : le module est charge par
// des endpoints qui n'ont pas de passage, et une instance Vercel tiede garde
// ses modules entre deux invocations.
let passage = null
let hoteSupabase = null

// ─── Classement d'une URL ───────────────────────────────────────────────────
// Rend { genre, cible } : 'supabase' (une requete), 'externe' (un appel
// partenaire, nomme), ou 'ignore'.
function classer (cible) {
  let url = ''
  if (typeof cible === 'string') url = cible
  else if (cible && typeof cible.url === 'string') url = cible.url
  else if (cible) url = String(cible)
  let hote = ''
  try { hote = new URL(url).host.toLowerCase() } catch { hote = '' }
  if (!hote) return { genre: 'externe', cible: 'url-illisible' }

  if (hoteSupabase === null) {
    try { hoteSupabase = new URL(process.env.SUPABASE_URL || '').host.toLowerCase() } catch { hoteSupabase = '' }
  }
  if (hoteSupabase && hote === hoteSupabase) return { genre: 'supabase', cible: 'supabase' }
  // Un projet Supabase autre que celui configure reste une requete Supabase :
  // c'est le cas d'un script pointe sur staging, et le compter ailleurs ferait
  // disparaitre la moitie du cout.
  if (/\.supabase\.(co|in)$/.test(hote)) return { genre: 'supabase', cible: 'supabase' }

  if (/(^|\.)channex\.io$/.test(hote)) return { genre: 'externe', cible: 'channex' }
  if (/(^|\.)beds24\.com$/.test(hote)) return { genre: 'externe', cible: 'beds24' }
  if (/(^|\.)getseam\.com$/.test(hote)) return { genre: 'externe', cible: 'seam' }
  if (/(^|\.)(brevo|sendinblue)\.com$/.test(hote)) return { genre: 'externe', cible: 'brevo' }
  if (/(^|\.)stripe\.com$/.test(hote)) return { genre: 'externe', cible: 'stripe' }
  // ⚠ Compte a l'enveloppe IA, jamais ici : voir l'en-tete.
  if (/(^|\.)anthropic\.com$/.test(hote)) return { genre: 'ignore', cible: 'haiku' }
  // Le reste garde son hote : c'est ainsi qu'on a su qu'AirROI et l'API
  // adresse etaient dans le cycle.
  return { genre: 'externe', cible: hote }
}

// ─── Interception de `fetch` ────────────────────────────────────────────────
// ⚠ ELLE NE DOIT JAMAIS CASSER UN APPEL. Le comptage est sous `try`, et la
// valeur rendue est CELLE du vrai `fetch`, sans enveloppe `async` : une
// promesse reemballee change les temps mesures ailleurs et masque un rejet
// synchrone.
// ⚠ ET ELLE SE REPOSE SI QUELQU'UN A REMPLACE `fetch` ENTRE-TEMPS (une suite
// de tests le fait tout le temps). Le marqueur evite d'empiler deux enveloppes
// sur une instance tiede, ce qui compterait double.
// ⚠ ON REMONTE LA CHAINE, PAS SEULEMENT LE DESSUS (constat de review). Le
// marqueur lu sur le seul `globalThis.fetch` ne voit pas une enveloppe posee
// PAR-DESSUS la notre : on en reposerait une seconde, et chaque requete
// compterait DEUX fois, en silence, pour toute la vie de l'instance. Si notre
// compteur est quelque part dans la chaine, les requetes l'atteignent encore —
// il n'y a rien a reposer.
// ⚠ LIMITE ASSUMEE : une enveloppe tierce qui ne garderait pas `__hs_vrai`
// coupe la remontee, et le cas redeviendrait indetectable. Aucun module du
// depot ne le fait, et les tests restaurent `fetch` par leur propre reference.
function dejaPose (f) {
  for (let n = 0; typeof f === 'function' && n < 20; n++) {
    if (f.__hs_compteur) return true
    f = f.__hs_vrai
  }
  return false
}

function poserLeCompteur () {
  if (typeof globalThis.fetch !== 'function') return false
  if (dejaPose(globalThis.fetch)) return true
  const vrai = globalThis.fetch
  const compteur = function (...args) {
    try { noter(classer(args[0])) } catch { /* un compteur ne casse pas un appel */ }
    return vrai.apply(this, args)
  }
  compteur.__hs_compteur = true
  compteur.__hs_vrai = vrai
  globalThis.fetch = compteur
  return true
}

function retirerLeCompteur () {
  if (typeof globalThis.fetch === 'function' && globalThis.fetch.__hs_compteur) {
    globalThis.fetch = globalThis.fetch.__hs_vrai
  }
}

function noter ({ genre, cible }) {
  if (!passage || genre === 'ignore') return
  const seau = passage.seauCourant()
  if (genre === 'supabase') seau.req++
  else seau.ext[cible] = (seau.ext[cible] || 0) + 1
}

// Appele par l'enveloppe du journal IA pour chaque appel au modele — le seul
// chemin que l'interception de `fetch` ne voit pas. Sans passage : no-op.
function compterAppelExterne (cible, combien = 1) {
  if (!passage || !cible) return
  const seau = passage.seauCourant()
  seau.ext[cible] = (seau.ext[cible] || 0) + combien
}

// ─── Instantane des compteurs de `results` ──────────────────────────────────
// Le TRAVAIL FAIT se lit sur l'objet que le cycle remplit deja (`results` :
// totalMessages, totalPrixChanges, …). On n'ajoute donc AUCUN compteur dans
// les modules : on photographie avant et apres chaque tache, et la difference
// est ce que la tache a fait. Les tableaux comptent par leur longueur
// (`errors`), le reste par sa valeur numerique.
function instantane (objet) {
  const vu = {}
  if (!objet || typeof objet !== 'object') return vu
  for (const [k, v] of Object.entries(objet)) {
    if (typeof v === 'number' && Number.isFinite(v)) vu[k] = v
    else if (Array.isArray(v)) vu[k] = v.length
  }
  return vu
}

function difference (avant, apres) {
  const d = {}
  for (const [k, v] of Object.entries(apres)) {
    const ecart = v - (avant[k] || 0)
    if (ecart) d[k] = ecart
  }
  return d
}

function cumuler (cible, ajout) {
  for (const [k, v] of Object.entries(ajout || {})) cible[k] = (cible[k] || 0) + v
  return cible
}

function soustraire (brut, aRetirer) {
  const d = {}
  for (const [k, v] of Object.entries(brut)) {
    const reste = v - ((aRetirer || {})[k] || 0)
    if (reste) d[k] = reste
  }
  return d
}

function sommeDesValeurs (objet) {
  let t = 0
  for (const v of Object.values(objet || {})) t += (typeof v === 'number' ? v : 0)
  return t
}

// ─── Le passage ─────────────────────────────────────────────────────────────
// Rend un objet qui porte EXACTEMENT l'interface du chrono d'avant
// (`mesure`, `total`, `resume`), pour que les quarante points d'appel de
// `api/cron.js` ne changent pas d'un caractere — plus `detail()` et
// `terminer()`. Un lot de mesure qui reecrit le code qu'il mesure ne mesure
// plus le meme code.
function demarrerPassage ({
  cron = 'cron',
  resultats = () => null,
  horloge = Date.now,
  journal = console,
  compteurDeFetch = true,
} = {}) {
  if (compteurDeFetch) poserLeCompteur()
  const t0 = horloge()
  const debutISO = new Date(typeof t0 === 'number' ? t0 : Date.now()).toISOString()
  const taches = new Map() // nom -> { nom, n, ms, ms_seul, req, ext, travail }
  const pile = []
  const horsTache = { req: 0, ext: {} }
  // ⚠ L'INSTANTANE D'OUVERTURE, ET IL FERME UN TROU TROUVE EN REVIEW. Huit
  // compteurs de `api/cron.js` sont affectes APRES le retour de `mesure`
  // (`results.totalPrixChanges = bilan.prix_changes`), donc entre deux
  // photographies : leur delta n'etait attribue a personne et le total du
  // passage disait zero la ou le pilote avait change quarante prix. Le travail
  // NON attribue tombe maintenant dans `(hors tache)` — un total qui mente est
  // le pire resultat possible pour un lot de mesure.
  const travailDOuverture = instantane(resultats())

  const courant = {
    seauCourant () { return pile.length ? pile[pile.length - 1] : horsTache },
  }
  passage = courant

  function enregistrer (nom, mesure) {
    const e = taches.get(nom) || { nom, n: 0, ms: 0, ms_seul: 0, req: 0, ext: {}, travail: {} }
    e.n++
    e.ms += mesure.ms
    e.ms_seul += mesure.ms_seul
    e.req += mesure.req
    cumuler(e.ext, mesure.ext)
    cumuler(e.travail, mesure.travail)
    taches.set(nom, e)
  }

  const api = {
    async mesure (nom, fn) {
      const parent = pile.length ? pile[pile.length - 1] : null
      const cadre = { nom, req: 0, ext: {}, enfantsMs: 0, enfantsTravail: {} }
      const avant = instantane(resultats())
      const a = horloge()
      pile.push(cadre)
      try {
        return await fn()
      } finally {
        pile.pop()
        const ms = horloge() - a
        const brut = difference(avant, instantane(resultats()))
        if (parent) {
          parent.enfantsMs += ms
          cumuler(parent.enfantsTravail, brut)
        }
        enregistrer(nom, {
          ms,
          ms_seul: Math.max(0, ms - cadre.enfantsMs),
          req: cadre.req,
          ext: cadre.ext,
          travail: soustraire(brut, cadre.enfantsTravail),
        })
        // La ligne au fil de l'eau : un cycle tue n'ecrit jamais son bilan, et
        // c'est precisement celui-la qu'on cherche. Enrichie des compteurs.
        const ext = sommeDesValeurs(cadre.ext)
        journal.log(`[Cron][chrono] ${nom} ${ms}ms (cumul ${horloge() - t0}ms)`
          + ` | req ${cadre.req}${ext ? ` | ext ${ext}` : ''}`)
      }
    },

    total () { return horloge() - t0 },

    resume () {
      const tri = [...taches.values()].sort((a, b) => b.ms - a.ms)
      return `[Cron][chrono] TOTAL ${horloge() - t0}ms | `
        + tri.map(e => `${e.nom}=${e.ms}ms`).join(' ')
    },

    // Le detail du passage, tel qu'il part en base. Plafonne.
    detail () {
      const total = horloge() - t0
      const liste = [...taches.values()].map(e => ({
        nom: e.nom, n: e.n, ms: e.ms, ms_seul: e.ms_seul, req: e.req,
        ext: e.ext, ext_total: sommeDesValeurs(e.ext),
        travail: e.travail, travail_total: sommeDesValeurs(e.travail),
      }))
      // ⚠ Les requetes faites HORS de toute tache existent, et les cacher
      // ferait mentir le total : `api/cron.js` lit les cles Beds24 et les
      // jetons publics avant la premiere tache, et ecrit `cron_logs` apres la
      // derniere.
      const msDesTaches = liste.reduce((s, e) => s + e.ms_seul, 0)
      // Le travail du passage entier, moins celui que les taches portent
      // deja : ce qui reste a ete fait entre deux mesures.
      const travailDuPassage = difference(travailDOuverture, instantane(resultats()))
      const travailDesTaches = liste.reduce((acc, e) => cumuler(acc, e.travail), {})
      const travailHorsTache = soustraire(travailDuPassage, travailDesTaches)
      if (horsTache.req || sommeDesValeurs(horsTache.ext) || total > msDesTaches
          || Object.keys(travailHorsTache).length) {
        liste.push({
          nom: HORS_TACHE, n: 1,
          ms: Math.max(0, total - msDesTaches), ms_seul: Math.max(0, total - msDesTaches),
          req: horsTache.req, ext: horsTache.ext, ext_total: sommeDesValeurs(horsTache.ext),
          travail: travailHorsTache, travail_total: sommeDesValeurs(travailHorsTache),
        })
      }
      // Tri du classement : requetes d'abord, temps ensuite — l'ordre demande
      // par Thierry, pose ici pour que le plafond coupe les MOINS couteuses.
      liste.sort((a, b) => (b.req - a.req) || (b.ms_seul - a.ms_seul))
      let gardees = liste
      let tronquees = 0
      if (liste.length > TACHES_MAX) {
        gardees = liste.slice(0, TACHES_MAX - 1)
        const reste = liste.slice(TACHES_MAX - 1)
        tronquees = reste.length
        // ⚠ NOM FIXE, ET LE NOMBRE DANS UN CHAMP (constat de review).
        // `cron_stats_classement` groupe par le NOM : « (3 autres taches) » et
        // « (5 autres taches) » devenaient deux lignes distinctes du
        // classement, qui pouvaient occuper le top 10 a elles seules.
        const agregee = {
          nom: AUTRES_TACHES, autres: reste.length, n: reste.reduce((s, e) => s + e.n, 0),
          ms: reste.reduce((s, e) => s + e.ms_seul, 0),
          ms_seul: reste.reduce((s, e) => s + e.ms_seul, 0),
          req: reste.reduce((s, e) => s + e.req, 0),
          ext: reste.reduce((acc, e) => cumuler(acc, e.ext), {}),
          travail: reste.reduce((acc, e) => cumuler(acc, e.travail), {}),
        }
        agregee.ext_total = sommeDesValeurs(agregee.ext)
        agregee.travail_total = sommeDesValeurs(agregee.travail)
        gardees = [...gardees, agregee]
      }
      const req = liste.reduce((s, e) => s + e.req, 0)
      const ext = liste.reduce((acc, e) => cumuler(acc, e.ext), {})
      return {
        cron,
        commence_le: debutISO,
        duree_ms: total,
        requetes: req,
        appels_externes: sommeDesValeurs(ext),
        taches: gardees,
        totaux: {
          taches: liste.length, tronquees,
          externes: ext,
          travail: liste.reduce((acc, e) => cumuler(acc, e.travail), {}),
        },
      }
    },

    // ⚠ A APPELER MEME QUAND LE PASSAGE S'EST MAL FINI. Sans cela, une
    // instance tiede continue de compter dans le passage mort, et les chiffres
    // de l'invocation suivante sont ceux de deux invocations melangees.
    terminer () {
      const d = api.detail()
      if (passage === courant) passage = null
      return d
    },
  }
  return api
}

// Pour les tests et pour un script d'operateur : y a-t-il un passage ouvert ?
function passageEnCours () { return passage !== null }

module.exports = {
  demarrerPassage, compterAppelExterne, classer, passageEnCours,
  poserLeCompteur, retirerLeCompteur,
  instantane, difference, TACHES_MAX, HORS_TACHE, AUTRES_TACHES,
}
