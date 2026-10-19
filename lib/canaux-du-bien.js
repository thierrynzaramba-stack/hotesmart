// lib/canaux-du-bien.js
// LES CANAUX D'UN BIEN, REPERTORIES DANS LE COEUR — dette 59.
// DOC : docs/specs/spec-canaux-au-coeur.md (modif = MEME COMMIT)
//
// ⚠ POURQUOI CE MODULE EXISTE. Pour afficher « Airbnb » sous le nom d'un bien,
// l'ecran interrogeait le partenaire EN DIRECT, un appel par bien, a chaque
// affichage. Quand le partenaire ne repondait pas, `hydrateChannelBadges`
// faisait `container.remove()` : les pastilles disparaissaient SANS UN MOT, et
// l'hote lisait « aucun canal » la ou il en a deux. Et aucune app ne pouvait
// lire les canaux, alors que c'est une donnee du bien.
//
// ⚠ CE MODULE EST LE WRITER UNIQUE de `canaux_du_bien`. Aucun ecran n'ecrit
// ici, aucune app non plus : la couche sync l'appelle, les apps lisent.
//
// ⚠ LECTURE SEULE CHEZ LE PARTENAIRE, ET C'EST GARDE PAR UN TEST.
// `lireCanauxDuPartenaire` n'emet que des GET. Aucun POST, PUT, PATCH ni
// DELETE ne part d'ici : on ne cree pas de mapping, on n'active pas un canal,
// on ne pousse aucun tarif. On regarde.

const { createClient } = require('@supabase/supabase-js')
// ⚠ L'APPEL PASSE PAR lib/channels, PAS PAR UNE COPIE LOCALE. `api/channel-
// mapping.js` porte sa propre fonction d'appel, SANS rejeu : un 429 du
// partenaire y devient un echec sec. Celle de lib/channels rejoue en
// respectant `retry-after`. Regle du depot : tout code canal via lib/channels.
const { channelCall } = require('./channels/channex')

const supabaseDefaut = () => createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ UNE HEURE, ET C'EST UNE MESURE, PAS UN REFLEXE. `GET /channels` rend TOUT
// le compte en un appel (mesure du 19 octobre 2026 : meta.total, limit 10).
// Les canaux changent quand un humain agit — connecter une annonce, couper un
// canal —, pas toutes les cinq minutes. Un appel par heure et par compte.
const AGE_MAX_MS = 60 * 60 * 1000

// ⚠ `channelCall` N'A AUCUN DELAI D'EXPIRATION. Un partenaire qui accepte la
// connexion puis se tait bloquait le releve — et avec lui la fonction entiere,
// jusqu'au plafond de la plateforme. On borne notre attente ; on ne peut pas
// annuler sa requete, mais on cesse d'en dependre.
const DELAI_MS = 10000

// ⚠ UNE DISPARITION TOTALE SE CONFIRME (demande de Thierry, 19 octobre 2026).
// Une lecture qui annonce que TOUS les canaux d'un compte ont disparu n'est pas
// crue du premier coup : il faut une SECONDE lecture concordante, au moins une
// heure plus tard. Le guard de `channelCall` ferme le cas du `200` + HTML
// (docs/kb/reponse-200-sans-json.md) ; il ne ferme pas la FAMILLE — une liste
// vide rendue par erreur, une cle qui change de perimetre, un compte vu vide un
// instant. L'effacement est irreversible a l'echelle de l'ecran : il attend.
const CONFIRMATION_MS = 60 * 60 * 1000

// ⚠ UN `console.error` NE REVEILLE PERSONNE. Au-dela de ce seuil d'echecs
// d'affilee, le fondateur est appele.
const PANNE_MS = 24 * 60 * 60 * 1000

// ⚠ L'ALARME EST INJECTABLE, ET ELLE NE DOIT JAMAIS FAIRE TOMBER LE RELEVE.
// Sans injection, aucun test ne peut prouver qu'elle sonne — ni, surtout,
// qu'elle NE sonne PAS pour six heures d'echecs.
async function sonner (alarme, clef, detail) {
  try {
    if (typeof alarme === 'function') return await alarme(clef, detail)
    const { reportIncident } = require('./founder-notify')
    return await reportIncident(clef, detail)
  } catch (e) {
    console.error('[canaux-du-bien] alarme non levee :', e.message)
  }
}

// Borne notre attente sans pretendre annuler la requete du partenaire.
async function avecDelai (promesse, delaiMs) {
  let minuteur
  const expiration = new Promise(r => {
    minuteur = setTimeout(() => r({ __delai: true }), delaiMs)
  })
  try { return await Promise.race([promesse, expiration]) }
  finally { clearTimeout(minuteur) }
}

