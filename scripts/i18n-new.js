#!/usr/bin/env node
/* Crée une nouvelle langue pré-remplie avec les clés françaises et l'ajoute à langues.json.
   Usage : node scripts/i18n-new.js it "Italiano" [rtl]
   Ensuite : traduire les valeurs (première passe Haiku possible via api/grok.js), relire, commit. */
const fs = require('fs');
const path = require('path');
const [code, nom, dir = 'ltr'] = process.argv.slice(2);
if (!code || !nom) { console.error('Usage : node scripts/i18n-new.js <code> "<Nom>" [ltr|rtl]'); process.exit(1); }
const base = path.join(__dirname, '..', 'shared', 'i18n');
const target = path.join(base, `${code}.json`);
if (fs.existsSync(target)) { console.error(`${code}.json existe déjà`); process.exit(1); }
const fr = JSON.parse(fs.readFileSync(path.join(base, 'fr.json'), 'utf8'));
// Valeurs françaises conservées : le fichier marche tout de suite (repli) et chaque ligne est à traduire.
fs.writeFileSync(target, JSON.stringify(fr, null, 2) + '\n');
const list = JSON.parse(fs.readFileSync(path.join(base, 'langues.json'), 'utf8'));
list.push({ code, nom, dir });
fs.writeFileSync(path.join(base, 'langues.json'), JSON.stringify(list, null, 2) + '\n');
console.log(`✓ ${code}.json créé (${Object.keys(fr).length} clés à traduire) · « ${nom} » ajouté au sélecteur`);
