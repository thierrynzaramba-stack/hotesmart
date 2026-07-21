// lib/alert-notify.js
// Module interne — appelé depuis api/cron.js
// const { sendAlertNotifications } = require('../lib/alert-notify')

const { createClient } = require('@supabase/supabase-js');
const { sendSms }      = require('../api/sms');

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
async function sendAlertNotifications({ type, task, propertyId }) {
  const propertyName = PROPERTY_NAMES[propertyId] || `Logement ${propertyId}`;

  // 1. Charger la config alertes
  const { data, error } = await supabase
    .from('agent_alert_config')
    .select('config')
    .eq('user_id', task.user_id)
    .single();

  if (error || !data?.config) {
    console.log(`[alert-notify] Pas de config alertes pour user ${task.user_id}`);
    return;
  }

  const alertConfig = data.config?.[propertyId]?.[type];
  if (!alertConfig) {
    console.log(`[alert-notify] Pas de config pour ${propertyId}/${type}`);
    return;
  }

  // 2. SMS — parser les lignes "Nom : +336XXXXXXXX"
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

  // 2. SMS best-effort (silencieux si l'hôte n'a pas configuré ses alertes)
  try {
    await sendAlertNotifications({
      type: 'intervention',
      propertyId: String(propertyId),
      task: {
        user_id: userId,
        guest_phone: booking.guest_phone || booking.phone || null,
        arrival: booking.arrival || null,
        departure: booking.departure || null,
        summary
      }
    });
  } catch (e) {
    console.error('[alert-notify] SMS code manquant échec:', e.message);
  }

  console.log(`[alert-notify] ALERTE code manquant booking ${bookingId} (${propertyName})`);
  return true;
}

module.exports = { sendAlertNotifications, parseLines, alertMissingAccessCode };