// ⚠ ON PAGINE. `limit` vaut 10 par defaut. Trois canaux tiennent sur une page
// aujourd'hui ; le jour ou un compte en aura douze, une lecture sans
// pagination en oublierait deux SANS LEVER. Ce depot a deja paye cette
// troncature muette sur `bookings_snapshot`.
const PAS = 50
const PAGES_MAX = 20

// Les tarifs qui appartiennent a CE bien : son tarif de base, plus ceux que
// nos liens lui rattachent.
//
// ⚠ UNE SEULE DEFINITION. `api/channel-mapping.js` portait la sienne ; deux
// copies de la meme regle divergent, et celle-ci decide si une pastille est
// verte. Elle vit ici, l'endpoint l'importe.
function tarifsDuBienDe (bien, liens) {
  const s = new Set()
  if (bien && bien.provider_rate_plan_id) s.add(String(bien.provider_rate_plan_id))
  for (const l of liens || []) if (l && l.provider_rate_plan_id) s.add(String(l.provider_rate_plan_id))
  return s
}

// L'OTA, normalise par NOUS. Le partenaire ecrit « AirBNB », « BookingCom » ;
// l'interface de l'hote ne doit jamais dependre de son orthographe.
const OTA = [
  [/airbnb/i, 'airbnb'],
  [/booking/i, 'booking'],
  [/expedia/i, 'expedia'],
  [/vrbo|homeaway/i, 'vrbo']
]
const normaliserOta = (v) => {
  const t = String(v || '')
  for (const [re, nom] of OTA) if (re.test(t)) return nom
  return t ? t.toLowerCase() : null
}

// ─── La lecture chez le partenaire : GET, et rien d'autre ──────────────────
async function lireCanauxDuPartenaire ({ appel = channelCall, delaiMs = DELAI_MS } = {}) {
  const canaux = []
  // ⚠ `total` SE RETIENT, IL NE SE RELIT PAS (constat de la RE-revue de
  // b181192, et c'est la MEME faute que le constat bloquant d'avant, par une
  // autre porte). Un partenaire met souvent `meta.total` sur la PREMIERE page
  // seulement : relu a chaque tour, il redevenait indefini page 2, et la regle
  // « page courte sans total » concluait a la fin de liste. Mesure de la
  // revue : 20 canaux lus sur 25 annonces, et cinq `disparu_le` ecrits.
  let totalAnnonce = null
  for (let page = 1; page <= PAGES_MAX; page++) {
    const r = await avecDelai(
      appel('GET', `/channels?pagination[page]=${page}&pagination[limit]=${PAS}`), delaiMs)
    // ⚠ UN SILENCE QUI DURE N'EST PAS UNE REPONSE. Sans cette borne, un
    // partenaire qui ne repond jamais retenait le releve indefiniment.
    if (r && r.__delai) {
      console.error(`[canaux-du-bien] partenaire sans reponse apres ${delaiMs} ms`)
      return { ok: false, motif: 'delai', http: 0, canaux: [] }
    }
    // ⚠ UN ECHEC NE REND PAS UNE LISTE VIDE. Rendre `[]` ici ferait passer un
    // partenaire muet pour un compte sans canal — et le writer effacerait tout.
    if (!r || !r.ok) {
      return { ok: false, motif: 'injoignable', http: r ? r.status : 0, canaux: [] }
    }
    // ⚠ LA FORME SE VERIFIE, ELLE NE SE COERCE PAS (19 octobre 2026). Ce test
    // etait `Array.isArray(...) ? ... : []` : une reponse sans `data` devenait
    // une liste vide, donc « ce compte n'a aucun canal », donc l'effacement de
    // tout le compte. `channelCall` garde desormais la meme regle a sa source,
    // mais le writer ne s'en remet pas a son appelant pour une decision aussi
    // couteuse — et `appel` est injectable.
    if (!Array.isArray(r.json && r.json.data)) {
      console.error('[canaux-du-bien] reponse sans liste `data` :', typeof (r.json && r.json.data))
      return { ok: false, motif: 'reponse_invalide', http: r.status, canaux: [] }
    }
    const lot = r.json.data
    canaux.push(...lot)
    const t = Number(r.json && r.json.meta && r.json.meta.total)
    if (Number.isFinite(t)) totalAnnonce = t

    // 1. On a tout ce que le partenaire a annonce.
    if (totalAnnonce !== null && canaux.length >= totalAnnonce) {
      return { ok: true, motif: null, http: 200, canaux }
    }
    // 2. Le flux s'arrete SOUS le total annonce : c'est une incoherence de sa
    //    part, pas une fin de liste. On refuse plutot que d'ecrire des
    //    disparitions sur ce qu'on n'a pas lu.
    if (!lot.length) {
      if (totalAnnonce !== null) {
        console.error(`[canaux-du-bien] flux interrompu : ${canaux.length} lus sur ${totalAnnonce} annonces`)
        return { ok: false, motif: 'tronquee', http: 200, canaux: [] }
      }
      return { ok: true, motif: null, http: 200, canaux }
    }
    // 3. Page courte et AUCUN total jamais annonce : rien d'autre a lire de sur.
    if (lot.length < PAS && totalAnnonce === null) {
      return { ok: true, motif: null, http: 200, canaux }
    }
    // 4. Page courte SOUS un total annonce : le partenaire plafonne sa propre
    //    `limit`. On continue de paginer — c'est le cas mesure le 19 octobre.
  }
  // ⚠ PLAFOND ATTEINT : ON NE REND PAS UNE LISTE QU'ON SAIT PEUT-ETRE
  // TRONQUEE. Et le motif dit « plafonnee », pas « injoignable » : le
  // partenaire a repondu 200 vingt fois, celui qui lira le journal ne doit pas
  // chercher une panne reseau.
  console.error('[canaux-du-bien] plafond de pages atteint : lecture abandonnee')
  return { ok: false, motif: 'plafonnee', http: 200, canaux: [] }
}

