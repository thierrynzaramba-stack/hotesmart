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

// Le canal d'une réservation, tel que l'hôte le dit. `Offline` est le nom
// technique d'une réservation DIRECTE (saisie ou moteur) : jamais montré tel quel.
function canalLisible (source, langue) {
  const s = String(source || '').trim()
  if (!s) return ''
  if (s.toLowerCase() === 'offline') return { fr: 'Direct', en: 'Direct', es: 'Directa' }[langue]
  return s
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
    fr: (d) => ({
      titre: `Nouvelle réservation — ${d.bien}`,
      corps: `${d.prenom || VOYAGEUR.fr}, ${periode(d.arrivee, d.depart, 'fr')}${d.canal ? ` · ${canalLisible(d.canal, 'fr')}` : ''}.`
    }),
    en: (d) => ({
      titre: `New booking — ${d.bien}`,
      corps: `${d.prenom || VOYAGEUR.en}, ${periode(d.arrivee, d.depart, 'en')}${d.canal ? ` · ${canalLisible(d.canal, 'en')}` : ''}.`
    }),
    es: (d) => ({
      titre: `Nueva reserva — ${d.bien}`,
      corps: `${d.prenom || VOYAGEUR.es}, ${periode(d.arrivee, d.depart, 'es')}${d.canal ? ` · ${canalLisible(d.canal, 'es')}` : ''}.`
    })
  },
  // donnees : { bien, prenom, arrivee, depart, annulation: bool, changements }
  annulation_modification: {
    fr: (d) => d.annulation
      ? { titre: `Annulation — ${d.bien}`, corps: `${d.prenom || VOYAGEUR.fr}, ${periode(d.arrivee, d.depart, 'fr')} : réservation annulée.` }
      : { titre: `Réservation modifiée — ${d.bien}`, corps: `${d.prenom || VOYAGEUR.fr} : ${changements(d.changements, 'fr') || periode(d.arrivee, d.depart, 'fr')}.` },
    en: (d) => d.annulation
      ? { titre: `Cancellation — ${d.bien}`, corps: `${d.prenom || VOYAGEUR.en}, ${periode(d.arrivee, d.depart, 'en')}: booking cancelled.` }
      : { titre: `Booking changed — ${d.bien}`, corps: `${d.prenom || VOYAGEUR.en}: ${changements(d.changements, 'en') || periode(d.arrivee, d.depart, 'en')}.` },
    es: (d) => d.annulation
      ? { titre: `Cancelación — ${d.bien}`, corps: `${d.prenom || VOYAGEUR.es}, ${periode(d.arrivee, d.depart, 'es')}: reserva cancelada.` }
      : { titre: `Reserva modificada — ${d.bien}`, corps: `${d.prenom || VOYAGEUR.es}: ${changements(d.changements, 'es') || periode(d.arrivee, d.depart, 'es')}.` }
  },
  // donnees : { bien, prenom, arrivee }
  code_non_resolu: {
    fr: (d) => ({
      titre: `Code d’accès indisponible — ${d.bien}`,
      corps: `${d.prenom || VOYAGEUR.fr}${d.arrivee ? `, arrivée le ${jourCourt(d.arrivee, 'fr')}` : ''} : le message d’arrivée est retenu. Transmettez le code vous-même, ou vérifiez la serrure.`
    }),
    en: (d) => ({
      titre: `Access code unavailable — ${d.bien}`,
      corps: `${d.prenom || VOYAGEUR.en}${d.arrivee ? `, arriving ${jourCourt(d.arrivee, 'en')}` : ''}: the arrival message is on hold. Send the code yourself, or check the lock.`
    }),
    es: (d) => ({
      titre: `Código de acceso no disponible — ${d.bien}`,
      corps: `${d.prenom || VOYAGEUR.es}${d.arrivee ? `, llegada el ${jourCourt(d.arrivee, 'es')}` : ''}: el mensaje de llegada está retenido. Envíe el código usted mismo o revise la cerradura.`
    })
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
  const t = f(donnees || {})
  // Un essai se dit comme tel : la personne ne doit jamais croire à une vraie
  // surréservation en recevant son essai.
  return donnees && donnees.essai ? { ...t, titre: `${ESSAI[l]} — ${t.titre}` } : t
}

const ESSAI = { fr: 'Essai', en: 'Test', es: 'Prueba' }

// Les événements qui ont un texte (le lot 2c-1 : la surréservation seule).
function rediges () {
  return Object.keys(EVENEMENTS)
}

// Les données d'un ESSAI (POST /api/push, `essai_evenement`) : un logement
// fictif, jamais un vrai bien ni un vrai voyageur.
function exemple (code, maintenant = Date.now()) {
  const jour = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
  const EXEMPLES = {
    surreservation: { bien: 'Logement d’essai', nuits: [jour(maintenant), jour(maintenant + 86400000)] }
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
