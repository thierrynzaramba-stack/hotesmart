// lib/reponse-partenaire.js
// LE PARTENAIRE A-T-IL REPONDU QUELQUE CHOSE D'EXPLOITABLE ?
//
// ⚠ ETAPE 1 DU CHANTIER « 200 SANS JSON » : ON OBSERVE, ON NE CHANGE RIEN.
// `channelCall` rangeait une reponse non-JSON en `{ raw: text }` et gardait le
// succes du code HTTP. Un 200 portant une page HTML — URL mal reglee, page
// d'erreur d'un pare-feu, maintenance — devenait donc une reponse VALIDE
// annoncant une liste vide. Pour une lecture : « ce compte n'a rien ». Pour une
// ecriture : « c'est fait ». Dix-huit copies de cette fonction, dont QUATRE
// tirent une conclusion destructrice : docs/kb/reponse-200-sans-json.md.
//
// Les quatre chemins se corrigent ENSUITE, un par un, chacun avec sa recette.
// Ici on veut seulement SAVOIR : le cas se produit-il, et ou ? Aucune trace
// n'existe aujourd'hui, par construction — le defaut est MUET.
//
// ⚠ TROIS PROMESSES, ET ELLES ONT CHACUNE LEUR TEST :
//   1. la surveillance ne change JAMAIS la valeur rendue a l'appelant ;
//   2. elle ne LEVE jamais, quoi qu'il arrive a la base ou a l'alarme ;
//   3. elle ne touche la base QUE sur une reponse inexploitable — cout nul sur
//      le chemin normal, qui est l'ecrasante majorite des appels.

const { createClient } = require('@supabase/supabase-js')

const supabaseDefaut = () => createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ UNE PANNE QUI DURE NE DOIT PAS FABRIQUER MILLE LIGNES. `channelCall` est
// appele des dizaines de fois par cycle de cron : un partenaire qui repond HTML
// a chaque appel produirait une ligne par appel. On regroupe dans une fenetre
// par (fichier, code), et on incremente un compteur.
const CADENCE_MS = 10 * 60 * 1000

const EXTRAIT_MAX = 300

// ─── Le verdict ────────────────────────────────────────────────────────────
//
// ⚠ ET LA CONTRE-EPREUVE COMPTE AUTANT QUE LA DETECTION : une surveillance qui
// crie sur du trafic normal se fait eteindre en deux jours. Ne sont signalees
// que les reponses 2xx — un echec HTTP est deja un echec, l'appelant le voit —
// dont le corps n'est pas exploitable.
function verdictDeLaReponse ({ statut, texte, methode }) {
  const n = Number(statut)
  if (!(n >= 200 && n < 300)) return { valide: true, code: null }

  const corps = String(texte == null ? '' : texte)
  const lecture = String(methode || 'GET').toUpperCase() === 'GET'

  if (corps.trim() === '') {
    // Un corps vide est normal sur une ecriture et sur les statuts sans corps.
    if (!lecture || [204, 205].includes(n)) return { valide: true, code: null }
    return { valide: false, code: 'reponse_vide' }
  }

  let json
  try { json = JSON.parse(corps) } catch { return { valide: false, code: 'reponse_non_json' } }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { valide: false, code: 'forme_inattendue' }
  }
  // La forme JSON:API du partenaire : `data` pour une donnee, `meta` pour une
  // pagination seule, `errors` pour un refus.
  if (!('data' in json || 'meta' in json || 'errors' in json)) {
    return { valide: false, code: 'forme_inattendue' }
  }
  // La cle presente ne suffit pas : `{"data": null}` n'est pas une donnee.
  if ('data' in json && json.data === null) {
    return { valide: false, code: 'forme_inattendue' }
  }
  return { valide: true, code: null }
}