// ─── Les lignes a ecrire, deduites d'une lecture reussie ───────────────────
//
// ⚠ UNE LIGNE PAR (CANAL, BIEN), ET LE RATTACHEMENT SE LIT CHEZ NOUS.
// `rate_plans[]` du partenaire ne porte pas de `property_id` : seulement des
// `rate_plan_id`. Le lien vers un bien vient de `property_channel_rate_plans`,
// qui est la source qui a CREE les mappings.
//
// ⚠ ET `is_active` EST UNE PROPRIETE DU CANAL, PAS DU BIEN. Un canal Airbnb
// porte plusieurs logements : celui du compte mesure en porte trois. Le
// 11 septembre 2026, un bien neuf SANS aucun mapping portait une pastille
// verte. La question juste est « ce canal porte-t-il un tarif DE CE BIEN ? ».
function lignesDeLaLecture ({ canaux, biens, liensParBien, liensLisibles, maintenant }) {
  const quand = new Date(maintenant).toISOString()
  const parIdPartenaire = new Map()
  for (const b of biens) {
    if (b.provider_property_id) parIdPartenaire.set(String(b.provider_property_id), b)
  }
  const lignes = []
  for (const c of canaux) {
    const at = (c && c.attributes) || {}
    // ⚠ DEDOUBLONNE (constat de la revue de 21e0794). Deux fois le meme
    // identifiant dans `properties[]` produisait deux lignes de meme cle de
    // conflit, et Postgres rejette l'upsert ENTIER (« ON CONFLICT DO UPDATE
    // command cannot affect row a second time »). Aucune ligne n'etait alors
    // ecrite, donc aucun `vu_le` : le compte repassait au cycle suivant et
    // echouait a l'identique, indefiniment.
    const rattaches = Array.isArray(at.properties) ? [...new Set(at.properties.map(String))] : []
    const mappings = Array.isArray(at.rate_plans) ? at.rate_plans : []
    for (const idPartenaire of rattaches) {
      const bien = parIdPartenaire.get(String(idPartenaire))
      if (!bien) continue   // un bien du partenaire qu'on ne connait pas : pas le notre
      const tarifs = tarifsDuBienDe(bien, liensParBien.get(String(bien.id)) || [])
      const pourCeBien = mappings.filter(m => m && tarifs.has(String(m.rate_plan_id)))
      lignes.push({
        user_id: bien.user_id,
        property_id: bien.id,
        provider: bien.provider === 'beds24' ? 'beds24' : 'channex',
        provider_property_id: String(idPartenaire),
        provider_channel_id: String(c.id),
        ota: normaliserOta(at.channel || at.ota_name),
        titre: at.title || null,
        actif: at.is_active === true,
        // ⚠ `null` QUAND ON N'A PAS PU CONCLURE, jamais `false` par defaut :
        // une lecture de nos liens en echec renverrait un bien deja connecte
        // dans le parcours de connexion, et lui ferait creer un second mapping.
        mappe_pour_ce_bien: liensLisibles ? pourCeBien.length > 0 : null,
        mappings_pour_ce_bien: pourCeBien.length,
        vu_le: quand,
        disparu_le: null,
        mis_a_jour_le: quand
      })
    }
  }
  return lignes
}

