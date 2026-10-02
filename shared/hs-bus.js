// shared/hs-bus.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// LE PROTOCOLE UNIFIE ENTRE LES APPS ET LE COEUR.
// Spec : docs/specs/spec-evaluation-voyageur.md §2 bis.
//
// Une app (messagerie, planning, menage, PWA prestataire) ne connait NI les
// fichiers, NI les tables, NI les endpoints du coeur. Elle parle a ce bus, et a
// lui seul :
//   hsBus.disponible('avis.evaluer')                   -> afficher ou masquer un bouton
//   hsBus.ouvrir('avis.evaluer', { booking_uid })     -> une fenetre standard du coeur
//   hsBus.demander('avis.statut', { booking_uid })    -> une reponse du coeur
//   hsBus.ecouter('avis.evaluation_publiee', fn)      -> un evenement du coeur
//   hsBus.emettre('menages.fait', { ... })            -> un evenement pour les autres
//
// Le coeur declare ses actions dans un MANIFESTE par domaine (core/<domaine>/
// manifest.js). Le bus charge le module de l'action a la demande (import
// dynamique, meme origine : session et compte courant partages).
//
// ⚠ TROIS REPONSES POSSIBLES, JAMAIS UNE ERREUR VISIBLE. Action inconnue,
// droit absent, action « a venir », module manquant : le bus rend
// { ok: false, raison: 'indisponible' }, et l'app masque son bouton. Une app
// n'a pas a savoir POURQUOI le coeur ne repond pas — c'est le coeur qui le sait.
//
// ⚠ LE DROIT SE VERIFIE ICI POUR L'ECRAN, ET COTE SERVEUR POUR DE VRAI.
// `peutLire` / `peutEcrire` (shared/compte-courant.js) decident d'un bouton.
// Le serveur (lib/require-permission.js) decide de l'action. L'identite par
// JETON (PWA prestataire) ne passe pas par la session : le bus transmet le
// jeton au module du coeur, qui le fait valider par le serveur — jamais cru
// sur parole.
//
// Les dependances s'injectent (`creerBus`) : le bus se teste sans navigateur.
// L'instance par defaut, exportee `hsBus`, branche les vraies.

// Les domaines du coeur et leur manifeste. Le SEUL endroit du front partage
// qui connait un chemin du coeur.
const MANIFESTES = {
  avis: '/core/avis/manifest.js',
}

// Distinct du `hs:log` de shared/logger.js : deux contrats, deux prefixes.
export const PREFIXE_EVENEMENT = 'hsbus:'

const nomValide = (nom) => typeof nom === 'string' && /^[a-z_]+\.[a-z_]+$/.test(nom)

