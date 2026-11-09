// lib/notifications/textes.js — CE QUE DIT UNE NOTIFICATION, DANS LA LANGUE DE LA PERSONNE.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §7 et §16.2 · KB : docs/kb/pwa.md §10
//
// ⚠ LE BIEN ET LE PRÉNOM DU VOYAGEUR, JAMAIS LE TEXTE DE SON MESSAGE (spec §7) :
// la notification s'affiche sur un écran verrouillé, que n'importe qui peut lire.
// Aucune fonction d'ici ne reçoit de texte libre venu d'un voyageur.
//
// ⚠ TROIS LANGUES, et la même liste que le site (shared/i18n/langues.json). Une
// langue inconnue retombe sur le français ; un événement sans texte dans une
// langue retombe aussi sur le français — jamais sur un texte vide.
//
// Un texte rend { titre, corps } : le titre court (écran verrouillé), le corps
// d'une ou deux lignes. L'e-mail et le SMS sont construits À PARTIR de ces deux
// champs : une seule rédaction par événement et par langue.
const LANGUES = require('../../shared/i18n/langues.json').map(l => l.code)

function langueDe (langue) {
  return LANGUES.includes(langue) ? langue : 'fr'
}

// « 2026-12-24 » → « 24/12 » (fr, es) ou « 12/24 » (en). Un jour illisible est
// rendu tel quel : on préfère une date brute à une date fausse.
function jourCourt (jour, langue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(jour || ''))
  if (!m) return String(jour || '')
  return langue === 'en' ? `${m[2]}/${m[3]}` : `${m[3]}/${m[2]}`
}

function listeDeJours (jours, langue, max = 4) {
  const l = (Array.isArray(jours) ? jours : []).map(j => jourCourt(j, langue))
  if (l.length <= max) return l.join(', ')
  const reste = l.length - max
  const suite = { fr: `et ${reste} autre(s)`, en: `and ${reste} more`, es: `y ${reste} más` }[langue]
  return `${l.slice(0, max).join(', ')} ${suite}`
}

// Le canal d'une réservation, tel que l'hôte le dit — par la règle du dépôt
// (lib/revenus/versement.js, `canalNormalise`), jamais par l'orthographe du
// partenaire (« BookingCom », « AirBNB », `abb`). `Offline` est le nom technique
// d'une réservation DIRECTE (saisie ou moteur) : jamais montré tel quel. Un canal
// que la règle ne connaît pas s'affiche tel quel, borné.
function canalLisible (source, langue) {
  const brut = String(source || '').trim()
  if (!brut) return ''
  const { canalNormalise } = require('../revenus/versement')
  const c = canalNormalise(brut)
  if (c === 'direct') return { fr: 'Direct', en: 'Direct', es: 'Directa' }[langue]
  if (c === 'airbnb') return 'Airbnb'
  if (c === 'booking') return 'Booking.com'
  return borne(brut, 30)
}