// ─── Le point d'entree : un compte, un passage ─────────────────────────────
//
// Rend { ok, ecrits, disparus, erreur } et NE LEVE JAMAIS : un echec de
// relevé ne doit ni casser le cycle de sync, ni faire echouer la requete qui
// l'a declenche.
// ⚠ L'HORLOGE SE POSE A CHAQUE TENTATIVE, REUSSIE OU NON (constat de la revue
// de 21e0794). Sans elle, un compte sans aucun canal n'avait aucune ligne dans
// `canaux_du_bien`, donc aucune date de releve : le cron le reprenait a chaque
// passage — douze fois par heure au lieu d'une. `tente_le` tient la cadence,
// `vu_le` ne bouge que sur une reponse reussie et c'est elle que l'ecran
// montre.
// ⚠ CE QUE L'HOTE DOIT LIRE COMME UN ECHEC — ET CE QUI N'EN EST PAS UN.
// La regle vit ICI, pas en expression dans l'endpoint : l'endpoint n'est pas
// eprouvable sans un harnais complet, et c'est la seule decision qui determine
// si le mot « verification impossible » s'affiche. Deux etats rendent
// `ok: false` et ne veulent pas dire la meme chose :
//   · un vrai echec de lecture (injoignable, delai, forme inattendue, …)
//     -> l'hote doit le savoir, sa date vieillit sans qu'il sache pourquoi ;
//   · un effacement SUSPENDU par le disjoncteur -> la lecture a reussi, rien
//     d'anormal pour l'hote ; c'est nous que ca concerne.
function echecVisibleParLHote (horloge) {
  if (!horloge || horloge.ok !== false) return false
  return horloge.erreur !== 'suspendu'
}

// L'horloge d'un compte, ou `null`. Une lecture en echec rend `null` plutot
// qu'une ligne a zero : on ne veut pas remettre un compteur d'echecs a 1 parce
// que NOTRE base a eu un hoquet.
async function lireHorloge (base, userId) {
  const { data, error } = await base.from('canaux_releve')
    .select('user_id, ok, echecs_consecutifs, premier_echec_le, '
          + 'disparition_totale_vue_le, disparition_totale_nb')
    .eq('user_id', userId).limit(1)
  if (error) { console.error('[canaux-du-bien] horloge illisible :', error.message); return null }
  return (data && data[0]) || null
}

async function noterLeReleve (base, userId, maintenant, bilan) {
  const quand = new Date(maintenant).toISOString()
  const ligne = { user_id: userId, tente_le: quand, ok: !!bilan.ok,
                  // ⚠ UN MOTIF NORMALISE, JAMAIS LE MESSAGE BRUT (constat de
                  // la RE-revue de b181192). `bilan.erreur` porte des messages
                  // Supabase entiers — noms de contraintes, de colonnes,
                  // details du moteur — et cette colonne est lisible par tout
                  // collaborateur ayant `reservations` en lecture.
                  erreur: bilan.ok ? null : (bilan.motif || 'echec'),
                  mis_a_jour_le: quand }
  // ⚠ `vu_le` SUIT CE QUI A ETE REELLEMENT RELEVE (constat de la meme revue).
  // Un releve `partiel` a bien ecrit ses canaux : seule la passe de
  // disparition a echoue. Laisser `vu_le` en arriere ferait afficher
  // « verifie il y a une heure » sur une information d'il y a une seconde.
  if (bilan.ok || bilan.ecrits > 0) ligne.vu_le = quand

  // ⚠ LA DUREE D'UNE PANNE, PAS SON DERNIER INSTANT. L'horloge ne gardait que
  // le dernier etat : impossible de distinguer un hoquet d'une panne qui dure
  // depuis la veille, donc rien ne pouvait sonner. On compte les echecs
  // d'affilee et on retient la date du premier.
  const avant = await lireHorloge(base, userId)
  if (bilan.ok) {
    ligne.echecs_consecutifs = 0
    ligne.premier_echec_le = null
  } else {
    const n = avant && Number.isFinite(avant.echecs_consecutifs) ? avant.echecs_consecutifs : 0
    ligne.echecs_consecutifs = n + 1
    ligne.premier_echec_le = avant && avant.premier_echec_le
      ? new Date(avant.premier_echec_le).toISOString()
      : quand
  }

  // Le disjoncteur : on garde la trace de la premiere annonce de disparition
  // totale, et son nombre. Une lecture reussie qui n'annonce plus rien de tel
  // l'efface — sinon une confirmation d'aujourd'hui vaudrait pour une annonce
  // du mois dernier.
  if (bilan.disparitionTotale) {
    // Normalisee : la valeur vient de la base, elle y retourne sous la meme
    // forme que tout ce que ce writer ecrit.
    ligne.disparition_totale_vue_le = bilan.disparitionTotale.premiereVue
      ? new Date(bilan.disparitionTotale.premiereVue).toISOString()
      : quand
    ligne.disparition_totale_nb = bilan.disparitionTotale.nb
  } else if (bilan.ok) {
    ligne.disparition_totale_vue_le = null
    ligne.disparition_totale_nb = null
  }

  const { error } = await base.from('canaux_releve')
    .upsert(ligne, { onConflict: 'user_id' })
  if (error) console.error('[canaux-du-bien] horloge non posee :', error.message)
  return ligne
}