export function creerBus ({ manifestes = MANIFESTES, droits, importer, fenetre, cible } = {}) {
  const cache = new Map()   // domaine -> manifeste (ou null si introuvable)

  async function manifesteDe (domaine) {
    if (cache.has(domaine)) return cache.get(domaine)
    const chemin = manifestes[domaine]
    if (!chemin) { cache.set(domaine, null); return null }   // domaine inconnu : definitif
    try {
      const m = (await importer(chemin)).default || null
      if (m) cache.set(domaine, m)                          // un echec ne se met PAS en cache : on reessaie a l'appel suivant
      return m
    } catch (e) {
      console.warn('[hs-bus] manifeste injoignable', domaine, e && e.message)
      return null
    }
  }

  // L'entree d'une action, ou null.
  async function entreeDe (action) {
    if (typeof action !== 'string' || !action.includes('.')) return null
    const domaine = action.split('.')[0]
    const m = await manifesteDe(domaine)
    const e = m && m.actions && m.actions[action]
    return e || null
  }

  // Le droit d'une entree, pour l'ecran. `options.identite.jeton` designe un
  // porteur de lien (PWA) : la session ne compte pas, le serveur tranchera.
  function droitOk (entree, options) {
    if (entree.identite === 'jeton') return !!(options && options.identite && options.identite.jeton)
    const d = entree.droit
    if (!d) return true
    if (d.niveau === 'write') return !!droits.peutEcrire(d.domaine)
    return !!droits.peutLire(d.domaine)
  }

  async function resoudre (action, options) {
    const e = await entreeDe(action)
    if (!e || e.etat === 'a_venir' || !droitOk(e, options)) return null
    return e
  }

  const indisponible = () => ({ ok: false, raison: 'indisponible' })

  // Les parametres declares par le manifeste sont exiges. Un manque est une
  // ERREUR DE L'APP, pas un etat du coeur : reponse nommee, trace en console,
  // jamais une exception qui remonte a l'ecran.
  function parametresManquants (entree, params) {
    return (entree.params || []).filter(p => params == null || params[p] === undefined || params[p] === null || params[p] === '')
  }
  const parametreManquant = (action, manquants) => {
    console.error('[hs-bus]', action, 'parametre(s) manquant(s) :', manquants.join(', '))
    return { ok: false, raison: 'parametre_manquant', detail: manquants }
  }

  return {
    /** L'action peut-elle etre proposee a l'ecran ? */
    async disponible (action, options) {
      return !!(await resoudre(action, options))
    },

    /** Ouvre l'ecran du coeur pour cette action, dans la fenetre standard. */
    async ouvrir (action, params = {}, options = {}) {
      const e = await resoudre(action, options)
      if (!e) return indisponible()
      const manquants = parametresManquants(e, params)
      if (manquants.length) return parametreManquant(action, manquants)
      let module
      try { module = await importer(e.module) }
      catch (err) { console.warn('[hs-bus] module du coeur manquant', action, err && err.message); return indisponible() }
      if (!module || typeof module.ouvrir !== 'function') return indisponible()
      try {
        const resultat = await fenetre.ouvrir(module, { action, params, identite: options.identite || null })
        return { ok: true, resultat }
      } catch (err) {
        console.error('[hs-bus] ouverture echouee', action, err && err.message)
        return indisponible()
      }
    },

    /** Demande une reponse au coeur, sans ecran. */
    async demander (action, params = {}, options = {}) {
      const e = await resoudre(action, options)
      if (!e) return indisponible()
      const manquants = parametresManquants(e, params)
      if (manquants.length) return parametreManquant(action, manquants)
      let module
      try { module = await importer(e.module) }
      catch (err) { console.warn('[hs-bus] module du coeur manquant', action, err && err.message); return indisponible() }
      if (!module || typeof module.demander !== 'function') return indisponible()
      try {
        const data = await module.demander(params, { action, identite: options.identite || null })
        return { ok: true, data }
      } catch (err) {
        console.error('[hs-bus] demande echouee', action, err && err.message)
        return indisponible()
      }
    },

    /** Emet un evenement nomme `domaine.evenement`. */
    emettre (nom, detail = {}) {
      if (!nomValide(nom)) throw new Error('hs-bus : un evenement se nomme « domaine.evenement » (recu : ' + nom + ')')
      cible.dispatchEvent(new CustomEvent(PREFIXE_EVENEMENT + nom, { detail }))
    },

    /** Ecoute un evenement ; rend la fonction qui se desabonne. Meme contrat de nom qu'emettre. */
    ecouter (nom, fn) {
      if (!nomValide(nom)) throw new Error('hs-bus : un evenement se nomme « domaine.evenement » (recu : ' + nom + ')')
      const h = (ev) => fn(ev.detail, ev)
      cible.addEventListener(PREFIXE_EVENEMENT + nom, h)
      return () => cible.removeEventListener(PREFIXE_EVENEMENT + nom, h)
    },
  }
}

