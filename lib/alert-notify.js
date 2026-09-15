// ⚠️ DOC : comportement documenté dans docs/kb/alertes.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce kb (MÊME COMMIT).
// lib/alert-notify.js
// Module interne — appelé depuis api/cron.js
// const { sendAlertNotifications } = require('../lib/alert-notify')

const { createClient } = require('@supabase/supabase-js');
const { sendSms }      = require('../api/sms');
const { sendPlatformEmail } = require('./platform-notify');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PROPERTY_NAMES = {
  '169567': 'Cœur de vie 23',
  '209413': 'La bulle'
};

/**
 * Envoie les alertes SMS pour une nouvelle tâche agent
 */
// Retourne { emailSent } : true si AU MOINS un email a ete envoye via la config de
// l'hote. Permet a l'appelant de decider d'un fallback (ex. email du compte).
async function sendAlertNotifications({ type, task, propertyId }) {
  const propertyName = PROPERTY_NAMES[propertyId] || `Logement ${propertyId}`;
  let emailSent = false;

  // 1. Charger la config alertes
  const { data, error } = await supabase
    .from('agent_alert_config')
    .select('config')
    .eq('user_id', task.user_id)
    .single();

  if (error || !data?.config) {
    console.log(`[alert-notify] Pas de config alertes pour user ${task.user_id}`);
    return { emailSent };
  }

  const alertConfig = data.config?.[propertyId]?.[type];
  if (!alertConfig) {
    console.log(`[alert-notify] Pas de config pour ${propertyId}/${type}`);
    return { emailSent };
  }

  // 2. SMS — clé Brevo de l'hôte (multi-tenant). Parser les lignes "Nom : +336XXXXXXXX".
  if (alertConfig.sms_enabled && alertConfig.sms_lines) {
    const numbers = parseLines(alertConfig.sms_lines, 'sms');
    if (numbers.length > 0) {
      const message = buildSmsMessage({ type, task, propertyName });
      for (const { value } of numbers) {
        console.log(`[alert-notify] Envoi SMS → ${value}`);
        await sendSms(value, message, propertyId, 'agent-ai', task.user_id);
      }
    }
  }

  // 3. EMAIL — canal UNIVERSEL via la clé plateforme (ALERT_BREVO_API_KEY), pas la clé
  // de l'hôte : tout hôte peut recevoir des alertes email même sans compte Brevo.
  if (alertConfig.email_enabled && alertConfig.email_lines) {
    const emails = parseLines(alertConfig.email_lines, 'email');
    if (emails.length > 0) {
      const subject = `HôteSmart — ${type === 'intervention' ? 'Intervention' : 'Info manquante'} — ${propertyName}`;
      const html = buildEmailHtml({ type, task, propertyName });
      for (const { value } of emails) {
        console.log(`[alert-notify] Envoi email → ${value}`);
        const r = await sendPlatformEmail(value, subject, html);
        if (r.ok) emailSent = true;
        else console.error(`[alert-notify] email echec → ${value}: ${r.error}`);
      }
    }
  }

  return { emailSent };
}

function buildEmailHtml({ type, task, propertyName }) {
  const label = type === 'intervention' ? 'Intervention requise' : 'Information manquante';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let html = `<h2>HôteSmart — ${esc(label)}</h2><p><strong>${esc(propertyName)}</strong></p>`;
  if (task.guest_phone) html += `<p>Téléphone voyageur : ${esc(task.guest_phone)}</p>`;
  if (task.arrival)     html += `<p>Séjour : ${esc(formatDate(task.arrival))} → ${esc(formatDate(task.departure))}</p>`;
  if (task.summary)     html += `<p>${esc(task.summary)}</p>`;
  return html;
}

/**
 * Parse les lignes du format "Nom : valeur" ou "valeur"
 * Retourne un tableau de { name, value }
 */
function parseLines(lines, type) {
  return (lines || '').split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const sep = line.indexOf(':')
      if (sep > 0 && sep < line.length - 1) {
        return { name: line.slice(0, sep).trim(), value: line.slice(sep + 1).trim() }
      }
      return { name: '', value: line.trim() }
    })
    .filter(({ value }) => {
      if (type === 'sms')   return /^\+?[0-9]{7,15}$/.test(value.replace(/\s/g, ''))
      if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      return true
    });
}

/**
 * Construit le texte du SMS
 */