async function rafraichirCanauxDuCompte (options = {}) {
  const { userId, maintenant = new Date(), sb = null, alarme = null } = options
  const bilan = await releverUnCompte(options)
  // ⚠ MEME QUAND LE RELEVE ECHOUE. C'est tout l'interet : sans horloge, un
  // partenaire en panne se fait marteler toutes les cinq minutes.
  // ⚠ L'HORLOGE EXISTE POUR NE PAS MARTELER LE PARTENAIRE : elle ne se pose
  // donc QUE si on lui a parle. Un hoquet de notre propre base — `biens
  // illisibles` — suspendait le releve du compte pendant une heure pour une
  // panne qui n'etait pas la sienne (constat de la RE-revue de b181192).
  let horloge = null
  if (userId && bilan.aParle) {
    try { horloge = await noterLeReleve(sb || supabaseDefaut(), userId, maintenant, bilan) }
    catch (e) { console.error('[canaux-du-bien] horloge :', e.message) }
  }

  // ⚠ UNE PANNE QUI DURE SE VOIT, MEME SI L'ECRAN NE SE VIDE PAS. Les
  // pastilles restent — c'est voulu —, la mention vieillit doucement, et rien
  // ne sonnait. Au-dela de 24 h d'echecs d'affilee, on reveille le fondateur.
  if (horloge && horloge.ok === false && horloge.premier_echec_le
      && (new Date(maintenant) - new Date(horloge.premier_echec_le)) >= PANNE_MS) {
    const heures = Math.round((new Date(maintenant) - new Date(horloge.premier_echec_le)) / 3600000)
    await sonner(alarme, 'canaux_releve_en_panne', {
      userId,
      detail: `Le releve des canaux echoue depuis ${heures} h `
        + `(${horloge.echecs_consecutifs} tentative(s) d affilee, motif « ${horloge.erreur} »). `
        + 'L ecran de l hote affiche encore ses canaux, avec leur date de derniere '
        + 'confirmation : il ne se vide pas, mais il vieillit.',
      fenetreMs: 6 * 3600 * 1000
    })
  }
  // ⚠ UN ETAT QUI NE SE REPARE PAS TOUT SEUL SONNE. Le plafond de pages se
  // repetera a chaque cycle — vingt appels pour rien — jusqu'a ce qu'un humain
  // regarde. Un `console.error` ne reveille personne.
  if (bilan.motif === 'plafonnee' || bilan.motif === 'tronquee') {
    try {
      const { reportIncident } = require('./founder-notify')
      await reportIncident('canaux_lecture_incomplete', {
        userId, detail: bilan.erreur, fenetreMs: 6 * 3600 * 1000
      })
    } catch (e) { console.error('[canaux-du-bien] alarme non levee :', e.message) }
  }
  return bilan
}

