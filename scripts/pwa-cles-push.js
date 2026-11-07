#!/usr/bin/env node
// scripts/pwa-cles-push.js — poser les clés des notifications push dans Vercel.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §8 · KB : docs/kb/pwa.md §8
//
// À LANCER PAR THIERRY, SUR SON PC, UNE FOIS PAR PROJET (décision du
// 7 novembre 2026) : staging d'abord, la production ensuite, sur go.
//
//   node scripts/pwa-cles-push.js --projet hotesmart-staging --scope <equipe>        (à blanc)
//   node scripts/pwa-cles-push.js --projet hotesmart-staging --scope <equipe> --go
//   node scripts/pwa-cles-push.js --projet hotesmart --scope <equipe> --go
//
// Prérequis sur le PC : le dépôt à jour avec `npm install` fait (pour
// `web-push`), et la commande `vercel` connectée (`vercel login`).
// `--scope` est OBLIGATOIRE : depuis la CLI 55, `--yes` ne choisit plus
// d'équipe (constat de review), et un projet ambigu ne doit pas se deviner.
//
// Il génère une paire de clés (VAPID) et l'écrit DIRECTEMENT dans les variables
// de production du projet Vercel désigné, par la commande `vercel` déjà
// connectée sur ce PC : PUSH_VAPID_PUBLIC et PUSH_VAPID_PRIVATE.
//
// ⚠ LA CLÉ PRIVÉE EST UN SECRET : CE SCRIPT N'AFFICHE JAMAIS UNE VALEUR. Il dit
// le NOM de chaque variable et sa LONGUEUR, rien d'autre (CLAUDE.md, « un
// secret ne passe jamais par le terminal »). Les valeurs passent de la mémoire
// du script à l'entrée standard de `vercel env add`, sans fichier ni écran.
//
// ⚠ CHANGER DE CLÉ DÉSABONNE TOUT LE MONDE : chaque appareil devra se
// réabonner. Le script REFUSE donc d'écraser des clés déjà posées, sauf avec
// `--remplacer` — à réserver au cas où la clé privée aurait fui.
//
// Après l'écriture : les variables ne s'appliquent qu'au DÉPLOIEMENT SUIVANT.
// Le chef de file redéploie (« Create Deployment », pas « Redeploy »).
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROJETS = ['hotesmart', 'hotesmart-staging']
const NOMS = ['PUSH_VAPID_PUBLIC', 'PUSH_VAPID_PRIVATE']

function arg (nom) {
  const i = process.argv.indexOf(nom)
  return i >= 0 ? process.argv[i + 1] : null
}
const PROJET = arg('--projet')
const GO = process.argv.includes('--go')
const REMPLACER = process.argv.includes('--remplacer')
// L'équipe Vercel (son identifiant, visible dans l'adresse du tableau de bord).
const EQUIPE = arg('--scope')

// ⚠ ON LÈVE, ON NE QUITTE PAS (constat de review) : `process.exit()` dans le
// `try` sautait le `finally`, et le dossier temporaire lié au projet — où
// `vercel link` peut écrire un jeton — restait sur le PC.
class Arret extends Error {
  constructor (texte, code = 2) { super(texte); this.code = code }
}
function stop (texte, code = 2) { throw new Arret(texte, code) }

// `vercel` sans afficher sa sortie brute : elle pourrait un jour contenir une
// valeur. On ne rend que le code de sortie, et un texte EXPURGÉ des valeurs.
// `cwd` passe par l'option de `spawnSync`, pas par `--cwd` en argument : sous
// Windows (`shell: true`), un chemin avec une espace serait coupé en deux.
function vercel (args, { entree = null, cwd = null, masquer = [] } = {}) {
  const complets = [...args, ...(EQUIPE ? ['--scope', EQUIPE] : [])]
  const r = spawnSync('vercel', complets, {
    input: entree,
    encoding: 'utf8',
    cwd: cwd || undefined,
    shell: process.platform === 'win32'
  })
  let sortie = `${r.stdout || ''}\n${r.stderr || ''}`
  for (const v of masquer) if (v) sortie = sortie.split(v).join('[masqué]')
  return { code: r.status, sortie, erreur: r.error }
}