function buildSmsMessage({ type, task, propertyName }) {
  const emoji = type === 'intervention' ? '⚡' : '❓';
  const label = type === 'intervention' ? 'INTERVENTION' : 'INFO MANQUANTE';

  let msg = `${emoji} HôteSmart - ${label}\n`;
  msg += `${propertyName}\n`;
  if (task.guest_phone) msg += `Tél : ${task.guest_phone}\n`;
  if (task.arrival)     msg += `Séjour : ${formatDate(task.arrival)} → ${formatDate(task.departure)}\n`;
  if (task.summary)     msg += `\n${task.summary.slice(0, 100)}`;

  return msg;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

// ─── Alerte : code d'accès Seam indisponible ────────────────────────────────
// Le PIN n'a pas été généré (async igloohome) → message d'arrivée RETENU.
// Double canal pour garantir la visibilité chez un hôte beta :
//   1. tâche in-app agent_tasks (TOUJOURS visible, ne dépend d'aucune config)
//   2. SMS via sendAlertNotifications (si l'hôte a configuré agent_alert_config)
// Dédup sur agent_tasks (marqueur guest_message) pour ne pas re-alerter à chaque
// tick cron pendant que le PIN se résout.
async function alertMissingAccessCode({ userId, propertyId, booking }) {
  const bookingId  = String(booking.id);
  const MARKER     = "[AUTO: code d'accès manquant]";

  const { data: existing } = await supabase
    .from('agent_tasks')
    .select('id')
    .eq('user_id', userId)
    .eq('book_id', bookingId)
    .eq('guest_message', MARKER)
    .maybeSingle();
  if (existing) return false; // déjà alerté pour ce booking

  const guestName    = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur';
  const propertyName = PROPERTY_NAMES[propertyId] || `Logement ${propertyId}`;
  const arrivalTxt   = booking.arrival ? `, arrivée ${booking.arrival}` : '';
  const summary = `Code d'accès indisponible pour ${guestName} (${propertyName}${arrivalTxt}). Le PIN n'a pas été généré par la serrure — le message d'arrivée est retenu. Transmettez le code manuellement ou vérifiez la serrure.`;

  // 1. Tâche in-app (task_type 'auto_message' = valeur connue ; marqueur dans guest_message)
  await supabase.from('agent_tasks').insert({
    user_id: userId,
    property_id: String(propertyId),
    book_id: bookingId,
    guest_name: guestName,
    guest_message: MARKER,
    task_type: 'auto_message',
    summary,
    suggested_reply: '',
    status: 'pending_validation',
    sub_tasks: []
  });

  // 2. SMS + email best-effort via la config alertes de l'hôte.
  let notif = { emailSent: false };
  try {
    notif = await sendAlertNotifications({
      type: 'intervention',
      propertyId: String(propertyId),
      task: {
        user_id: userId,
        guest_phone: booking.guest_phone || booking.phone || null,
        arrival: booking.arrival || null,
        departure: booking.departure || null,
        summary
      }
    }) || { emailSent: false };
  } catch (e) {
    console.error('[alert-notify] alerte code manquant (config) échec:', e.message);
  }

  // 3. FALLBACK email au TITULAIRE DU COMPTE — UNIQUEMENT si la config n'a envoyé aucun
  // email (ex. bien sans alertes configurées). Garantit que l'hôte est toujours prévenu
  // par email, sans doublon quand la config a déjà envoyé.
  if (!notif.emailSent) {
    try {
      const { data: u } = await supabase.auth.admin.getUserById(userId);
      const email = u?.user?.email;
      if (email) {
        const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const html = `<h2>HôteSmart — Code d'accès indisponible</h2><p><strong>${esc(propertyName)}</strong></p><p>${esc(summary)}</p>`;
        const r = await sendPlatformEmail(email, `HôteSmart — Code d'accès indisponible — ${propertyName}`, html);
        if (r.ok) console.log(`[alert-notify] fallback email compte → ${email}`);
        else console.error(`[alert-notify] fallback email compte échec → ${email}: ${r.error}`);
      }
    } catch (e) {
      console.error('[alert-notify] fallback email compte erreur:', e.message);
    }
  }

  console.log(`[alert-notify] ALERTE code manquant booking ${bookingId} (${propertyName})`);
  return true;
}

// ─── Alerte : menage refuse par une prestataire ─────────────────────────────
// ⚠ POURQUOI UNE TACHE IN-APP ET PAS `reportIncident`.
// `reportIncident` (lib/founder-notify.js) alerte le FONDATEUR, pas l'hote —
// docs/kb/alertes.md le dit en clair : « canal plateforme/fondateur, a ne pas
// exposer aux hotes ». Un refus de menage doit remonter a l'HOTE : c'est lui qui
// doit confier le menage a quelqu'un d'autre, et personne ne prend le relais
// automatiquement (l'escalade reste reportee, spec §3 bis).
//
// Meme double canal que `alertMissingAccessCode` :
//   1. tache in-app `agent_tasks` — TOUJOURS visible, ne depend d'aucune config ;
//   2. SMS/email best-effort si l'hote a configure `agent_alert_config`.
// Dedup par (bien, reservation, date) : un refus n'alerte qu'une fois.
async function alertMenageRefuse({ userId, propertyId, bookingId, departureDate, prenom }) {
  const MARKER = `[AUTO: menage refuse ${departureDate}]`;

  const { data: existing } = await supabase
    .from('agent_tasks')
    .select('id')
    .eq('user_id', userId)
    .eq('book_id', String(bookingId))
    .eq('guest_message', MARKER)
    .maybeSingle();
  if (existing) return false;

  const propertyName = PROPERTY_NAMES[propertyId] || `Logement ${propertyId}`;
  const summary = `${prenom || 'La prestataire'} ne peut pas faire le ménage du ${formatDate(departureDate)} (${propertyName}). Personne n'est assigné : confiez-le à quelqu'un d'autre depuis l'app Ménages, en cliquant sur le ménage.`;

  await supabase.from('agent_tasks').insert({
    user_id: userId,
    property_id: String(propertyId),
    book_id: String(bookingId),
    guest_name: prenom || 'Prestataire',
    guest_message: MARKER,
    task_type: 'auto_message',
    summary,
    suggested_reply: '',
    status: 'pending_validation',
    sub_tasks: []
  });

  try {
    await sendAlertNotifications({
      type: 'intervention',
      propertyId: String(propertyId),
      task: { user_id: userId, arrival: null, departure: departureDate, summary }
    });
  } catch (e) {
    console.error('[alert-notify] alerte refus best-effort echec:', e.message);
  }
  return true;
}

// ⚠ ELLE A CHANGE SES JOURS DEPUIS SA PWA, ET L'HOTE DOIT L'APPRENDRE.
// Pendant obligatoire de la decision du 15 septembre 2026 : en lui donnant la
// main sur ses jours habituels, on lui a donne les moyens de se retirer d'un
// jour sur lequel l'hote compte. Sans ce message, il ne l'apprenait qu'au
// premier menage non fait.
//
// ⚠ MEME CANAL QUE LE REFUS D'UN MENAGE (`alertMenageRefuse`) : une ligne dans
// ses taches, qui RESTE, plus l'envoi configure, qui peut se rater. Les deux,
// parce qu'un SMS non lu ne doit pas effacer l'information.
async function alertReglesModifiees({ userId, providerId, propertyId, prenom, texte,
                                      menagesRepris = [] }) {
  // ⚠ UN SEUL MESSAGE PAR PERSONNE ET PAR JOUR. Elle coche ses jours un par un :
  // cinq cases produisent cinq ecritures a quelques secondes d'intervalle, donc
  // cinq alertes pour un seul changement. L'hote apprendrait a les ignorer — et
  // c'est precisement le message qu'il ne faut pas apprendre a ignorer.
  // Le marqueur porte le JOUR : le lendemain, un nouveau changement se dit.
  const jour = new Date().toISOString().slice(0, 10);
  const MARKER = `[AUTO: regles modifiees ${providerId} ${jour}]`;

  const { data: existing } = await supabase
    .from('agent_tasks')
    .select('id, summary')
    .eq('user_id', userId)
    .eq('guest_message', MARKER)
    .maybeSingle();

  const detail = menagesRepris.length
    ? ' ' + menagesRepris.length + ' ménage(s) qui lui étaient proposés ont été repris ' +
      'et vont être réattribués : ' +
      menagesRepris.slice(0, 5).map(m => formatDate(m.depart)).join(', ') +
      (menagesRepris.length > 5 ? '…' : '') + '.'
    : '';
  // ⚠ CE QU'ON NE DIT PAS EST AUSSI IMPORTANT : les menages qu'elle a ACCEPTES
  // ne bougent pas. Le taire laisserait croire qu'ils ont ete repris aussi.
  const rassurance = ' Les ménages qu\'elle a déjà acceptés ne sont pas touchés.';
  const summary = texte + detail + rassurance;

  if (existing) {
    // Le changement du jour s'AGREGE plutot que de se dupliquer : l'hote lit le
    // dernier etat, pas cinq messages successifs.
    await supabase.from('agent_tasks').update({ summary, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    return false;
  }

  await supabase.from('agent_tasks').insert({
    user_id: userId,
    property_id: propertyId == null ? null : String(propertyId),
    book_id: null,
    guest_name: prenom || 'Prestataire',
    guest_message: MARKER,
    task_type: 'auto_message',
    summary,
    suggested_reply: '',
    status: 'pending_validation',
    sub_tasks: []
  });

  // ⚠ SANS BIEN, PAS D'ENVOI — et c'est une limite connue, pas un oubli.
  // `sendAlertNotifications` lit la configuration d'alerte PAR BIEN. La ligne de
  // tache, elle, est posee dans tous les cas : l'information ne se perd pas,
  // elle attend qu'il ouvre son ecran.
  if (propertyId != null) {
    try {
      await sendAlertNotifications({
        type: 'intervention',
        propertyId: String(propertyId),
        task: { user_id: userId, arrival: null, departure: null, summary }
      });
    } catch (e) {
      console.error('[alert-notify] alerte regles best-effort echec:', e.message);
    }
  }
  return true;
}

module.exports = { sendAlertNotifications, parseLines, alertMissingAccessCode, alertMenageRefuse,
                   alertReglesModifiees };