async function releverUnCompte ({ userId, maintenant = new Date(), sb = null,
                                  appel = channelCall, delaiMs = DELAI_MS,
                                  alarme = null } = {}) {
  const bilan = { ok: false, partiel: false, aParle: false, motif: null,
                  ecrits: 0, disparus: 0, erreur: null, disparitionTotale: null }
  const base = sb || supabaseDefaut()
  try {
    if (!userId) { bilan.erreur = 'compte manquant'; return bilan }

    const { data: biens, error: eB } = await base.from('properties')
      .select('id, user_id, provider, provider_property_id, provider_rate_plan_id')
      .eq('user_id', userId)
    if (eB) { bilan.erreur = 'biens illisibles : ' + eB.message; return bilan }
    if (!biens || !biens.length) { bilan.ok = true; return bilan }

    // ⚠ UNE LECTURE DE NOS LIENS EN ECHEC NE SE LIT PAS « PAS MAPPE ».
    // On le DIT (`liensLisibles`), et `mappe_pour_ce_bien` reste `null`.
    const { data: liens, error: eL } = await base.from('property_channel_rate_plans')
      .select('property_id, provider_rate_plan_id')
      .in('property_id', biens.map(b => b.id))
    const liensLisibles = !eL
    const liensParBien = new Map()
    for (const l of liens || []) {
      const k = String(l.property_id)
      if (!liensParBien.has(k)) liensParBien.set(k, [])
      liensParBien.get(k).push(l)
    }

    // ⚠ A PARTIR D'ICI SEULEMENT, ON AURA PARLE AU PARTENAIRE. Ce qui precede
    // — biens illisibles, compte sans bien — est un echec de NOTRE base : il
    // ne doit pas suspendre le releve pendant une heure (constat de la
    // RE-revue de b181192). `bilan.aParle` le dit a l'horloge.
    bilan.aParle = true
    const lu = await lireCanauxDuPartenaire({ appel, delaiMs })
    // ⚠ LE PARTENAIRE MUET N'EFFACE RIEN. On n'ecrit pas, on ne pose aucun
    // `disparu_le`, et `vu_le` garde sa valeur : l'ecran continue d'afficher
    // les canaux connus avec « verifie il y a … ». UN SILENCE N'EST PAS UNE
    // DISPARITION.
    if (!lu.ok) {
      bilan.motif = lu.motif
      bilan.erreur = lu.motif === 'plafonnee'
        ? `lecture plafonnee (${PAGES_MAX} pages, le partenaire repond mais n en finit pas)`
        : lu.motif === 'tronquee'
          ? 'lecture tronquee : le partenaire s est arrete sous le total qu il annonce'
          : lu.motif === 'reponse_invalide'
            ? `reponse de forme inattendue (http ${lu.http}) : aucune liste de canaux`
            : lu.motif === 'delai'
              ? `partenaire sans reponse apres ${delaiMs} ms`
              : `partenaire injoignable (http ${lu.http})`
      console.error('[canaux-du-bien] releve abandonne :', bilan.erreur)
      return bilan
    }

    const lignes = lignesDeLaLecture({
      canaux: lu.canaux, biens, liensParBien, liensLisibles, maintenant })

    // ⚠ ON DEDOUBLONNE LES LIGNES, PAS SEULEMENT `properties[]` (constat de la
    // RE-revue de b181192). Le meme canal rendu deux fois par le partenaire —
    // pagination instable, ou `pagination[page]` ignore, ce qui fait redemander
    // la meme page — produisait deux lignes de meme cle de conflit. Postgres
    // rejette alors l'upsert ENTIER (« cannot affect row a second time ») :
    // zero canal ecrit, et l'echec se repete a chaque cycle.
    const parCle = new Map()
    for (const l of lignes) {
      parCle.set(`${l.user_id}|${l.property_id}|${l.provider_channel_id}`, l)
    }
    const aEcrire = [...parCle.values()]

    if (aEcrire.length) {
      const { error: eU } = await base.from('canaux_du_bien')
        .upsert(aEcrire, { onConflict: 'user_id,property_id,provider_channel_id' })
      if (eU) {
        bilan.erreur = 'ecriture impossible : ' + eU.message
        bilan.motif = 'ecriture'
        return bilan
      }
      bilan.ecrits = aEcrire.length
    }

    // Les lignes du compte qu'une lecture REUSSIE n'a plus vues.
    const vus = new Set(aEcrire.map(l => `${l.property_id}|${l.provider_channel_id}`))
    const { data: existantes, error: eE } = await base.from('canaux_du_bien')
      .select('id, property_id, provider_channel_id')
      .eq('user_id', userId).is('disparu_le', null)
    // ⚠ UNE RELECTURE EN ECHEC N'EST PAS UN SUCCES (constat de la revue de
    // 21e0794). `ok: true` avec une `erreur` rendait la branche MUETTE pour la
    // couche sync, qui journalise sur `!ok` — c'est la lecon « erreur avalee,
    // cron a 200 ». Les canaux ont bien ete ecrits, mais les disparitions n'ont
    // pas eu lieu : c'est partiel, et ca se dit.
    if (eE) {
      bilan.erreur = 'relecture impossible : ' + eE.message
      bilan.partiel = true
      console.error('[canaux-du-bien]', bilan.erreur)
      return bilan
    }
    const partis = (existantes || [])
      .filter(l => !vus.has(`${l.property_id}|${l.provider_channel_id}`))
      .map(l => l.id)

    // ⚠ LE DISJONCTEUR (demande de Thierry, 19 octobre 2026). Une lecture qui
    // annonce que TOUS les canaux du compte ont disparu n'efface rien du
    // premier coup : on note l'annonce, et il faut une SECONDE lecture
    // concordante — meme nombre de canaux, au moins une heure plus tard.
    //
    // ⚠ ET ON REND `ok: false`. La lecture a reussi, mais l'effacement qu'elle
    // commandait n'a PAS eu lieu : se declarer reussi ici rendrait la branche
    // muette pour la couche sync, qui journalise sur `!ok` — c'est la lecon
    // « erreur avalee, cron a 200 ». L'ecran garde ses pastilles et dit qu'il
    // n'a pas pu verifier : c'est exactement ce qu'on sait.
    const vivants = (existantes || []).length
    if (vivants > 0 && partis.length === vivants) {
      const h = await lireHorloge(base, userId)
      const vueLe = h && h.disparition_totale_vue_le ? h.disparition_totale_vue_le : null
      const memeNombre = h && h.disparition_totale_nb === vivants
      const assezVieille = vueLe
        && (new Date(maintenant) - new Date(vueLe)) >= CONFIRMATION_MS
      if (!(vueLe && memeNombre && assezVieille)) {
        bilan.disparitionTotale = { nb: vivants, premiereVue: memeNombre ? vueLe : null }
        // ⚠ `suspendu`, ET PAS « ECHEC » (decision de Thierry, 19 octobre
        // 2026). La lecture a REUSSI : seul l'effacement qu'elle commandait
        // est reporte. Le cron doit le voir et le fondateur doit en etre
        // averti, mais l'hote, lui, n'a rien a lire d'anormal — ses pastilles
        // et leur date sont exactement celles d'avant. « Verification
        // impossible » est reserve a un vrai echec de lecture.
        bilan.motif = 'suspendu'
        bilan.erreur = `le partenaire n annonce plus AUCUN des ${vivants} canaux du compte :`
          + ' effacement suspendu, une seconde lecture concordante est attendue'
        console.error('[canaux-du-bien]', bilan.erreur)
        await sonner(alarme, 'canaux_disparition_totale', {
          userId,
          detail: `Une lecture reussie n annonce plus aucun des ${vivants} canaux de ce compte.`
            + ' Rien n a ete efface. Si la seconde lecture confirme dans l heure,'
            + ' les pastilles disparaitront de l ecran de l hote.',
          fenetreMs: 6 * 3600 * 1000
        })
        return bilan
      }
      console.log(`[canaux-du-bien] disparition totale CONFIRMEE (${vivants} canaux, 2e lecture)`)
    }

    if (partis.length) {
      const quand = new Date(maintenant).toISOString()
      const { error: eD } = await base.from('canaux_du_bien')
        .update({ disparu_le: quand, mis_a_jour_le: quand })
        .in('id', partis).eq('user_id', userId)
      if (!eD) bilan.disparus = partis.length
      else console.error('[canaux-du-bien] disparition non notee :', eD.message)
    }

    bilan.ok = true
    return bilan
  } catch (e) {
    bilan.erreur = e.message
    console.error('[canaux-du-bien] echec :', e.message)
    return bilan
  }
}

