// shared/messages-programmes.js — LES MESSAGES PROGRAMMÉS, UNE SEULE RÈGLE.
//
// Constantes du volet « Messages programmés » de /messages (recette 2 du
// changement de périmètre GuestFlow, 12 octobre 2026), REPRISES À L'IDENTIQUE
// de l'ancienne app templates (apps/agent-ai/messages.html) : mêmes
// événements, mêmes délais, mêmes défauts — le test de parité
// (tests/messages-v5.test.js) et le script de vérification sur données
// réelles (scripts/verifier-parite-templates.js) comparent CE module à
// l'ancienne page, champ par champ. Une divergence ici perdrait une valeur
// en base à la première sauvegarde (un select ne garde que ses options).

export const EVENEMENTS_PROGRAMMES = {
  booking_confirmed: { type: 'apres', reference: 'booking', send_anyway: false, delais: ['5min', '15min', '1h', '2h', '4h', '8h', '24h'] },
  arrival: { type: 'jours', reference: 'arrival', send_anyway: true },
  departure: { type: 'jours', reference: 'departure', send_anyway: true },
  menage_done: { type: 'apres', reference: 'arrival', send_anyway: false, delais: ['0min', '10min', '30min', '1h', '2h'] }
}

// Changer l'evenement REINITIALISE le moment — la regle exacte de
// updateEventType de l'ancienne app (sans elle, un offset null de l'ancien
// type etait sauve pendant que l'ecran montrait la premiere option — releve
// en review de 49c6ad4).
export function reinitialiserMoment (t) {
  const ev = EVENEMENTS_PROGRAMMES[t.event_type]
  t.reference = referenceDe(t.event_type)
  t.offset_days = 0
  t.offset_value = (ev && ev.delais && ev.delais[0]) || null
  t.send_time = '10:00'
  t.earliest_send_time = '15:00'
  t.send_anyway = !!(ev && ev.send_anyway)
}

export const JOURS_PROGRAMMES = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7]

export const HEURES_PROGRAMMES = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00')

// Les défauts du bouton « Nouveau », ceux de l'ancienne app à l'identique.
export const DEFAUTS_NOUVEAU_PROGRAMME = {
  event_type: 'arrival', reference: 'arrival',
  offset_days: -1, offset_value: null, send_time: '10:00',
  earliest_send_time: '15:00', send_anyway: true,
  active: true, template_text: '', lock_id: null
}

// La reference derivee de l'evenement — le mapping EXACT de l'ancienne page.
export function referenceDe (eventType) {
  return eventType === 'departure' ? 'departure'
    : eventType === 'booking_confirmed' ? 'booking' : 'arrival'
}

// « J-1 » / « Jour J » / « J+2 » — la forme de l'ancienne page.
export function libelleJour (n, jourJ) {
  return n === 0 ? jourJ : n > 0 ? `J+${n}` : `J${n}`
}

// « 10:00 » -> « 10h », comme l'ancienne page.
export function libelleHeure (h) {
  return String(h || '').replace(':00', 'h')
}

// « 5min » -> « 5 min apres », « 1h » -> « 1h apres », « 0min » ->
// « Immediatement » — les libelles EXACTS de l'ancienne page (pas d'espace
// avant le h), textes traduits passes par l'appelant.
export function libelleDelai (v, textes) {
  if (v === '0min') return textes.immediatement
  return String(v).replace('min', ' min') + ' ' + textes.apres
}

// Un template REEL est-il representable par les listes du volet ? Toute
// valeur hors liste serait PERDUE a la premiere sauvegarde : le script de
// parite refuse avant la mise en service.
export function ecartsDeRepresentation (t) {
  const ecarts = []
  const ev = EVENEMENTS_PROGRAMMES[t.event_type]
  if (!ev) { ecarts.push(`event_type inconnu : ${t.event_type}`); return ecarts }
  if (ev.type === 'apres') {
    if (t.offset_value != null && !ev.delais.includes(t.offset_value)) ecarts.push(`offset_value hors liste : ${t.offset_value}`)
  } else {
    if (t.offset_days != null && !JOURS_PROGRAMMES.includes(t.offset_days)) ecarts.push(`offset_days hors liste : ${t.offset_days}`)
    if (t.send_time != null && !HEURES_PROGRAMMES.includes(t.send_time)) ecarts.push(`send_time hors liste : ${t.send_time}`)
  }
  if (t.earliest_send_time != null && !HEURES_PROGRAMMES.includes(t.earliest_send_time)) {
    ecarts.push(`earliest_send_time hors liste : ${t.earliest_send_time}`)
  }
  return ecarts
}
