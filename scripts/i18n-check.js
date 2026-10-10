#!/usr/bin/env node
/* Compare chaque langue au français et liste les clés manquantes ou en trop.
   Usage : node scripts/i18n-check.js   (code de sortie 1 si une clé manque) */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'shared', 'i18n');
const langues = JSON.parse(fs.readFileSync(path.join(dir, 'langues.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8'));
const refKeys = Object.keys(ref);
let ko = false;
for (const { code } of langues) {
  if (code === 'fr') continue;
  const file = path.join(dir, `${code}.json`);
  if (!fs.existsSync(file)) { console.error(`✗ ${code}.json absent`); ko = true; continue; }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = refKeys.filter(k => !(k in d));
  const extra = Object.keys(d).filter(k => !(k in ref));
  if (missing.length) { ko = true; console.error(`✗ ${code} : ${missing.length} clé(s) manquante(s)\n   ${missing.join('\n   ')}`); }
  if (extra.length) console.warn(`! ${code} : ${extra.length} clé(s) en trop\n   ${extra.join('\n   ')}`);
  if (!missing.length && !extra.length) console.log(`✓ ${code} : ${refKeys.length} clés`);
}
process.exit(ko ? 1 : 0);