// Les comptes dont le relevé a plus d'une heure. Le cycle horaire se tient
// par `vu_le`, pas par un minuteur : rien a planifier sur le cron.
async function comptesARelever ({ maintenant = new Date(), sb = null, limite = 25 } = {}) {
  const base = sb || supabaseDefaut()
  const { data, error } = await base.from('properties')
    .select('user_id').eq('provider', 'channex')
  if (error || !data) return []
  const comptes = [...new Set(data.map(p => String(p.user_id)))]
  const seuil = new Date(new Date(maintenant).getTime() - AGE_MAX_MS).toISOString()
  // ⚠ ON LIT L'HORLOGE, PAS LES CANAUX (constat de la revue de 21e0794). Un
  // compte sans canal n'a aucune ligne dans `canaux_du_bien` : s'y fier le
  // faisait relever a chaque cycle. Et `tente_le`, pas `vu_le` : sinon un
  // partenaire en panne se fait marteler.
  // ⚠ BORNEE, ET INTERROGEE SUR LES COMPTES QU'ON CONNAIT (constat de la
  // RE-revue de b181192). PostgREST tronque une lecture sans borne a 1000
  // lignes SANS LEVER : au-dela, `recents` serait incomplet et des comptes
  // deja releves repasseraient — le martelement que cette horloge existe pour
  // empecher, et muet. C'est la troncature que ce depot a deja payee.
  const { data: horloges, error: eH } = await base.from('canaux_releve')
    .select('user_id, tente_le')
    .in('user_id', comptes)
    .gt('tente_le', seuil)
    .limit(comptes.length)
  // ⚠ UNE LECTURE EN ECHEC NE SE LIT PAS « TOUT EST A RELEVER ». On s'abstient
  // : mieux vaut un cycle sans releve qu'une rafale d'appels au partenaire.
  if (eH) {
    console.error('[canaux-du-bien] horloges illisibles :', eH.message)
    return []
  }
  const recents = new Set((horloges || []).map(h => String(h.user_id)))
  return comptes.filter(u => !recents.has(u)).slice(0, limite)
}

