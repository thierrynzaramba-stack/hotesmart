// lib/channel-availability.js
// DOC : docs/specs/spec-audit-stop-sell.md (modif = MEME COMMIT)
//
// Push availability d'un bien "whole" vers le channel, AVEC idempotence (anti-doublon
// webhook+poll). Claim atomique fenetre glissante 60s via RPC claim_availability_push.
// White-label : variables CHANNEL_* (jamais CHANNEX_*).
//
// ⚠ ECRIRE LA DISPONIBILITE LEVE LE STOP-SELL (mesure du 7 septembre 2026 en
// production). Un POST /availability qui ne porte que le stock remet stop_sell a
// false sur les dates touchees : quatre nuits d'un bien volontairement ferme sont
// redevenues vendables sur Airbnb et Booking.com. Toute poussee de stock doit donc
// RESTITUER l'intention memorisee — c'est `reaffirmerStopSell` ci-dessous, et ce
// n'est pas optionnel.

const { createClient } = require('@supabase/supabase-js')
const { reportIncident } = require('./founder-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Regroupe les dates consecutives de meme valeur en plages (Channex prefere les
// plages). Meme forme que `coalesceRanges` de channel-fullsync : une copie locale
// et minuscule vaut mieux qu'une dependance croisee entre modules du cron.
const suivantISO = (d) => {
  const x = new Date(d + 'T00:00:00Z')
  x.setUTCDate(x.getUTCDate() + 1)
  return x.toISOString().slice(0, 10)
}

function plagesParValeur (lignes) {
  const out = []
  let cur = null
  for (const l of lignes) {
    if (cur && cur.stop_sell === l.stop_sell && suivantISO(cur.date_to) === l.date) cur.date_to = l.date
    else { if (cur) out.push(cur); cur = { stop_sell: l.stop_sell, date_from: l.date, date_to: l.date } }
  }
  if (cur) out.push(cur)
  return out
}

// RESTITUE l'intention commerciale memorisee sur les dates qu'on vient d'ecrire.
//
// La source est `calendar_inventory` — la MEMOIRE, jamais l'etat du provider :
// relire Channex pour savoir ce que l'hote veut, ce serait prendre la consequence
// pour la cause, et heriter de l'ecart qu'on essaie justement de corriger.
//
// `datesLimite` (Set, optionnel) restreint la restitution aux dates reellement
// touchees. Sans lui, un segment « tous les samedis sur deux mois » ferait pousser
// l'intention sur les ~60 dates de l'intervalle pour 8 editees : sur le fond c'est
// correct — la memoire fait foi — mais c'est large, et non teste. On restitue ce
// qu'on a touche.
async function reaffirmerStopSell (owner, providerPropertyId, dateFrom, dateTo, tag, datesLimite = null) {
  const memoire = async () => {
    const { data, error } = await supabase
      .from('calendar_inventory')
      .select('date, stop_sell')
      .eq('property_id', owner.id)                 // ⚠ UUID de `properties`, jamais le propId provider
      .gte('date', dateFrom).lte('date', dateTo)
      .order('date', { ascending: true })
    return { data, error }
  }

  // ⚠ Bien sans rate_plan : le stock est DEJA parti, et on ne peut plus rien
  // restituer. Se contenter d'un log serait le silence exact que le reste de
  // cette fonction refuse — on regarde donc d'abord si une fermeture est en jeu.
  if (!owner.id || !owner.provider_rate_plan_id) {
    console.error(`[${tag}] stop_sell NON reaffirme : bien sans id ou sans rate_plan`, providerPropertyId)
    if (!owner.id) return
    const { data } = await memoire()
    if ((data || []).some(l => l.stop_sell === true)) {
      await reportIncident('stop_sell_perdu', {
        userId: owner.user_id, propertyId: providerPropertyId,
        detail: `Bien sans rate_plan : le stock est parti sur ${dateFrom} → ${dateTo} mais le stop-sell n'a pas pu etre restitue. Des dates fermees sont VENDABLES.`
      })
    }
    return
  }

  const { data, error } = await memoire()

  // ⚠ Une erreur de lecture ne vaut PAS « rien a restituer » : c'est exactement le
  // cas ou l'on rouvrirait des dates fermees sans le savoir.
  if (error) {
    console.error(`[${tag}] memoire d'intention illisible`, error.message)
    await reportIncident('stop_sell_perdu', {
      userId: owner.user_id, propertyId: providerPropertyId,
      detail: `Memoire d'intention illisible sur ${dateFrom} → ${dateTo} : ${error.message}. Le stock a ete pousse, le stop-sell n'a PAS pu etre restitue.`
    })
    return
  }

  // ⚠ `stop_sell = NULL` N'EST PAS `false`. Une ligne creee par une simple edition
  // de tarif (api/calendar.js n'ecrit alors que property_id + date) ne porte AUCUNE
  // decision. La pousser en `false` inventerait une intention — exactement ce que
  // le cas « pas de ligne du tout » interdit deja, et de quoi rouvrir un bien ferme
  // hors HoteSmart au premier changement de prix.
  const lignes = (data || [])
    .filter(l => l.stop_sell != null)
    .filter(l => !datesLimite || datesLimite.has(l.date))
  if (!lignes.length) return   // aucune intention memorisee : rien a restituer

  const plages = plagesParValeur(lignes)
  const values = plages.map(p => ({
    property_id: providerPropertyId,
    rate_plan_id: owner.provider_rate_plan_id,
    date_from: p.date_from, date_to: p.date_to,
    stop_sell: !!p.stop_sell
  }))

  const r = await channelCall('POST', '/restrictions', { values })
  const fermees = plages.filter(p => p.stop_sell)
  if (!r.ok) {
    console.error(`[${tag}] reaffirmation stop_sell echec`, r.status, r.json)
    if (fermees.length) {
      await reportIncident('stop_sell_perdu', {
        userId: owner.user_id, propertyId: providerPropertyId,
        detail: `HTTP ${r.status} en reaffirmant le stop-sell sur ${fermees.map(p => p.date_from + '→' + p.date_to).join(', ')}. Ces dates sont VENDABLES alors qu'elles ne doivent pas l'etre.`
      })
    }
    return
  }
  console.log(`[${tag}] stop_sell restitue`, values.length, 'plage(s)', dateFrom, '->', dateTo)

  // ⚠ PAS DE RELECTURE IMMEDIATE, ET C'EST UN CHOIX.
  // Le POST ARI rend un ID DE TACHE : Channex applique en differe. Un GET lance
  // dans la foulee lit donc l'etat d'AVANT et crierait « stop-sell perdu » a
  // chaque fermeture legitime — une alerte fondateur par heure qui, par
  // l'anti-spam, masquerait la vraie le jour ou elle arrive. Une verification qui
  // crie a tort ne verifie rien.
  // La verification existe, mais elle est DELIBEREE et hors chemin chaud :
  // `node scripts/audit-stop-sell.js` compare la memoire au provider, bien par
  // bien, sur 500 jours et en plages de 100 — a jouer apres tout changement
  // d'inventaire de grande ampleur.
}

// Pousse l'availability SSI aucun push identique (property+dates+availability) dans
// les 60 dernieres secondes. Le claim est atomique cote Postgres (RPC) -> immunise
// contre la course webhook+poll a quelques ms.
async function pushAvailabilityOnce(owner, providerPropertyId, arrival, departure, available, tag = 'channel') {
  if (owner.inventory_type !== 'whole') return
  if (!owner.provider_room_type_id || !arrival || !departure) return

  // derniere nuit = veille du depart (nuit de depart non occupee)
  const lastNight = new Date(departure)
  lastNight.setDate(lastNight.getDate() - 1)
  const dateTo = lastNight.toISOString().split('T')[0]
  if (dateTo < arrival) return   // sejour 0 nuit

  const roomTypeId = owner.provider_room_type_id

  // Claim atomique fenetre glissante. true = on gagne le push ; false = doublon recent.
  const { data: won, error: rpcErr } = await supabase.rpc('claim_availability_push', {
    p_property: String(providerPropertyId),
    p_room: String(roomTypeId),
    p_from: arrival,
    p_to: dateTo,
    p_avail: available
    // p_window_s : defaut 60s cote SQL
  })

  if (rpcErr) {
    // FAIL-OPEN : rpc en erreur (ex. fonction absente, perms) -> on POUSSE quand meme.
    // Mieux vaut un doublon possible qu'une dispo desynchronisee chez le channel.
    console.error(`[${tag}] availability dedup rpc error -> fail-open push`, rpcErr.message)
  } else if (won === false) {
    console.log(`[${tag}] availability dedup skip`, available, arrival, '->', dateTo, providerPropertyId)
    return
  }

  const r = await channelCall('POST', '/availability', {
    values: [{ property_id: providerPropertyId, room_type_id: roomTypeId, date_from: arrival, date_to: dateTo, availability: available }]
  })
  if (!r.ok) console.error(`[${tag}] pushAvailability echec`, r.status, r.json)
  else console.log(`[${tag}] dispo`, available, arrival, '->', dateTo, providerPropertyId)

  // La reaffirmation suit la TENTATIVE, pas le succes : `fetch` peut echouer apres
  // que le serveur a traite l'ecriture, et un stop-sell leve sans qu'on le sache
  // est precisement l'incident du 7 septembre. Restituer deux fois ne coute rien.
  //
  // ⚠ ET ELLE NE DOIT JAMAIS FAIRE TOMBER L'APPELANT. Sur le chemin du cron,
  // `pollChannelFeed` acke la revision APRES ce retour : une panne reseau ici
  // interromprait le poll, la revision serait rejouee toutes les 5 minutes et le
  // reste de la page ne serait jamais traite. La restitution est une garantie de
  // meilleur effort ; l'avancement du feed ne lui est pas subordonne.
  try {
    await reaffirmerStopSell(owner, providerPropertyId, arrival, dateTo, tag)
  } catch (e) {
    console.error(`[${tag}] reaffirmation stop_sell : exception`, e.message)
  }
}

// Purge des traces > 10 min (fenetre 60s -> 10 min = large marge).
async function purgeAvailabilityPushLog() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { error } = await supabase.from('availability_push_log').delete().lt('pushed_at', cutoff)
  if (error) console.error('[channel-availability] purge error', error.message)
}

module.exports = { pushAvailabilityOnce, purgeAvailabilityPushLog, reaffirmerStopSell, plagesParValeur }
