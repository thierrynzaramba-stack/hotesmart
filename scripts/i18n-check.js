#!/usr/bin/env node
/* Compare chaque langue au français et liste les clés manquantes ou en trop,
   et REFUSE une clé déclarée deux fois dans le même fichier.
   Usage : node scripts/i18n-check.js   (code de sortie 1 si une clé manque ou double) */
const fs = require('fs');
const path = require('path');

/* ⚠ POURQUOI ON NE PEUT PAS DEMANDER ÇA À `JSON.parse`. Devant
   `{"a":1,"a":2}` il ne lève pas : il garde la DERNIÈRE et rend `{a:2}`. Une
   clé déclarée deux fois est donc invisible de tout contrôle qui parse — et
   celui-ci parsait. Les deux moitiés d'un doublon vivent en général dans deux
   sections différentes du fichier, posées par deux lots : la traduction qui
   gagne est celle du bas, et ce n'est pas forcément celle que son auteur lit à
   l'écran. Il faut donc lire le TEXTE, pas l'objet. */
function lireLesCles (texte) {
  const cles = [];            // toutes les OCCURRENCES, dans l'ordre du fichier
  const doublons = [];        // celles qui redisent une clé du même objet
  const ecartees = new Set(); // celles que `JSON.parse` jette : voir plus bas
  const pile = [];
  let i = 0;
  while (i < texte.length) {
    const c = texte[i];
    if (c === '"') {
      let j = i + 1, brut = '';
      while (j < texte.length && texte[j] !== '"') {
        if (texte[j] === '\\') { brut += texte[j] + (texte[j + 1] || ''); j += 2; continue; }
        brut += texte[j]; j++;
      }
      if (j >= texte.length) throw new Error('chaîne non terminée');
      const valeur = JSON.parse('"' + brut + '"');
      let k = j + 1;
      while (k < texte.length && ' \t\r\n'.includes(texte[k])) k++;
      const cadre = pile[pile.length - 1];
      /* une chaîne est une CLÉ si elle est directement dans un objet et qu'un
         `:` la suit — ce qui écarte les valeurs, y compris celles qui
         contiennent elles-mêmes des guillemets ou des deux-points */
      if (cadre && cadre.objet && texte[k] === ':') {
        const rang = cles.length;
        if (cadre.rangs.has(valeur)) {
          doublons.push(cadre.prefixe.concat(valeur).join('.'));
          /* ⚠ `JSON.parse` garde la DERNIÈRE : la précédente occurrence est
             jetée, ET TOUT CE QUI PENDAIT À ELLE. On ne peut pas retrouver ce
             sous-arbre en comparant des chaînes de chemin — une clé plate peut
             contenir un point (`nav.today`), donc `a.x` n'est pas forcément
             un enfant de `a`. On se sert donc de la STRUCTURE : chaque clé
             porte la plage d'indices que sa valeur a produite. */
          const vieux = cadre.rangs.get(valeur);
          ecartees.add(vieux);
          for (let n = vieux + 1; n < (cles[vieux].fin ?? vieux + 1); n++) ecartees.add(n);
        }
        cadre.rangs.set(valeur, rang);
        cadre.dernierRang = rang;
        cles.push({ chemin: cadre.prefixe.concat(valeur).join('.'), fin: null });
        cadre.cle = valeur;
      }
      i = j + 1; continue;
    }
    if (c === '{' || c === '[') {
      const p = pile[pile.length - 1];
      const prefixe = !p ? [] : (p.objet && p.cle !== null ? p.prefixe.concat(p.cle) : p.prefixe);
      /* la clé qui introduit ce conteneur, pour lui refermer sa plage à la sortie */
      const rangParent = p && p.objet ? p.dernierRang : (p ? p.rangParent : null);
      pile.push({ objet: c === '{', rangs: new Map(), cle: null, prefixe, dernierRang: null, rangParent });
      i++; continue;
    }
    if (c === '}' || c === ']') {
      const f = pile.pop();
      if (f && f.rangParent !== null && f.rangParent !== undefined) cles[f.rangParent].fin = cles.length;
      i++; continue;
    }
    i++;
  }
  return {
    cles: cles.map(e => e.chemin),
    doublons,
    /* ce qu'il reste après que `JSON.parse` a tranché */
    retenues: cles.filter((e, n) => !ecartees.has(n)).map(e => e.chemin)
  };
}

/* le nombre de clés que `JSON.parse` a réellement retenues, à tous les étages */
function compterLesCles (v) {
  if (!v || typeof v !== 'object') return 0;
  if (Array.isArray(v)) return v.reduce((n, e) => n + compterLesCles(e), 0);
  return Object.keys(v).reduce((n, k) => n + 1 + compterLesCles(v[k]), 0);
}

/* ⚠ UN LECTEUR QUI N'A RIEN VU DOIT ÉCHOUER, PAS RENDRE « AUCUN DOUBLON ».
   On confronte donc le lecteur de texte à `JSON.parse` : hors doublons, les
   deux doivent compter le même nombre de clés. Si une forme de fichier sort de
   la portée du lecteur, le contrôle le dit au lieu de donner un vert. */
function doublonsDuFichier (texte, lecteur = lireLesCles) {
  const lu = lecteur(texte);
  if (!lu || !Array.isArray(lu.retenues)) throw new Error('le lecteur ne rend pas `retenues`');
  const retenues = lu.retenues;
  const attendu = compterLesCles(JSON.parse(texte));
  if (retenues.length !== attendu) {
    throw new Error(`le lecteur a vu ${retenues.length} clé(s) distincte(s) là où JSON.parse en compte ${attendu}`);
  }
  return lu.doublons;
}

function controler (dir) {
  const langues = JSON.parse(fs.readFileSync(path.join(dir, 'langues.json'), 'utf8'));
  const texteRef = fs.readFileSync(path.join(dir, 'fr.json'), 'utf8');
  const ref = JSON.parse(texteRef);
  const refKeys = Object.keys(ref);
  let ko = false;
  for (const { code } of langues) {
    const file = path.join(dir, `${code}.json`);
    if (!fs.existsSync(file)) { console.error(`✗ ${code}.json absent`); ko = true; continue; }
    const texte = code === 'fr' ? texteRef : fs.readFileSync(file, 'utf8');
    let doubles;
    try { doubles = doublonsDuFichier(texte); }
    catch (e) { console.error(`✗ ${code} : illisible — ${e.message}`); ko = true; continue; }
    if (doubles.length) {
      ko = true;
      console.error(`✗ ${code} : ${doubles.length} clé(s) EN DOUBLE\n   ${doubles.join('\n   ')}`);
    }
    if (code === 'fr') { if (!doubles.length) console.log(`✓ fr : ${refKeys.length} clés (référence)`); continue; }
    const d = JSON.parse(texte);
    const missing = refKeys.filter(k => !(k in d));
    const extra = Object.keys(d).filter(k => !(k in ref));
    if (missing.length) { ko = true; console.error(`✗ ${code} : ${missing.length} clé(s) manquante(s)\n   ${missing.join('\n   ')}`); }
    if (extra.length) console.warn(`! ${code} : ${extra.length} clé(s) en trop\n   ${extra.join('\n   ')}`);
    if (!missing.length && !extra.length && !doubles.length) console.log(`✓ ${code} : ${refKeys.length} clés`);
  }
  return ko;
}

module.exports = { lireLesCles, compterLesCles, doublonsDuFichier, controler };

if (require.main === module) {
  process.exit(controler(path.join(__dirname, '..', 'shared', 'i18n')) ? 1 : 0);
}