// ─── CE QUE LA COUCHE SYNC APPELLE ────────────────────────────────────────
//
// ⚠ BORNEE EN TEMPS ET EN NOMBRE, ET CE N'EST PAS NEGOCIABLE. Le cycle du cron
// a un budget de 60 s et porte des postes qui, eux, ne peuvent pas attendre :
// les tokens, les reservations, les sondes anti-boucle. Le releve des canaux
// est le poste le MOINS urgent du lot — un canal change quand un humain agit.
// Il prend donc ce qui reste, et pas une seconde de plus : au prochain cycle,
// les comptes non releves seront toujours dus.
//
// ⚠ ET IL NE LEVE JAMAIS. `rafraichirCanauxDuCompte` attrape deja tout ; cette
// boucle attrape ce qui resterait. Un releve en echec ne doit ni faire echouer
// le cycle, ni empecher le compte suivant.
const BUDGET_MS = 8000
const COMPTES_MAX = 5

async function releverLesComptesDus ({ maintenant = new Date(), sb = null,
                                       budgetMs = BUDGET_MS,
                                       maxComptes = COMPTES_MAX } = {}) {
  const t0 = Date.now()
  const bilan = { comptes: 0, ecrits: 0, disparus: 0, echecs: 0, abandonnes: 0 }
  let dus = []
  try {
    dus = await comptesARelever({ maintenant, sb, limite: maxComptes })
  } catch (e) {
    console.error('[canaux-du-bien] comptes a relever illisibles :', e.message)
    return bilan
  }
  for (const userId of dus) {
    if (Date.now() - t0 >= budgetMs) {
      bilan.abandonnes = dus.length - bilan.comptes
      console.log(`[canaux-du-bien] budget epuise : ${bilan.abandonnes} compte(s) au prochain cycle`)
      break
    }
    try {
      const r = await rafraichirCanauxDuCompte({ userId, maintenant, sb })
      bilan.comptes++
      bilan.ecrits += r.ecrits
      bilan.disparus += r.disparus
      if (!r.ok) bilan.echecs++
    } catch (e) {
      bilan.comptes++
      bilan.echecs++
      console.error('[canaux-du-bien] compte', String(userId).slice(0, 8), ':', e.message)
    }
  }
  return bilan
}

// La fraicheur a montrer pour UN bien.
//
// ⚠ CE N'EST PAS CELLE DU COMPTE. L'horloge `canaux_releve` tient la cadence
// du releve ; elle ne dit pas de quand datent LES CANAUX DE CE BIEN-LA. Poser
// la meme date sur toutes les cartes faisait dire a chacune « verifie il y a
// 7 min » en parlant d'autre chose qu'elle.
// On prend le `vu_le` le PLUS ANCIEN des canaux du bien — le plus prudent : si
// l'un d'eux n'a pas ete reconfirme, c'est lui qui donne le ton. L'horloge du
// compte ne sert qu'a un bien SANS canal, ou c'est la seule date qui existe.
function fraicheurDuBien (canauxDuBien, horlogeDuCompte) {
  let plusAncien = null
  for (const c of canauxDuBien || []) {
    if (!c || !c.vu_le) continue
    if (plusAncien === null || c.vu_le < plusAncien) plusAncien = c.vu_le
  }
  return plusAncien || horlogeDuCompte || null
}

module.exports = {
  fraicheurDuBien,
  echecVisibleParLHote,
  releverLesComptesDus,
  BUDGET_MS,
  COMPTES_MAX,
  rafraichirCanauxDuCompte,
  noterLeReleve,
  lireCanauxDuPartenaire,
  lignesDeLaLecture,
  comptesARelever,
  tarifsDuBienDe,
  normaliserOta,
  AGE_MAX_MS
}
