// api/alert-notify.js
// Envoie une notification SMS quand une tâche agent est créée
// Appelé depuis cron.js : await sendAlertNotifications({ type, task, propertyId, propertyName })

const { createClient } = require('@supabase/supabase-js');
const { sendSms }      = require('./sms');

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

  // 2. SMS
  if (alertConfig.sms_enabled && alertConfig.sms_numbers?.length > 0) {
    const message = buildSmsMessage({ type, task, propertyName });
    for (const number of alertConfig.sms_numbers) {
      console.log(`[alert-notify] Envoi SMS → ${number}`);
      await sendSms(number, message, propertyId, 'agent-ai');
    }
  }
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

module.exports = { sendAlertNotifications };
