// ⚠️ DOC : comportement documenté dans docs/kb/alertes.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
// lib/cron-alerting.js — Surveillance périodique (appelée par le cron).
//
// Un seul scan des messages IA/auto sortants de la dernière heure, agrégé deux fois :
//   - par BIEN        -> volume anormal (bloc 3) : alerte fondateur si > ALERT_VOLUME_THRESHOLD
//   - par CONVERSATION -> coupe-circuit (bloc 4) : si > CIRCUIT_BREAKER_THRESHOLD, le bien
//                         passe AUTOMATIQUEMENT en automation_paused + alerte fondateur.
//
// Sonde distincte checkEventProduction() : surveille la PRODUCTION de menage_events
//   (le système, pas l'IA). Un producteur qui boucle (ex. faux "modified") échappe
//   à la surveillance messages. Alerte fondateur SEULE (aucune suspension d'écriture).
//
// messages.property_id = provider_property_id (clé du kill switch et de la config).

const { supabase } = require('./cron-shared')
const { reportIncident } = require('./founder-notify')

const VOLUME_THRESHOLD  = parseInt(process.env.ALERT_VOLUME_THRESHOLD || '10', 10)
const CIRCUIT_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '6', 10)
const EVENT_LOOP_THRESHOLD = parseInt(process.env.EVENT_LOOP_THRESHOLD || '20', 10)

// ─── Sonde générique de croissance des tables ────────────────────────────────
// Filet contre les boucles d'ECRITURE encore inconnues (leçons : 79 350
// menage_events accumulés sans signal ; message_sent_log qui gonflait avant que
// le coupe-circuit ne voie les messages). Observe et alerte SEULEMENT — aucune
// action automatique (ne coupe rien, ne suspend rien).
//
// { table: [colonne_temporelle, seuil_horaire_de_base] }. Map facilement
// extensible : support_conversations la rejoindra quand le chat support existera.
const GROWTH_WATCH = {
  menage_events:        ['created_at',  60],
  message_sent_log:     ['sent_at',     40],
  messages:             ['created_at', 100],
  agent_tasks:          ['created_at',  30],
  automation_incidents: ['created_at',  30],
  sms_logs:             ['created_at',  40],
  bookings_snapshot:    ['created_at',  80]
}
// ⚠️ SEUILS = POINT DE DÉPART calibré sur 2 biens (prod, juillet 2026), où les
// volumes normaux sont <10/jour/table. Volontairement larges : l'objectif est
// d'attraper un x10 (boucle d'écriture), pas de sonner un samedi chargé.
// À RECALIBRER quand la beta tournera avec plusieurs comptes (les volumes
// "normaux" monteront mécaniquement). Surcharge globale rapide via l'env
// TABLE_GROWTH_MULTIPLIER (ex. 2 = tous les seuils doublés) sans redéployer.
const TABLE_GROWTH_MULTIPLIER = Number(process.env.TABLE_GROWTH_MULTIPLIER) || 1

async function checkMessageVolume(results) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('messages')
    .select('user_id, property_id, booking_id')
    .in('sender', ['ai', 'auto'])
    .eq('direction', 'outbound')
    .gte('created_at', since)
  if (error) { console.error('[alerting] volume select echec:', error.message); return }
  if (!data?.length) return

  const perProp = new Map()   // property_id -> { userId, count }
  const perConv = new Map()   // property_id|booking_id -> { userId, propertyId, bookingId, count }
  for (const m of data) {
    if (!m.property_id) continue
    const pk = String(m.property_id)
    const p = perProp.get(pk) || { userId: m.user_id, count: 0 }
    p.count++; perProp.set(pk, p)
    if (m.booking_id) {
      const ck = pk + '|' + String(m.booking_id)
      const c = perConv.get(ck) || { userId: m.user_id, propertyId: pk, bookingId: String(m.booking_id), count: 0 }
      c.count++; perConv.set(ck, c)
    }
  }

  // ── Bloc 3 : volume anormal par bien ──────────────────────────────────────
  for (const [pid, { userId, count }] of perProp) {
    if (count > VOLUME_THRESHOLD) {
      await reportIncident('volume', {
        userId, propertyId: pid, threshold: 1,
        detail: `${count} messages IA/auto envoyés sur ce bien en 1h (seuil ${VOLUME_THRESHOLD}).`
      })
    }
  }

  // ── Bloc 4 : coupe-circuit par conversation ───────────────────────────────
  for (const [, c] of perConv) {
    if (c.count > CIRCUIT_THRESHOLD) {
      // Pause AUTOMATIQUE du bien. .eq('automation_paused', false) : on ne repasse
      // pas un bien déjà en pause -> l'alerte ne se déclenche qu'à la bascule réelle.
      const { data: upd, error: updErr } = await supabase
        .from('properties')
        .update({
          automation_paused: true,
          paused_at:         new Date().toISOString(),
          paused_reason:     'coupe-circuit auto : boucle conversation'
        })
        .eq('user_id', c.userId)
        .eq('provider_property_id', String(c.propertyId))
        .eq('automation_paused', false)
        .select('id')
      if (updErr) { console.error('[alerting] coupe-circuit pause echec:', updErr.message); continue }
      if (upd && upd.length) {
        results && (results.circuitBreakerTriggered = (results.circuitBreakerTriggered || 0) + 1)
        await reportIncident('circuit_breaker', {
          userId: c.userId, propertyId: c.propertyId, threshold: 1,
          detail: `${c.count} messages IA sur une même conversation (réservation ${c.bookingId}) en 1h (seuil ${CIRCUIT_THRESHOLD}). Bien mis en pause automatiquement.`
        })
      }
    }
  }
}

