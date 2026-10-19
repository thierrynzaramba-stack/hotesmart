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

// ⚠ L'OBSERVATION EST BORNEE DANS LE TEMPS. `supabase-js` n'a aucun delai par
// defaut : un `select` qui pend — saturation du pooler, voisinage typique d'une
// panne partenaire — ferait pendre `channelCall`, donc l'appelant, donc la
// fonction serverless. Avant cette etape, `channelCall` RENDAIT sa valeur, a
// tort mais il rendait. Une etape qui pretend seulement observer ne doit pas
// pouvoir bloquer ce qu'elle observe. Constat de la revue de 4dada3e.
const DELAI_MS = 1500

async function avecDelai (promesse, delaiMs) {
  let minuteur
  const expiration = new Promise(r => {
    minuteur = setTimeout(() => r({ __delai: true }), delaiMs)
  })
  try { return await Promise.race([promesse, expiration]) }
  finally { clearTimeout(minuteur) }
}

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
  // ⚠ LA FORME N'EST EXIGEE QUE D'UNE LECTURE, et cette asymetrie est la MEME
  // que celle du guard de `lib/channels/channex.js` — elle y est deliberee et
  // documentee. Sur une ECRITURE, le partenaire rend ce qu'il veut : un objet
  // de tache, un corps vide, parfois `{}`. `POST /applications/install`,
  // `/channels/:id/activate`, `/deactivate`, `/action/load_future_reservations`
  // et `DELETE /channels/:id` sont dans ce cas, et leur forme n'a jamais ete
  // mesuree. Exiger `data` de ces reponses faisait sonner une alarme sur une
  // creation de bien parfaitement reussie. Constat de la revue de 4dada3e.
  //
  // Et le verdict devait rester IDENTIQUE a celui de la reference : sinon les
  // deux comptes ne sont pas comparables — la meme reponse produirait une ligne
  // depuis une copie et rien depuis `channex.js`.
  if (lecture && !('data' in json || 'meta' in json || 'errors' in json)) {
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
      // ⚠ ET UN NOM D'ENDPOINT N'EST PAS UN IDENTIFIANT PARCE QU'IL EST LONG.
      // La regle « 20 caracteres » transformait `load_future_reservations`
      // (24 car.) en `:id` — un POST reel de api/channel-mapping.js, et l'un
      // des quatre chemins destructeurs : on aurait perdu de vue lequel.
      // Un identifiant opaque ne porte pas de tiret bas.
      const longOpaque = seg.length >= 20 && !seg.includes('_')
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
          sb = null, alarme = null, maintenant = Date.now(),
          delaiMs = DELAI_MS } = options
  try {
    const v = verdictDeLaReponse({ statut, texte, methode })
    if (v.valide) return { signale: false }

    const base = sb || supabaseDefaut()
    const depuis = new Date(maintenant - CADENCE_MS).toISOString()

    // ⚠ LA CADENCE SE LIT PAR (fichier, code). Sans ces deux filtres, la panne
    // d'un fichier etoufferait celle d'un autre — et c'est justement l'endroit
    // ou elle se produit qui nous interesse.
    const lu = await avecDelai(base
      .from('reponses_partenaire_invalides')
      .select('id, occurrences, vu_le')
      .eq('fichier', fichier)
      .eq('code', v.code)
      .gte('vu_le', depuis)
      .order('vu_le', { ascending: false })
      .limit(1), delaiMs)

    // ⚠ UNE LECTURE QUI ECHOUE NE DOIT PAS FAIRE ECRIRE EN BOUCLE. La premiere
    // version concluait « rien de recent » et inserait — donc, tant que la
    // table n'existe pas ou que la lecture rate, UNE LIGNE ET UNE ALARME PAR
    // APPEL, soit l'exact contraire de la promesse « une panne qui dure ne
    // fabrique pas mille lignes ». Et `reportIncident` insere SYSTEMATIQUEMENT
    // dans `automation_incidents`, qui a sa propre alarme de croissance. Sans
    // cette lecture on ne SAIT PAS s'il faut noter : on s'abstient, et on le
    // dit dans le journal. Constat de la revue de 4dada3e.
    if (!lu || lu.__delai || lu.error) {
      console.error('[reponse-partenaire] cadence illisible, observation abandonnee :',
                    lu && lu.__delai ? `delai de ${delaiMs} ms depasse`
                                     : (lu && lu.error && lu.error.message) || 'inconnu')
      return { signale: false, cadenceIllisible: true, code: v.code }
    }

    const deja = lu.data && lu.data[0]
    const quand = new Date(maintenant).toISOString()

    if (deja) {
      const n = Number.isFinite(deja.occurrences) ? deja.occurrences : 1
      // ⚠ `vu_le` NE BOUGE PAS. Le repousser a chaque occurrence empechait la
      // fenetre de se fermer : tant que la panne durait, aucune nouvelle ligne,
      // donc aucune nouvelle alarme — une panne de trois jours produisait UN
      // seul avertissement. `vu_le` est donc le DEBUT de la fenetre, et au bout
      // de dix minutes une nouvelle ligne et une nouvelle alarme partent.
      // Constat de la revue de 4dada3e.
      await avecDelai(base.from('reponses_partenaire_invalides')
        .update({ occurrences: n + 1 })
        .eq('id', deja.id), delaiMs)
      return { signale: true, regroupe: true, code: v.code }
    }

    const pose = await avecDelai(base.from('reponses_partenaire_invalides').insert({
      fichier: String(fichier || '?'),
      methode: String(methode || '?').toUpperCase(),
      chemin: cheminNormalise(chemin),
      statut: Number(statut) || 0,
      code: v.code,
      extrait: String(texte == null ? '' : texte).slice(0, EXTRAIT_MAX),
      occurrences: 1,
      vu_le: quand
    }), delaiMs)
    if (pose && pose.__delai) {
      console.error(`[reponse-partenaire] incident non pose : delai de ${delaiMs} ms depasse`)
    } else if (pose && pose.error) {
      console.error('[reponse-partenaire] incident non pose :', pose.error.message)
    }

    // ⚠ LE PAQUET DOIT ENVELOPPER SOUS `detail:`. `reportIncident` destructure
    // son second argument en `{ userId, propertyId, detail, threshold,
    // fenetreMs }` : un paquet passe A PLAT lui donne `detail = null`, et
    // l'alerte part SANS le fichier, sans le code, sans le chemin — c'est-a-dire
    // sans la seule information pour laquelle cette etape existe. Mesure de la
    // revue de 4dada3e : le wrapper avait ete perdu en copiant
    // `lib/canaux-du-bien.js`, qui le porte.
    //
    // ⚠ ET LE FICHIER EST DANS LE MESSAGE, deliberement. `founder-notify`
    // reconnait « le meme fait » par son message : sans le fichier dedans, deux
    // pannes sur deux fichiers differents auraient la MEME signature, et la
    // seconde serait etouffee six heures.
    await sonner(alarme, 'reponse_partenaire_invalide', {
      detail: {
        message: `Le partenaire a repondu ${statut} sans JSON exploitable `
          + `depuis ${fichier} (${v.code}).`,
        fichier, code: v.code, statut: Number(statut) || 0,
        chemin: cheminNormalise(chemin)
        // ⚠ JAMAIS `texte` ICI. `reportIncident` ecrit ce detail dans
        // `automation_incidents`, qui est lue par un ecran : les 300 caracteres
        // du corps du partenaire restent dans `reponses_partenaire_invalides`,
        // fermee a tout client.
      },
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

module.exports = { verdictDeLaReponse, cheminNormalise, surveillerReponse,
                   CADENCE_MS, DELAI_MS }