// ─── Le chemin, sans identifiant du partenaire ─────────────────────────────
//
// ⚠ UN CHEMIN REEL PORTE DES IDENTIFIANTS : `/channels/<uuid>/mappings/<uuid>`,
// `/bookings?filter[property_id]=…`. On ne les stocke pas — on garde de quoi
// GROUPER les incidents, pas de quoi identifier un bien chez le partenaire.
function cheminNormalise (chemin) {
  const sansRequete = String(chemin || '').split('?')[0]
  return sansRequete
    .split('/')
    .map((seg, i) => {
      if (i === 0 || seg === '') return seg
      // ⚠ UN SEGMENT QUI PORTE UN CHIFFRE EST UN IDENTIFIANT. Mesure sur les
      // chemins reellement appeles — `/channels`, `/properties`,
      // `/room_types`, `/rate_plans`, `/bookings`, `/booking_revisions/:id/ack`,
      // `/availability`, `/restrictions`, `/reviews/:id/guest_review`,
      // `/applications/install`, `/message_threads/:id/messages` : AUCUN nom de
      // ressource ne contient de chiffre. La version d'avant exigeait six
      // caracteres, et laissait donc passer `xyz-9`.
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
      const avecChiffre = /\d/.test(seg)
      const longOpaque = seg.length >= 20
      return (uuid || avecChiffre || longOpaque) ? ':id' : seg
    })
    .join('/')
}

// ─── La surveillance ───────────────────────────────────────────────────────

async function sonner (alarme, clef, detail) {
  try {
    if (typeof alarme === 'function') return await alarme(clef, detail)
    const { reportIncident } = require('./founder-notify')
    return await reportIncident(clef, detail)
  } catch (e) {
    console.error('[reponse-partenaire] alarme non levee :', e.message)
  }
}

async function surveillerReponse (options = {}) {
  const { fichier, methode, chemin, statut, texte,
          sb = null, alarme = null, maintenant = Date.now() } = options
  try {
    const v = verdictDeLaReponse({ statut, texte, methode })
    if (v.valide) return { signale: false }

    const base = sb || supabaseDefaut()
    const depuis = new Date(maintenant - CADENCE_MS).toISOString()

    // ⚠ LA CADENCE SE LIT PAR (fichier, code). Sans ces deux filtres, la panne
    // d'un fichier etoufferait celle d'un autre — et c'est justement l'endroit
    // ou elle se produit qui nous interesse.
    const { data: recentes, error: eL } = await base
      .from('reponses_partenaire_invalides')
      .select('id, occurrences, vu_le')
      .eq('fichier', fichier)
      .eq('code', v.code)
      .gte('vu_le', depuis)
      .order('vu_le', { ascending: false })
      .limit(1)

    const deja = !eL && recentes && recentes[0]
    const quand = new Date(maintenant).toISOString()

    if (deja) {
      const n = Number.isFinite(deja.occurrences) ? deja.occurrences : 1
      await base.from('reponses_partenaire_invalides')
        .update({ occurrences: n + 1, vu_le: quand })
        .eq('id', deja.id)
      return { signale: true, regroupe: true, code: v.code }
    }

    const { error: eI } = await base.from('reponses_partenaire_invalides').insert({
      fichier: String(fichier || '?'),
      methode: String(methode || '?').toUpperCase(),
      chemin: cheminNormalise(chemin),
      statut: Number(statut) || 0,
      code: v.code,
      extrait: String(texte == null ? '' : texte).slice(0, EXTRAIT_MAX),
      occurrences: 1,
      vu_le: quand
    })
    if (eI) console.error('[reponse-partenaire] incident non pose :', eI.message)

    // ⚠ L'ALARME A SON MESSAGE STABLE, les valeurs qui bougent a cote :
    // `founder-notify` reconnait « le meme fait » par son message, et un
    // message portant le fichier changerait a chaque fichier touche — ce qui
    // est justement ce qu'on veut voir separement. Le fichier va donc dans le
    // detail ET dans le message : deux fichiers en panne = deux faits.
    await sonner(alarme, 'reponse_partenaire_invalide', {
      message: `Le partenaire a repondu ${statut} sans JSON exploitable `
        + `depuis ${fichier} (${v.code}).`,
      fichier, code: v.code, statut: Number(statut) || 0,
      chemin: cheminNormalise(chemin),
      fenetreMs: 6 * 3600 * 1000
    })
    return { signale: true, regroupe: false, code: v.code }
  } catch (e) {
    // ⚠ TROISIEME PROMESSE : elle ne leve jamais. Un appelant ne doit pas
    // tomber parce que l'observation a echoue.
    console.error('[reponse-partenaire] surveillance en echec :', e.message)
    return { signale: false, erreur: e.message }
  }
}

module.exports = { verdictDeLaReponse, cheminNormalise, surveillerReponse, CADENCE_MS }
