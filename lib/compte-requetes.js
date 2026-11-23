// lib/compte-requetes.js — le nombre de requetes Supabase d'UNE requete d'ecran.
//
// Sert l'en-tete `Server-Timing` d'un endpoint d'ecran (point 7 de la case
// performance : « un budget sans test est un voeu », et un budget sans mesure
// en production aussi). Les autres ecrans annoncent un compte TENU A LA MAIN
// (`requetes++` a cote de chaque lecture) ; celui-ci reutilise des lectures
// ecrites ailleurs (`api/avis.js`), qu'on ne peut pas instrumenter une a une
// sans les reecrire. On compte donc au niveau de `fetch`, la ou toute requete
// Supabase passe : supabase-js resout `fetch` A L'APPEL, pas a la creation du
// client — une enveloppe posee apres coup voit donc les clients deja crees.
//
// ⚠ LE COMPTE EST PAR REQUETE D'ECRAN, PAS PAR INSTANCE. Une instance de
// fonction peut servir plusieurs requetes en meme temps ; un compteur global
// melangerait leurs lectures. `AsyncLocalStorage` rattache chaque `fetch` a la
// requete qui l'a lance, y compris a travers `Promise.all`.
//
// ⚠ ELLE NE DOIT JAMAIS CASSER UN APPEL (meme regle que lib/metriques-cron.js) :
// le comptage est sous `try`, et la valeur rendue est celle du vrai `fetch`.
// ⚠ ET ELLE NE S'EMPILE PAS : la chaine des enveloppes (`__hs_vrai`, la cle
// que pose aussi le compteur du cron) est remontee avant d'en poser une.

const { AsyncLocalStorage } = require('node:async_hooks')

const stockage = new AsyncLocalStorage()
const MARQUE = '__hs_compte_requetes'

function dejaPose (f) {
  for (let n = 0; typeof f === 'function' && n < 20; n++) {
    if (f[MARQUE]) return true
    f = f.__hs_vrai
  }
  return false
}

// Une requete Supabase est une requete vers SUPABASE_URL. Lu a chaque appel :
// les tests posent la variable apres le chargement du module.
function versSupabase (cible) {
  const base = process.env.SUPABASE_URL
  if (!base) return false
  const url = typeof cible === 'string' ? cible : (cible && (cible.url || cible.href)) || ''
  return String(url).startsWith(base)
}

function poser () {
  if (typeof globalThis.fetch !== 'function') return false
  if (dejaPose(globalThis.fetch)) return true
  const vrai = globalThis.fetch
  const enveloppe = function (...args) {
    try {
      const compteur = stockage.getStore()
      if (compteur && versSupabase(args[0])) compteur.n++
    } catch { /* un compteur ne casse pas un appel */ }
    return vrai.apply(this, args)
  }
  enveloppe[MARQUE] = true
  enveloppe.__hs_vrai = vrai
  globalThis.fetch = enveloppe
  return true
}

/**
 * Execute `fn` en comptant les requetes Supabase qu'elle lance.
 * @returns {Promise<{ resultat: any, requetes: number }>}
 */
async function compterRequetes (fn) {
  poser()
  const compteur = { n: 0 }
  const resultat = await stockage.run(compteur, fn)
  return { resultat, requetes: compteur.n }
}

// Le compte de la requete en cours, LU AVANT DE REPONDRE : un en-tete se pose
// avant `res.json`, donc avant que `compterRequetes` n'ait rendu son total.
// Hors d'une requete comptee : `null`.
function requetesJusquIci () {
  const compteur = stockage.getStore()
  return compteur ? compteur.n : null
}

module.exports = { compterRequetes, requetesJusquIci, _interne: { poser, dejaPose, versSupabase, MARQUE } }
