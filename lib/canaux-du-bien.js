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
async function lireCanauxDuPartenaire ({ appel = channelCall } = {}) {
  const canaux = []
  // ⚠ `total` SE RETIENT, IL NE SE RELIT PAS (constat de la RE-revue de
  // b181192, et c'est la MEME faute que le constat bloquant d'avant, par une
  // autre porte). Un partenaire met souvent `meta.total` sur la PREMIERE page
  // seulement : relu a chaque tour, il redevenait indefini page 2, et la regle
  // « page courte sans total » concluait a la fin de liste. Mesure de la
  // revue : 20 canaux lus sur 25 annonces, et cinq `disparu_le` ecrits.
  let totalAnnonce = null
  for (let page = 1; page <= PAGES_MAX; page++) {
    const r = await appel('GET', `/channels?pagination[page]=${page}&pagination[limit]=${PAS}`)
    // ⚠ UN ECHEC NE REND PAS UNE LISTE VIDE. Rendre `[]` ici ferait passer un
    // partenaire muet pour un compte sans canal — et le writer effacerait tout.
    if (!r || !r.ok) {
      return { ok: false, motif: 'injoignable', http: r ? r.status : 0, canaux: [] }
    }
    const lot = Array.isArray(r.json && r.json.data) ? r.json.data : []
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
  const { error } = await base.from('canaux_releve')
    .upsert(ligne, { onConflict: 'user_id' })
  if (error) console.error('[canaux-du-bien] horloge non posee :', error.message)
}

async function rafraichirCanauxDuCompte (options = {}) {
  const { userId, maintenant = new Date(), sb = null } = options
  const bilan = await releverUnCompte(options)
  // ⚠ MEME QUAND LE RELEVE ECHOUE. C'est tout l'interet : sans horloge, un
  // partenaire en panne se fait marteler toutes les cinq minutes.
  // ⚠ L'HORLOGE EXISTE POUR NE PAS MARTELER LE PARTENAIRE : elle ne se pose
  // donc QUE si on lui a parle. Un hoquet de notre propre base — `biens
  // illisibles` — suspendait le releve du compte pendant une heure pour une
  // panne qui n'etait pas la sienne (constat de la RE-revue de b181192).
  if (userId && bilan.aParle) {
    try { await noterLeReleve(sb || supabaseDefaut(), userId, maintenant, bilan) }
    catch (e) { console.error('[canaux-du-bien] horloge :', e.message) }
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

async function releverUnCompte ({ userId, maintenant = new Date(),
                                  sb = null, appel = channelCall } = {}) {
  const bilan = { ok: false, partiel: false, aParle: false, motif: null,
                  ecrits: 0, disparus: 0, erreur: null }
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
    const lu = await lireCanauxDuPartenaire({ appel })
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

module.exports = {
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