// ─── Sonde anti-boucle de PRODUCTION d'événements ménage ─────────────────────
// Un booking légitime génère 1 à 3 menage_events (new/modified/cancelled). Au-delà
// de EVENT_LOOP_THRESHOLD sur 24h, un producteur boucle (fausse "modification" en
// rafale, cf. bug snapshot null/0). Détection par booking, ALERTE AGRÉGÉE PAR BIEN
// (la boucle frappe tous les bookings du bien en même temps -> éviter la rafale
// d'alertes), déduplication 24h (garde-fou jour, pas heure). Alerte fondateur
// SEULE : pas de suspension automatique d'écriture (un 2e coupe-circuit à raisonner).
async function checkEventProduction() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('menage_events')
    .select('property_id, property_name, booking_id, user_id')
    .gte('created_at', since)
  if (error) { console.error('[alerting] event-loop select echec:', error.message); return }
  if (!data?.length) return

  // Comptage par (bien, booking).
  const perBooking = new Map()  // pid|bid -> { pid, name, userId, bid, count }
  for (const e of data) {
    if (!e.booking_id || !e.property_id) continue
    const pid = String(e.property_id)
    const k = pid + '|' + String(e.booking_id)
    const v = perBooking.get(k) || { pid, name: e.property_name, userId: e.user_id, bid: String(e.booking_id), count: 0 }
    v.count++; perBooking.set(k, v)
  }

  // Bookings au-delà du seuil, regroupés par bien.
  const perProp = new Map()  // pid -> { userId, name, offenders: [{ bid, count }] }
  for (const v of perBooking.values()) {
    if (v.count <= EVENT_LOOP_THRESHOLD) continue
    const p = perProp.get(v.pid) || { userId: v.userId, name: v.name, offenders: [] }
    p.offenders.push({ bid: v.bid, count: v.count }); perProp.set(v.pid, p)
  }
  if (!perProp.size) return

  for (const [pid, { userId, name, offenders }] of perProp) {
    // Déduplication 24h : pas de 2e alerte event_loop pour ce bien dans la journée.
    const { data: prior } = await supabase
      .from('automation_incidents')
      .select('id').eq('type', 'event_loop').eq('property_id', pid).eq('alerted', true)
      .gte('created_at', since).limit(1)
    if (prior && prior.length) continue

    const top = offenders.sort((a, b) => b.count - a.count).slice(0, 5)
      .map(o => `${o.bid} (${o.count})`).join(', ')
    await reportIncident('event_loop', {
      userId, propertyId: pid, propertyName: name, threshold: 1,
      detail: `${offenders.length} réservation(s) avec production anormale d'événements ménage en 24h (seuil ${EVENT_LOOP_THRESHOLD}). Top : ${top}. Probable boucle d'un producteur (cron-bookings / feed).`
    })
  }
}

// Scanne 1 fois/heure (le cron tourne */5) : compte les lignes créées sur la
// dernière heure dans chaque table surveillée. Dépassement -> alerte fondateur
// (type 'table_growth'), anti-spam 1 alerte / table / 6h. Aucune action auto.
// Marqueur du dernier passage : ligne cron_logs id='table_growth_probe'.
async function checkTableGrowth() {
  // Cadence horaire via marqueur (évite de scanner à chaque tick de 5 min).
  const { data: marker } = await supabase
    .from('cron_logs').select('last_run').eq('id', 'table_growth_probe').maybeSingle()
  if (marker?.last_run && (Date.now() - new Date(marker.last_run).getTime()) < 60 * 60 * 1000) return

  const sinceHour = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const since6h   = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

  for (const [table, [tcol, base]] of Object.entries(GROWTH_WATCH)) {
    const threshold = Math.round(base * TABLE_GROWTH_MULTIPLIER)
    try {
      const { count, error } = await supabase
        .from(table).select('*', { count: 'exact', head: true }).gte(tcol, sinceHour)
      if (error) { console.error(`[alerting] growth ${table} select echec:`, error.message); continue }
      if (count == null || count <= threshold) continue

      // Anti-spam : 1 alerte par table par 6h (property_id = nom de table sert de clé).
      const { data: prior } = await supabase
        .from('automation_incidents')
        .select('id').eq('type', 'table_growth').eq('property_id', table).eq('alerted', true)
        .gte('created_at', since6h).limit(1)
      if (prior && prior.length) continue

      await reportIncident('table_growth', {
        propertyId: table, propertyName: `table ${table}`, threshold: 1,
        detail: `Croissance anormale : ${count} lignes créées dans ${table} en 1h (seuil ${threshold}). Probable boucle d'écriture — à investiguer. Aucune action automatique déclenchée.`
      })
    } catch (e) {
      console.error(`[alerting] growth ${table} exception:`, e.message)
    }
  }

  // Marque le passage (fige la cadence horaire). total_messages/replies fournis
  // pour couvrir un éventuel NOT NULL du schéma cron_logs.
  await supabase.from('cron_logs').upsert({
    id: 'table_growth_probe', last_run: new Date().toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
}

module.exports = { checkMessageVolume, checkEventProduction, checkTableGrowth }