// ─── La fenetre standard du coeur (navigateur) ──────────────────────────────
// Une seule fenetre a la fois, au-dessus de tout, fermee par son bouton, par
// la touche Echap, par un clic ENTAME ET RELACHE sur le fond, ou par le module
// lui-meme (`fermer()`). Le module recoit un conteneur vide et y rend ce qu'il
// veut : le bus ne connait pas son contenu.
//
// Constats de review (24 septembre 2026), tous couverts par tests/protocole-fenetre.test.js :
// - si le module echoue, la fenetre se ferme (pas de boite vide sur l'ecran) ;
// - ouvrir une seconde fenetre FERME la premiere par son propre `fermer()`
//   (l'ecouteur Echap ne fuit pas) ;
// - une selection de texte relachee sur le fond ne ferme pas la fenetre ;
// - le focus entre dans la fenetre, y reste (Tab), et revient d'ou il venait ;
//   la page derriere ne defile plus.
export function fenetreNavigateur (doc = typeof document !== 'undefined' ? document : null) {
  const STYLE_ID = 'hs-fenetre-style'
  let fermerCourante = null
  function style () {
    if (doc.getElementById(STYLE_ID)) return
    const s = doc.createElement('style')
    s.id = STYLE_ID
    s.textContent = `
      .hs-fenetre-fond { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2000; display: flex; align-items: flex-end; justify-content: center; }
      @media (min-width: 640px) { .hs-fenetre-fond { align-items: center; } }
      .hs-fenetre { background: var(--bg, #fff); color: var(--text, #1d1d1f); width: 100%; max-width: 560px; max-height: 92vh; overflow: auto; border-radius: 16px 16px 0 0; padding: 18px 18px calc(18px + env(safe-area-inset-bottom)); box-shadow: 0 -8px 30px rgba(0,0,0,.2); }
      @media (min-width: 640px) { .hs-fenetre { border-radius: 14px; padding: 22px; box-shadow: 0 12px 40px rgba(0,0,0,.25); } }
      .hs-fenetre-fermer { float: right; background: none; border: 0; font-size: 20px; line-height: 1; cursor: pointer; color: var(--text2, #6e6e73); padding: 2px 6px; }
      body.hs-fenetre-ouverte { overflow: hidden; }
    `
    doc.head.appendChild(s)
  }
  const FOCUSABLES = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return {
    async ouvrir (module, ctx) {
      style()
      if (fermerCourante) fermerCourante()
      const retour = doc.activeElement
      const fond = doc.createElement('div')
      fond.className = 'hs-fenetre-fond'
      fond.innerHTML = '<div class="hs-fenetre" role="dialog" aria-modal="true" tabindex="-1"><button class="hs-fenetre-fermer" type="button" aria-label="Fermer">✕</button><div class="hs-fenetre-contenu"></div></div>'
      const boite = fond.querySelector('.hs-fenetre')
      const conteneur = fond.querySelector('.hs-fenetre-contenu')
      let presseSurFond = false
      const clavier = (e) => {
        if (e.key === 'Escape') { fermer(); return }
        if (e.key !== 'Tab') return
        const f = [...boite.querySelectorAll(FOCUSABLES)]
        if (!f.length) { e.preventDefault(); boite.focus(); return }
        const premier = f[0], dernier = f[f.length - 1]
        if (e.shiftKey && (doc.activeElement === premier || doc.activeElement === boite)) { e.preventDefault(); dernier.focus() }
        else if (!e.shiftKey && doc.activeElement === dernier) { e.preventDefault(); premier.focus() }
      }
      const fermer = () => {
        if (fermerCourante !== fermer) return           // deja fermee
        fermerCourante = null
        doc.removeEventListener('keydown', clavier)
        fond.remove()
        doc.body.classList.remove('hs-fenetre-ouverte')
        if (retour && typeof retour.focus === 'function') retour.focus()
      }
      fermerCourante = fermer
      fond.querySelector('.hs-fenetre-fermer').addEventListener('click', fermer)
      fond.addEventListener('pointerdown', (e) => { presseSurFond = e.target === fond })
      fond.addEventListener('click', (e) => { if (e.target === fond && presseSurFond) fermer(); presseSurFond = false })
      doc.addEventListener('keydown', clavier)
      doc.body.appendChild(fond)
      doc.body.classList.add('hs-fenetre-ouverte')
      try {
        const resultat = await module.ouvrir({ ...ctx, conteneur, fermer })
        // Le premier element focusable DU CONTENU (chaque selecteur prefixe : une
        // liste a virgules ne prefixe que le premier), sinon le bouton Fermer.
        const dansContenu = FOCUSABLES.split(',').map(x => '.hs-fenetre-contenu ' + x.trim()).join(', ')
        const premier = boite.querySelector(dansContenu) || fond.querySelector('.hs-fenetre-fermer')
        if (fermerCourante === fermer && premier) premier.focus()
        return resultat
      } catch (err) {
        fermer()
        throw err
      }
    },
  }
}

// ─── L'instance par defaut ──────────────────────────────────────────────────
// Les droits de session se lisent au moment de l'appel, et SEULEMENT quand
// l'action en a besoin : la PWA prestataire (identite par jeton) ne charge
// jamais la pile de session. Un import qui tombe (hors ligne, CDN bloque)
// vaut refus — bouton masque — et se retente a l'appel suivant : rien n'est
// mis en cache en echec, et rien ne remonte a l'app.
function busNavigateur () {
  let cc = null
  let chargement = null
  async function chargerDroits () {
    if (cc) return cc
    try {
      if (!chargement) chargement = import('/shared/compte-courant.js')
      cc = await chargement
    } catch (e) {
      chargement = null
      console.warn('[hs-bus] droits injoignables, action refusee', e && e.message)
    }
    return cc
  }
  const droits = {
    peutLire: (d) => !!(cc && cc.peutLire(d)),
    peutEcrire: (d) => !!(cc && cc.peutEcrire(d)),
  }
  const bus = creerBus({
    droits,
    importer: (chemin) => import(chemin),
    fenetre: fenetreNavigateur(),
    cible: window,
  })
  const parJeton = (options) => !!(options && options.identite && options.identite.jeton)
  const avecDroits = (fn) => async (action, params, options) => {
    if (!parJeton(options)) await chargerDroits()
    return fn(action, params, options)
  }
  return {
    disponible: async (action, options) => { if (!parJeton(options)) await chargerDroits(); return bus.disponible(action, options) },
    ouvrir: avecDroits(bus.ouvrir),
    demander: avecDroits(bus.demander),
    emettre: bus.emettre,
    ecouter: bus.ecouter,
  }
}

export const hsBus = (typeof window !== 'undefined' && typeof document !== 'undefined') ? busNavigateur() : null
