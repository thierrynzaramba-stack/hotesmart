// lib/i18n-version.js — le moteur i18n servi avec l'empreinte des dictionnaires
// DEPLOYES. Servi par api/i18n.js a l'adresse /shared/i18n/i18n.js.
//
// ⚠ POURQUOI. Les dictionnaires sont caches UN AN (`vercel.json`), et c'est
// l'empreinte, posee dans leur URL (`fr.json?v=<empreinte>`), qui les
// invalide. Elle etait ecrite a la main dans shared/i18n/i18n.js : chaque lot
// qui touchait une traduction la changeait, donc deux lots paralleles
// entraient TOUJOURS en conflit sur cette ligne (decision de Thierry du
// 28 octobre 2026 : la calculer au deploiement). On la calcule ici, une fois
// par instance, sur les fichiers embarques avec la fonction — ceux-la memes
// que le site sert, puisqu'ils viennent du meme commit.
//
// ⚠ PUBLIC PAR NATURE : un dictionnaire ne porte aucune donnee de compte.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DOSSIER = path.join(__dirname, '..', 'shared', 'i18n')
// ⚠ TOUS LES .json DU DOSSIER, TRIES, ET PAS UNE LISTE ECRITE ICI (constat de
// review) : une langue ajoutee par scripts/i18n-new.js faisait bouger
// l'empreinte a sa creation (langues.json change), mais plus jamais ensuite —
// ses corrections seraient restees invisibles un an. Le tri fixe l'ordre : une
// empreinte qui dependrait de l'ordre de lecture du systeme de fichiers
// changerait sans qu'aucun fichier ne change.
// ⚠ C'EST LA FONCTION QUE `tests/i18n-version.test.js` APPLIQUAIT DEPUIS LE
// 22 OCTOBRE 2026 (en, es, fr, langues : le tri donne ce meme ordre, douze
// caracteres de sha256) : pour des dictionnaires inchanges, l'empreinte est
// la meme, et aucun navigateur ne retelecharge les dictionnaires au
// deploiement de ce changement.
function fichiers (dossier = DOSSIER) {
  return fs.readdirSync(dossier).filter(f => f.endsWith('.json')).sort()
}
const MODELE = path.join(DOSSIER, 'i18n.modele.js')
const JETON = "'__HS_I18N_VERSION__'"

// ⚠ UN DOSSIER INCOMPLET EST UNE ERREUR, PAS UNE EMPREINTE (constat de review
// du 5 novembre 2026). Sans ce controle, des dictionnaires absents du paquet de
// la fonction donnaient quand meme une empreinte valide — celle d'un dossier
// vide, `e3b0c44298fc`, la MEME a chaque deploiement : les dictionnaires
// restaient figes un an chez l'hote, servis en 200, sans aucun signal. C'est
// exactement le defaut que le calcul au deploiement existe pour fermer. On
// exige donc langues.json, le repli fr.json, et le dictionnaire de CHAQUE
// langue listee ; sinon on leve, et api/i18n.js rend un 500 visible.
const REPLI = 'fr'
function controler (dossier = DOSSIER, presents = fichiers(dossier)) {
  if (!presents.includes('langues.json')) throw new Error('dictionnaires i18n incomplets : langues.json absent')
  let codes
  try {
    codes = JSON.parse(fs.readFileSync(path.join(dossier, 'langues.json'), 'utf8')).map(l => l.code)
  } catch (e) {
    throw new Error(`dictionnaires i18n incomplets : langues.json illisible (${e.message})`)
  }
  const attendus = [...new Set([REPLI, ...codes])].map(c => `${c}.json`)
  const manquants = attendus.filter(f => !presents.includes(f))
  if (manquants.length) throw new Error(`dictionnaires i18n incomplets : ${manquants.join(', ')} absent(s)`)
}

function empreinte (dossier = DOSSIER) {
  const presents = fichiers(dossier)
  controler(dossier, presents)
  const h = crypto.createHash('sha256')
  for (const f of presents) h.update(fs.readFileSync(path.join(dossier, f)))
  return h.digest('hex').slice(0, 12)
}

// Le moteur tel que le navigateur le recoit.
function moteurI18n (version = empreinte(), modele = fs.readFileSync(MODELE, 'utf8')) {
  if (!/^[0-9a-f]{12}$/.test(String(version))) throw new Error(`empreinte i18n invalide : ${version}`)
  const n = modele.split(JETON).length - 1
  if (n !== 1) throw new Error(`i18n.modele.js : le jeton de version doit apparaitre une fois (${n})`)
  return modele.replace(JETON, JSON.stringify(version))
}

module.exports = { empreinte, controler, moteurI18n, fichiers, MODELE, JETON }
