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
  for (let page = 1; page <= PAGES_MAX; page++) {
    const r = await appel('GET', `/channels?pagination[page]=${page}&pagination[limit]=${PAS}`)
    // ⚠ UN ECHEC NE REND PAS UNE LISTE VIDE. Rendre `[]` ici ferait passer un
    // partenaire muet pour un compte sans canal — et le writer effacerait tout.
    if (!r || !r.ok) {
      return { ok: false, http: r ? r.status : 0, canaux: [] }
    }
    const lot = Array.isArray(r.json && r.json.data) ? r.json.data : []
    canaux.push(...lot)
    const total = Number(r.json && r.json.meta && r.json.meta.total)
    if (lot.length < PAS) break
    if (Number.isFinite(total) && canaux.length >= total) break
  }
  return { ok: true, http: 200, canaux }
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
    const rattaches = Array.isArray(at.properties) ? at.properties : []
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
async function rafraichirCanauxDuCompte ({ userId, maintenant = new Date(),
                                           sb = null, appel = channelCall } = {}) {
  const bilan = { ok: false, ecrits: 0, disparus: 0, erreur: null }
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

    const lu = await lireCanauxDuPartenaire({ appel })
    // ⚠ LE PARTENAIRE MUET N'EFFACE RIEN. On n'ecrit pas, on ne pose aucun
    // `disparu_le`, et `vu_le` garde sa valeur : l'ecran continue d'afficher
    // les canaux connus avec « verifie il y a … ». UN SILENCE N'EST PAS UNE
    // DISPARITION.
    if (!lu.ok) {
      bilan.erreur = `partenaire injoignable (http ${lu.http})`
      console.error('[canaux-du-bien] releve abandonne :', bilan.erreur)
      return bilan
    }

    const lignes = lignesDeLaLecture({
      canaux: lu.canaux, biens, liensParBien, liensLisibles, maintenant })

    if (lignes.length) {
      const { error: eU } = await base.from('canaux_du_bien')
        .upsert(lignes, { onConflict: 'user_id,property_id,provider_channel_id' })
      if (eU) { bilan.erreur = 'ecriture impossible : ' + eU.message; return bilan }
      bilan.ecrits = lignes.length
    }

    // Les lignes du compte qu'une lecture REUSSIE n'a plus vues.
    const vus = new Set(lignes.map(l => `${l.property_id}|${l.provider_channel_id}`))
    const { data: existantes, error: eE } = await base.from('canaux_du_bien')
      .select('id, property_id, provider_channel_id')
      .eq('user_id', userId).is('disparu_le', null)
    if (eE) { bilan.erreur = 'relecture impossible : ' + eE.message; bilan.ok = true; return bilan }
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
  const aRelever = []
  for (const u of comptes) {
    const { data: recent } = await base.from('canaux_du_bien')
      .select('vu_le').eq('user_id', u).gt('vu_le', seuil).limit(1)
    if (!recent || !recent.length) aRelever.push(u)
    if (aRelever.length >= limite) break
  }
  return aRelever
}

module.exports = {
  rafraichirCanauxDuCompte,
  lireCanauxDuPartenaire,
  lignesDeLaLecture,
  comptesARelever,
  tarifsDuBienDe,
  normaliserOta,
  AGE_MAX_MS
}
