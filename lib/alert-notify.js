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
        await sendSms(value, message, propertyId, 'agent-ai');
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

module.exports = { sendAlertNotifications, parseLines };