async function principal () {
  if (!PROJETS.includes(PROJET)) stop(`Précisez le projet : --projet ${PROJETS.join(' ou --projet ')}`)
  if (!EQUIPE || !/^[A-Za-z0-9_-]+$/.test(EQUIPE)) stop('Précisez l\'équipe Vercel : --scope <identifiant de l\'équipe> (visible dans l\'adresse du tableau de bord Vercel).')
  let webpush
  try { webpush = require('web-push') } catch { stop('Le module web-push manque : lancez `npm install` dans le dépôt, puis relancez.') }

  const version = vercel(['--version'])
  if (version.erreur || version.code !== 0) stop('La commande `vercel` est introuvable sur ce PC. Installez-la (npm i -g vercel), connectez-vous (vercel login), puis relancez.')
  const qui = vercel(['whoami'])
  if (qui.code !== 0) stop('`vercel` n\'est pas connecté. Lancez `vercel login`, puis relancez.')
  console.log(`Vercel : connecté. Projet visé : ${PROJET}${GO ? '' : ' (à blanc : rien ne sera écrit)'}`)

  // Un dossier temporaire, lié au projet visé : on ne touche pas au lien du
  // dépôt, et on ne peut pas écrire dans le mauvais projet par erreur.
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-cles-push-'))
  try {
    const lien = vercel(['link', '--yes', '--project', PROJET], { cwd: dossier })
    if (lien.code !== 0) stop(`Impossible de lier le projet ${PROJET}. Vérifiez son nom dans le tableau de bord Vercel.\n${lien.sortie.trim().slice(-400)}`)
    const lu = JSON.parse(fs.readFileSync(path.join(dossier, '.vercel', 'project.json'), 'utf8'))
    if (lu.projectName && lu.projectName !== PROJET) stop(`Lien inattendu : ${lu.projectName} au lieu de ${PROJET}. Rien n'est écrit.`)

    const liste = vercel(['env', 'ls', 'production'], { cwd: dossier })
    if (liste.code !== 0) stop(`Lecture des variables impossible.\n${liste.sortie.trim().slice(-400)}`)
    const presentes = NOMS.filter(n => new RegExp(`\\b${n}\\b`).test(liste.sortie))
    if (presentes.length && !REMPLACER) {
      stop(`Déjà posées sur ${PROJET} : ${presentes.join(', ')}. Rien n'est écrit.\n` +
        'Les remplacer désabonnerait TOUS les appareils. Seulement si la clé privée a fui : relancez avec --remplacer.')
    }
    if (!GO) {
      console.log(`À blanc : ${NOMS.join(' et ')} seraient écrites sur ${PROJET} (production). Relancez avec --go.`)
      return
    }

    const cles = webpush.generateVAPIDKeys()
    const valeurs = { PUSH_VAPID_PUBLIC: cles.publicKey, PUSH_VAPID_PRIVATE: cles.privateKey }
    const masquer = Object.values(valeurs)
    for (const nom of NOMS) {
      if (presentes.includes(nom)) {
        const rm = vercel(['env', 'rm', nom, 'production', '--yes'], { cwd: dossier, masquer })
        if (rm.code !== 0) stop(`Suppression de l'ancienne ${nom} impossible.\n${rm.sortie.trim().slice(-400)}`)
      }
      const ajout = vercel(['env', 'add', nom, 'production'], { cwd: dossier, entree: valeurs[nom], masquer })
      if (ajout.code !== 0) stop(`Écriture de ${nom} impossible.\n${ajout.sortie.trim().slice(-400)}`)
      console.log(`${nom} écrite (${valeurs[nom].length} caractères)`)
    }
    const verif = vercel(['env', 'ls', 'production'], { cwd: dossier, masquer })
    const manquantes = NOMS.filter(n => !new RegExp(`\\b${n}\\b`).test(verif.sortie))
    if (manquantes.length) stop(`Vérification : ${manquantes.join(', ')} absente(s) après écriture.`)
    console.log(`Vérifié : ${NOMS.join(' et ')} présentes sur ${PROJET}. Elles s'appliqueront au prochain déploiement.`)
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true })
  }
}

principal().catch(e => {
  console.error(e instanceof Arret ? e.message : `Erreur : ${e && e.message ? e.message : e}`)
  process.exit(e instanceof Arret ? e.code : 1)
})