// Un texte saisi par un tiers (le prénom d'une réservation directe est tapé par
// un visiteur du moteur) : borné, pour qu'il ne prenne pas la notification ni le
// SMS en otage.
function borne (texte, max) {
  const t = String(texte == null ? '' : texte).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// Une période « du 12/03 au 15/03 » dans la langue.
function periode (arrivee, depart, langue) {
  const a = jourCourt(arrivee, langue)
  const d = jourCourt(depart, langue)
  if (!a) return ''
  if (!d) return { fr: `le ${a}`, en: `on ${a}`, es: `el ${a}` }[langue]
  return { fr: `du ${a} au ${d}`, en: `${a} to ${d}`, es: `del ${a} al ${d}` }[langue]
}

const VOYAGEUR = { fr: 'Un voyageur', en: 'A guest', es: 'Un huésped' }

// Le voyageur EN COURS DE PHRASE (« la conversation de Jean », « d’un
// voyageur ») : sans prénom, la forme indéfinie en minuscule ; en français,
// l'élision devant une voyelle (« d’Anne », jamais « de Anne »).
const UN_VOYAGEUR = { fr: 'un voyageur', en: 'a guest', es: 'un huésped' }
function tiers (d, langue) {
  return borne(d.prenom, 40) || UN_VOYAGEUR[langue]
}
function deTiers (d) {
  const t = tiers(d, 'fr')
  return /^[aeiouyàâäéèêëîïôöùûü]/i.test(t) ? `d’${t}` : `de ${t}`
}

// « Jean, du 12/12 au 15/12 » — et seulement ce qu'on sait : une annulation
// Channex arrive parfois sans dates ni voyageur (lib/booking-changes.js), et le
// texte ne doit jamais laisser un trou (« Un voyageur,  : … »).
function qui (d, langue, avecPeriode = true) {
  const p = avecPeriode ? periode(d.arrivee, d.depart, langue) : ''
  return [borne(d.prenom, 40) || VOYAGEUR[langue], p].filter(Boolean).join(', ')
}

// Ce qui a changé dans une réservation modifiée — les quatre champs du cœur
// (lib/booking-changes.js : arrivée, départ, adultes, enfants), jamais un montant
// ni un message.
function changements (c, langue) {
  const NOMS = {
    arrival: { fr: 'arrivée', en: 'arrival', es: 'llegada' },
    departure: { fr: 'départ', en: 'departure', es: 'salida' },
    numAdult: { fr: 'adultes', en: 'adults', es: 'adultos' },
    numChild: { fr: 'enfants', en: 'children', es: 'niños' }
  }
  const out = []
  for (const k of Object.keys(NOMS)) {
    const v = c && c[k]
    if (!v || typeof v !== 'object') continue
    const f = (x) => (k === 'arrival' || k === 'departure') ? jourCourt(x, langue) : String(x == null ? '—' : x)
    out.push(`${NOMS[k][langue]} ${f(v.before)} → ${f(v.after)}`)
  }
  return out.join(', ')
}

// ─── Les événements ─────────────────────────────────────────────────────────
// Le lot 2c-1 a rédigé la surréservation ; le lot 2c-2 rédige les autres, avec
// leur branchement. Les données de chaque texte sont dites au-dessus de lui.
const EVENEMENTS = {
  // donnees : { bien, prenom, arrivee, depart, canal }
  reservation: {
    fr: (d) => ({ titre: `Nouvelle réservation — ${d.bien}`, corps: `${qui(d, 'fr')}${d.canal ? ` · ${canalLisible(d.canal, 'fr')}` : ''}.` }),
    en: (d) => ({ titre: `New booking — ${d.bien}`, corps: `${qui(d, 'en')}${d.canal ? ` · ${canalLisible(d.canal, 'en')}` : ''}.` }),
    es: (d) => ({ titre: `Nueva reserva — ${d.bien}`, corps: `${qui(d, 'es')}${d.canal ? ` · ${canalLisible(d.canal, 'es')}` : ''}.` })
  },
  // donnees : { bien, prenom, arrivee, depart, annulation: bool, changements }
  annulation_modification: {
    fr: (d) => d.annulation
      ? { titre: `Annulation — ${d.bien}`, corps: `${qui(d, 'fr')} : réservation annulée.` }
      : { titre: `Réservation modifiée — ${d.bien}`, corps: `${changements(d.changements, 'fr') ? `${qui(d, 'fr', false)} : ${changements(d.changements, 'fr')}` : qui(d, 'fr')}.` },
    en: (d) => d.annulation
      ? { titre: `Cancellation — ${d.bien}`, corps: `${qui(d, 'en')}: booking cancelled.` }
      : { titre: `Booking changed — ${d.bien}`, corps: `${changements(d.changements, 'en') ? `${qui(d, 'en', false)}: ${changements(d.changements, 'en')}` : qui(d, 'en')}.` },
    es: (d) => d.annulation
      ? { titre: `Cancelación — ${d.bien}`, corps: `${qui(d, 'es')}: reserva cancelada.` }
      : { titre: `Reserva modificada — ${d.bien}`, corps: `${changements(d.changements, 'es') ? `${qui(d, 'es', false)}: ${changements(d.changements, 'es')}` : qui(d, 'es')}.` }
  },
  // donnees : { bien, prenom, arrivee }
  code_non_resolu: {
    fr: (d) => ({
      titre: `Code d’accès indisponible — ${d.bien}`,
      corps: `${qui(d, 'fr', false)}${d.arrivee ? `, arrivée le ${jourCourt(d.arrivee, 'fr')}` : ''} : le message d’arrivée est retenu. Transmettez le code vous-même, ou vérifiez la serrure.`
    }),
    en: (d) => ({
      titre: `Access code unavailable — ${d.bien}`,
      corps: `${qui(d, 'en', false)}${d.arrivee ? `, arriving ${jourCourt(d.arrivee, 'en')}` : ''}: the arrival message is on hold. Send the code yourself, or check the lock.`
    }),
    es: (d) => ({
      titre: `Código de acceso no disponible — ${d.bien}`,
      corps: `${qui(d, 'es', false)}${d.arrivee ? `, llegada el ${jourCourt(d.arrivee, 'es')}` : ''}: el mensaje de llegada está retenido. Envíe el código usted mismo o revise la cerradura.`
    })
  },
  // ─── Messages (lot 2c-2) ─────────────────────────────────────────────────
  // ⚠ LE BIEN ET LE PRÉNOM, JAMAIS LE TEXTE DU MESSAGE (spec §7, Q6) — ni celui
  // du voyageur, ni le résumé qu'en fait l'IA : l'écran verrouillé se lit par
  // dessus l'épaule.
  // donnees : { bien, prenom }
  urgence_ia: {
    fr: (d) => ({ titre: `Urgence — ${d.bien}`, corps: `${qui(d, 'fr', false)} : l’IA a détecté une urgence dans son message. Répondez-lui.` }),
    en: (d) => ({ titre: `Urgent — ${d.bien}`, corps: `${qui(d, 'en', false)}: the AI flagged an urgent message. Please reply.` }),
    es: (d) => ({ titre: `Urgencia — ${d.bien}`, corps: `${qui(d, 'es', false)}: la IA detectó un mensaje urgente. Respóndale.` })
  },
  // donnees : { bien, prenom, arret: bool } — `arret` : l'IA s'est arrêtée sur
  // ce fil (plafond d'appels), le voyageur attend une réponse à la main.
  info_manquante: {
    fr: (d) => ({ titre: `Information manquante — ${d.bien}`, corps: d.arret
      ? `L’IA s’est arrêtée sur la conversation ${deTiers(d)} : répondez-lui à la main.`
      : `${qui(d, 'fr', false)} pose une question à laquelle l’IA ne sait pas répondre.` }),
    en: (d) => ({ titre: `Missing information — ${d.bien}`, corps: d.arret
      ? `The AI stopped on the conversation with ${tiers(d, 'en')}: please reply manually.`
      : `${qui(d, 'en', false)} asked something the AI can’t answer.` }),
    es: (d) => ({ titre: `Falta información — ${d.bien}`, corps: d.arret
      ? `La IA se detuvo en la conversación con ${tiers(d, 'es')}: respóndale usted.`
      : `${qui(d, 'es', false)} hizo una pregunta que la IA no sabe responder.` })
  },
  // donnees : { bien, prenom, differe: bool, nonDelivree: bool }
  brouillon_ia: {
    fr: (d) => ({ titre: `Réponse à valider — ${d.bien}`, corps: d.nonDelivree
      ? `La réponse automatique à ${tiers(d, 'fr')} n’est pas partie : vérifiez-la et renvoyez-la.`
      : `L’IA a préparé une réponse pour ${tiers(d, 'fr')}.${d.differe ? ' Elle partira seule si vous ne faites rien.' : ''}` }),
    en: (d) => ({ titre: `Reply to approve — ${d.bien}`, corps: d.nonDelivree
      ? `The automatic reply to ${tiers(d, 'en')} was not delivered: check it and send it again.`
      : `The AI drafted a reply for ${tiers(d, 'en')}.${d.differe ? ' It will be sent automatically if you do nothing.' : ''}` }),
    es: (d) => ({ titre: `Respuesta por validar — ${d.bien}`, corps: d.nonDelivree
      ? `La respuesta automática a ${tiers(d, 'es')} no se envió: revísela y reenvíela.`
      : `La IA preparó una respuesta para ${tiers(d, 'es')}.${d.differe ? ' Se enviará sola si no hace nada.' : ''}` })
  },
  // donnees : { bien, prenom }
  message_voyageur: {
    fr: (d) => ({ titre: `Nouveau message ${deTiers(d)} — ${d.bien}`, corps: 'Ouvrez la conversation pour le lire et répondre.' }),
    en: (d) => ({ titre: `New message from ${tiers(d, 'en')} — ${d.bien}`, corps: 'Open the conversation to read it and reply.' }),
    es: (d) => ({ titre: `Nuevo mensaje de ${tiers(d, 'es')} — ${d.bien}`, corps: 'Abra la conversación para leerlo y responder.' })
  },
  // donnees : { bien }
  pause_automatique: {
    fr: (d) => ({ titre: `Réponses automatiques en pause — ${d.bien}`, corps: 'L’IA a envoyé trop de messages dans une même conversation : elle est en pause sur ce logement. Vérifiez la conversation, puis relancez-la.' }),
    en: (d) => ({ titre: `Automatic replies paused — ${d.bien}`, corps: 'The AI sent too many messages in one conversation, so it is paused for this property. Check the conversation, then turn it back on.' }),
    es: (d) => ({ titre: `Respuestas automáticas en pausa — ${d.bien}`, corps: 'La IA envió demasiados mensajes en una misma conversación: está en pausa en este alojamiento. Revise la conversación y vuelva a activarla.' })
  },
  // ─── Ménages (lot 2c-2) ──────────────────────────────────────────────────
  // `prestataire` : le prénom de la prestataire (borné) ; `jour` : la date du
  // ménage (YYYY-MM-DD).
  // donnees : { bien, jour }
  menage_sans_personne: {
    fr: (d) => ({ titre: `Ménage sans personne — ${d.bien}`, corps: `Ménage du ${jourCourt(d.jour, 'fr')} : personne n’est disponible pour le faire. Confiez-le à quelqu’un.` }),
    en: (d) => ({ titre: `Unassigned cleaning — ${d.bien}`, corps: `Cleaning on ${jourCourt(d.jour, 'en')}: nobody is available to do it. Assign it to someone.` }),
    es: (d) => ({ titre: `Limpieza sin asignar — ${d.bien}`, corps: `Limpieza del ${jourCourt(d.jour, 'es')}: nadie está disponible para hacerla. Asígnela a alguien.` })
  },
  // donnees : { bien, jour, prestataire }
  menage_pas_vu: {
    fr: (d) => ({ titre: `Ménage pas encore vu — ${d.bien}`, corps: `${borne(d.prestataire, 40) || 'La prestataire'} n’a pas encore vu le ménage du ${jourCourt(d.jour, 'fr')}.` }),
    en: (d) => ({ titre: `Cleaning not seen yet — ${d.bien}`, corps: `${borne(d.prestataire, 40) || 'The cleaner'} hasn’t seen the cleaning on ${jourCourt(d.jour, 'en')} yet.` }),
    es: (d) => ({ titre: `Limpieza aún no vista — ${d.bien}`, corps: `${borne(d.prestataire, 40) || 'La persona de limpieza'} aún no ha visto la limpieza del ${jourCourt(d.jour, 'es')}.` })
  },
  // donnees : { bien, jour, prestataire }
  menage_refuse: {
    fr: (d) => ({ titre: `Ménage refusé — ${d.bien}`, corps: `${borne(d.prestataire, 40) || 'La prestataire'} ne peut pas faire le ménage du ${jourCourt(d.jour, 'fr')}. Confiez-le à quelqu’un d’autre.` }),
    en: (d) => ({ titre: `Cleaning declined — ${d.bien}`, corps: `${borne(d.prestataire, 40) || 'The cleaner'} can’t do the cleaning on ${jourCourt(d.jour, 'en')}. Assign it to someone else.` }),
    es: (d) => ({ titre: `Limpieza rechazada — ${d.bien}`, corps: `${borne(d.prestataire, 40) || 'La persona de limpieza'} no puede hacer la limpieza del ${jourCourt(d.jour, 'es')}. Asígnela a otra persona.` })
  },
  // donnees : { prestataire } — ses disponibilités valent pour tous ses biens.
  disponibilites_modifiees: {
    fr: (d) => ({ titre: `Disponibilités de ${borne(d.prestataire, 40) || 'votre prestataire'}`, corps: 'Elle a modifié ses disponibilités. Vérifiez votre planning de garde.' }),
    en: (d) => ({ titre: `${borne(d.prestataire, 40) || 'Your cleaner'}’s availability`, corps: 'They changed their availability. Check your cleaning schedule.' }),
    es: (d) => ({ titre: `Disponibilidad de ${borne(d.prestataire, 40) || 'su persona de limpieza'}`, corps: 'Ha modificado su disponibilidad. Revise su calendario de limpiezas.' })
  },
  // donnees : { bien, nuits: ['YYYY-MM-DD'], relance: bool }
  surreservation: {
    fr: (d) => ({
      titre: `${d.relance ? 'Relance — ' : ''}Surréservation — ${d.bien}`,
      corps: `${(d.nuits || []).length} nuit(s) en conflit : ${listeDeJours(d.nuits, 'fr')}. Ouvrez HôteSmart pour arrêter cette alerte.`
    }),
    en: (d) => ({
      titre: `${d.relance ? 'Reminder — ' : ''}Overbooking — ${d.bien}`,
      corps: `${(d.nuits || []).length} night(s) in conflict: ${listeDeJours(d.nuits, 'en')}. Open HôteSmart to stop this alert.`
    }),
    es: (d) => ({
      titre: `${d.relance ? 'Recordatorio — ' : ''}Sobreventa — ${d.bien}`,
      corps: `${(d.nuits || []).length} noche(s) en conflicto: ${listeDeJours(d.nuits, 'es')}. Abra HôteSmart para detener esta alerta.`
    })
  }
}

/**
 * Le texte d'un événement, dans une langue. Rend `null` pour un événement sans
 * rédaction : l'appelant n'envoie alors rien (et le dit), plutôt qu'un vide.
 */
function rediger (code, langue, donnees = {}) {
  const e = EVENEMENTS[code]
  if (!e) return null
  const l = langueDe(langue)
  const f = e[l] || e.fr
  // Un bien dont on n'a pas su lire le nom se dit « votre logement », jamais
  // « null » ni un identifiant technique.
  const d = donnees || {}
  const t = f(d.bien ? d : { ...d, bien: BIEN_INCONNU[l] })
  // Un essai se dit comme tel : la personne ne doit jamais croire à une vraie
  // surréservation en recevant son essai.
  return donnees && donnees.essai ? { ...t, titre: `${ESSAI[l]} — ${t.titre}` } : t
}

const ESSAI = { fr: 'Essai', en: 'Test', es: 'Prueba' }
const BIEN_INCONNU = { fr: 'votre logement', en: 'your property', es: 'su alojamiento' }

// Les événements qui ont un texte (lots 2c-1 et 2c-2).
function rediges () {
  return Object.keys(EVENEMENTS)
}

// Les données d'un ESSAI (POST /api/push, `essai_evenement`) : un logement
// fictif, jamais un vrai bien ni un vrai voyageur.
function exemple (code, maintenant = Date.now()) {
  const jour = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
  const EXEMPLES = {
    surreservation: { bien: 'Logement d’essai', nuits: [jour(maintenant), jour(maintenant + 86400000)] },
    reservation: { bien: 'Logement d’essai', prenom: 'Camille', arrivee: jour(maintenant + 7 * 86400000), depart: jour(maintenant + 9 * 86400000), canal: 'Offline' },
    annulation_modification: { bien: 'Logement d’essai', prenom: 'Camille', arrivee: jour(maintenant + 7 * 86400000), depart: jour(maintenant + 9 * 86400000), annulation: true },
    code_non_resolu: { bien: 'Logement d’essai', prenom: 'Camille', arrivee: jour(maintenant) },
    urgence_ia: { bien: 'Logement d’essai', prenom: 'Camille' },
    info_manquante: { bien: 'Logement d’essai', prenom: 'Camille' },
    brouillon_ia: { bien: 'Logement d’essai', prenom: 'Camille', differe: true },
    message_voyageur: { bien: 'Logement d’essai', prenom: 'Camille' },
    pause_automatique: { bien: 'Logement d’essai' },
    menage_sans_personne: { bien: 'Logement d’essai', jour: jour(maintenant + 2 * 86400000) },
    menage_pas_vu: { bien: 'Logement d’essai', jour: jour(maintenant + 86400000), prestataire: 'Camille' },
    menage_refuse: { bien: 'Logement d’essai', jour: jour(maintenant + 3 * 86400000), prestataire: 'Camille' },
    disponibilites_modifiees: { prestataire: 'Camille' }
  }
  return EXEMPLES[code] ? { ...EXEMPLES[code], essai: true } : null
}

// ─── Le regroupement de fin de plage ────────────────────────────────────────
const REGROUPEMENT = {
  fr: (n) => `${n} alerte(s) pendant vos heures calmes`,
  en: (n) => `${n} alert(s) during your quiet hours`,
  es: (n) => `${n} alerta(s) durante sus horas tranquilas`
}

// Un seul message pour plusieurs notifications : le titre compte, le corps
// liste les titres (cinq au plus, puis « et N autres »).
function regrouper (langue, items) {
  const l = langueDe(langue)
  if (items.length === 1) return { titre: items[0].titre, corps: items[0].corps }
  const titres = items.map(i => i.titre)
  const max = 5
  const reste = titres.length - max
  const lignes = titres.slice(0, max)
  if (reste > 0) lignes.push({ fr: `et ${reste} autre(s)`, en: `and ${reste} more`, es: `y ${reste} más` }[l])
  return { titre: REGROUPEMENT[l](items.length), corps: lignes.join('\n') }
}

// ─── Le dernier appareil ────────────────────────────────────────────────────
// Décision Q13 : quand le dernier appareil abonné d'une personne disparaît
// (appli retirée, permission coupée), elle est prévenue par e-mail — sinon elle
// croit être prévenue alors qu'elle ne l'est plus.
const DERNIER_APPAREIL = {
  fr: {
    sujet: 'HôteSmart — vos notifications ne vous arrivent plus',
    texte: 'Aucun de vos appareils ne reçoit plus les notifications d’HôteSmart : l’application a été retirée ou l’autorisation coupée. Pour les retrouver, ouvrez HôteSmart, puis Réglages, Notifications, « Recevoir les notifications sur cet appareil ». En attendant, vos alertes vous arrivent par e-mail, et par SMS si vous l’avez coché.',
    lien: 'Ouvrir les réglages des notifications'
  },
  en: {
    sujet: 'HôteSmart — your notifications no longer reach you',
    texte: 'None of your devices receives HôteSmart notifications any more: the app was removed or the permission turned off. To get them back, open HôteSmart, then Settings, Notifications, “Receive notifications on this device”. Meanwhile, your alerts reach you by e-mail, and by text message if you ticked it.',
    lien: 'Open notification settings'
  },
  es: {
    sujet: 'HôteSmart — sus notificaciones ya no le llegan',
    texte: 'Ninguno de sus dispositivos recibe ya las notificaciones de HôteSmart: se quitó la aplicación o se desactivó el permiso. Para recuperarlas, abra HôteSmart, luego Ajustes, Notificaciones, «Recibir las notificaciones en este dispositivo». Mientras tanto, sus alertas le llegan por correo, y por SMS si lo marcó.',
    lien: 'Abrir los ajustes de notificaciones'
  }
}

const OUVRIR = { fr: 'Ouvrir HôteSmart', en: 'Open HôteSmart', es: 'Abrir HôteSmart' }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// L'adresse du site, comme lib/stripe-hote.js et api/booking-links.js la lisent :
// staging porte la sienne dans APP_URL (docs/STAGING.md), la production retombe
// sur son domaine.
function siteParDefaut () {
  return process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app'
}

// Le lien d'un e-mail : l'adresse du site et un CHEMIN du site. Un chemin qui
// n'en est pas un ne fait pas de lien plutôt qu'un lien faux.
function lienDuSite (site, chemin) {
  if (!site || typeof chemin !== 'string' || !chemin.startsWith('/') || chemin.startsWith('//')) return null
  return String(site).replace(/\/+$/, '') + chemin
}

// L'e-mail d'une notification (ou d'un regroupement) : tout passe par `esc`.
function email ({ langue, titre, corps, chemin, site = siteParDefaut() }) {
  const l = langueDe(langue)
  const lien = lienDuSite(site, chemin)
  const paragraphes = String(corps || '').split('\n').map(p => `<p>${esc(p)}</p>`).join('')
  return {
    sujet: `HôteSmart — ${titre}`.replace(/[\r\n]+/g, ' ').slice(0, 160),
    html: `<h3>${esc(titre)}</h3>${paragraphes}${lien ? `<p><a href="${esc(lien)}">${esc(OUVRIR[l])}</a></p>` : ''}`
  }
}

function emailDernierAppareil ({ langue, site = siteParDefaut() }) {
  const t = DERNIER_APPAREIL[langueDe(langue)]
  const lien = lienDuSite(site, '/settings?onglet=notifications')
  return {
    sujet: t.sujet,
    html: `<p>${esc(t.texte)}</p>${lien ? `<p><a href="${esc(lien)}">${esc(t.lien)}</a></p>` : ''}`
  }
}

// Le SMS : le titre et le corps, sur 300 caractères au plus.
function sms ({ titre, corps }) {
  return `HôteSmart — ${titre}\n${corps || ''}`.slice(0, 300)
}

module.exports = { LANGUES, langueDe, jourCourt, rediger, rediges, exemple, regrouper, email, emailDernierAppareil, sms }
