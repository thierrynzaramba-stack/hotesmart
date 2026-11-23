// tests/connaissance-messages-dom.test.js — le volet « Base de connaissance »
// DANS la page Messages (KB V5, lot 3), rejoué au banc de la page.
//
// ⚠ LE BANC EXÉCUTE LE VRAI MODULE DE `pages/messages.html`, et le vrai
// `shared/connaissance-vue.js` avec lui (tests/outils/banc-messages.js). Les
// gestes sont ceux de l'hôte : le bouton d'en-tête, le lien du volet IA, le
// changement de fil.

const test = require('node:test')
const assert = require('node:assert/strict')
const { monter, amorcer, peupler, clic, reposer, boutonVolet, tiroirOuvert } = require('./outils/banc-messages')

const ECRAN = {
  migration: true,
  biens: [{ ref: 'P1', nom: 'La bulle', photo: null }, { ref: 'P2', nom: 'Cœur', photo: null }],
  bien: { ref: 'P1', nom: 'La bulle', photo: null },
  faits: [],
  reponses: [{ id: 'r1', sujet: 'Wifi', brut: 'Le wifi est {wifi_nom}', segments: [{ texte: 'Le wifi est RESEAU' }],
    verifieLe: null, aRevoir: false, horsIa: false, apercu: 'Le wifi est RESEAU', manquants: [], inconnues: [], codeNonResolu: false }],
  balises: [{ cle: 'prenom', libelle: 'Prénom', origine: 'reservation', marqueur: null }],
  voyageur: null
}
const BIENS = [{ ref: 'P1', nom: 'La bulle' }, { ref: 'P2', nom: 'Cœur' }]
const FR = require('../shared/i18n/fr.json')
const FR_USE_WRONG = FR['kb.use_wrong_conv']
const lecturesKb = (banc) => banc.envois.filter(e => /^\/api\/ecran\/connaissance/.test(e.chemin) && e.methode === 'GET')

function banc (o = {}) {
  return monter({
    titulaire: o.titulaire !== false,
    appel: async (chemin) => {
      if (/^\/api\/ecran\/connaissance/.test(chemin)) {
        const bien = (/bien=(\w+)/.exec(chemin) || [])[1] || 'P1'
        // Comme le serveur : l'aperçu est fait pour la réservation demandée
        // (`duFil`), et les prénoms suivent le voyageur.
        const resa = (/resa=(\w+)/.exec(chemin) || [])[1] || null
        const prenom = resa === 'B8' ? 'Marie' : 'Ana'
        return { ...ECRAN, bien: { ref: bien, nom: bien === 'P2' ? 'Cœur' : 'La bulle', photo: null },
          reponses: ECRAN.reponses.map(r => ({ ...r, apercu: resa ? `Bonjour ${prenom}, ${r.apercu}` : r.apercu })),
          voyageur: resa ? { resa, prenom, arrivee: '2099-01-01', duFil: true } : null }
      }
      return {}
    }
  })
}

test('LE TEST QUI COMPTE : le bouton « Base de connaissance » ouvre un volet de 440 px, en UN appel', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1' })
  b.msg.ouvrirTiroir(false)
  const bouton = boutonVolet(b, 'connaissance')
  assert.ok(bouton, 'le bouton existe dans l en-tête')
  assert.equal(bouton.hidden, false, 'visible pour le titulaire')
  assert.match(bouton.innerHTML, /#i-book/)
  clic(b, bouton)
  await reposer(b)
  const tiroir = b.doc.querySelector('[data-bind="tiroir"]')
  assert.equal(tiroirOuvert(b), true)
  assert.ok(tiroir.classList.contains('msg-tiroir--large'), 'le volet de la base est le large')
  assert.equal(b.doc.querySelector('[data-bind="tiroir-titre"]').textContent, 'Base de connaissance')
  assert.equal(bouton.getAttribute('aria-expanded'), 'true')
  assert.deepEqual(lecturesKb(b).map(e => e.chemin), ['/api/ecran/connaissance?bien=P1'])
  assert.equal(b.doc.querySelectorAll('[data-bind="tiroir-corps"] .kb-carte').length, 1)
  b.fermer()
})

test('LE TEST QUI COMPTE : un nouveau rendu du tiroir ne relit PAS l écran et ne perd PAS l édition', async () => {
  // `renderTiroir` est rappelé par d'autres chemins (fin d'écriture,
  // repointage) : remonter la vue à chaque fois effacerait la réponse en cours.
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  clic(b, b.doc.querySelector('[data-kb-ouvrir="r1"]'))
  b.doc.querySelector('[data-kb-sujet]').value = 'Wifi corrigé'
  b.msg.renderTiroir()
  b.msg.renderTiroir()
  await reposer(b)
  assert.equal(lecturesKb(b).length, 1)
  assert.equal(b.doc.querySelector('[data-kb-sujet]').value, 'Wifi corrigé')
  // Et le tiroir sait qu'une saisie n'est pas enregistrée.
  assert.equal(b.msg.editionPanneauNonEnregistree(), 'La bulle')
  b.fermer()
})

test('changer de logement au sélecteur du tiroir relit l écran de CE logement', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  const sel = b.doc.querySelector('[data-bind="tiroir-bien"]')
  sel.value = 'P2'
  sel.dispatchEvent(new b.window.Event('change', { bubbles: true }))
  await reposer(b)
  assert.equal(lecturesKb(b).pop().chemin, '/api/ecran/connaissance?bien=P2')
  assert.equal(b.msg.vueConnaissance.ref, 'P2')
  b.fermer()
})

test('LE TEST QUI COMPTE : passer à un autre volet DÉMONTE la vue et rend sa largeur au tiroir', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  assert.ok(b.msg.vueConnaissance)
  clic(b, boutonVolet(b, 'programmes'))
  await reposer(b)
  assert.equal(b.msg.vueConnaissance, null, 'plus d écouteur de sélection sur le document')
  assert.ok(!b.doc.querySelector('[data-bind="tiroir"]').classList.contains('msg-tiroir--large'))
  b.fermer()
})

test('le lien « Connaissances » du volet IA change de VOLET, il ne quitte plus Messages', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1' })
  const lien = b.doc.querySelector('[data-bind="tiroir-corps"] [data-ouvre-connaissance]')
  assert.ok(lien)
  assert.ok(!/agent-ai/.test(lien.getAttribute('href')), 'plus d adresse vers l ancienne page')
  const ev = new b.window.MouseEvent('click', { bubbles: true, cancelable: true, view: b.window })
  lien.dispatchEvent(ev)
  await reposer(b)
  assert.equal(ev.defaultPrevented, true)
  assert.equal(b.msg.etat.tiroirVolet, 'connaissance')
  assert.equal(tiroirOuvert(b), true)
  assert.equal(lecturesKb(b).length, 1)
  b.fermer()
})

test('LE TEST QUI COMPTE : au téléphone, le bouton ouvre la base PAR-DESSUS Messages, sans quitter la page', async () => {
  // Décision de Thierry du 7 novembre 2026 (spec kb-utiliser-reponse) : plus
  // de page à part. Le tiroir couvre l'écran du téléphone.
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1',
    conversations: [{ bookId: 'B7', propertyId: 'P2', messages: [], lastNight: '2099-01-02' }], ouverte: 'B7' })
  b.msg.ouvrirTiroir(false)
  b.window.matchMedia = (q) => ({ matches: /max-width: 899px/.test(q), media: q, addEventListener () {}, removeEventListener () {} })
  clic(b, boutonVolet(b, 'connaissance'))
  await reposer(b)
  assert.deepEqual(b.navigations, [], 'on ne quitte jamais Messages')
  assert.equal(tiroirOuvert(b), true)
  assert.deepEqual(lecturesKb(b).map(e => e.chemin), ['/api/ecran/connaissance?bien=P2&resa=B7'])
  b.fermer()
})

test('LE TEST QUI COMPTE : le volet est réservé au titulaire, comme la page qu il remplace', async () => {
  const b = banc({ titulaire: false })
  await amorcer(b)
  assert.equal(boutonVolet(b, 'connaissance').hidden, true)
  b.fermer()
})

test('l aperçu prend le voyageur du fil ouvert, s il séjourne dans CE logement', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P2',
    conversations: [{ bookId: 'B7', propertyId: 'P2', messages: [], lastNight: '2099-01-02' }], ouverte: 'B7' })
  await reposer(b)
  assert.deepEqual(lecturesKb(b).map(e => e.chemin), ['/api/ecran/connaissance?bien=P2&resa=B7'])
  b.fermer()
})

test('LE TEST QUI COMPTE : changer de volet en pleine saisie le DIT, la réponse ne disparaît pas en silence', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  clic(b, b.doc.querySelector('[data-kb-ouvrir="r1"]'))
  b.doc.querySelector('[data-kb-sujet]').value = 'Wifi corrigé'
  clic(b, boutonVolet(b, 'programmes'))
  await reposer(b)
  assert.equal(b.note(), 'La saisie en cours de la base de connaissance n’a pas été enregistrée')
  b.fermer()
})

test('changer de volet SANS saisie ne dit rien', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  clic(b, boutonVolet(b, 'programmes'))
  await reposer(b)
  assert.equal(b.note(), null)
  b.fermer()
})

test('changer de volet PENDANT un enregistrement ne prétend pas que la saisie est perdue', async () => {
  let lacher
  const b = monter({
    titulaire: true,
    appel: async (chemin, corps) => {
      if (/^\/api\/ecran\/connaissance/.test(chemin)) {
        if (corps) return new Promise(r => { lacher = () => r({ ok: true }) })
        return { ...ECRAN }
      }
      return {}
    }
  })
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  clic(b, b.doc.querySelector('[data-kb-ouvrir="r1"]'))
  b.doc.querySelector('[data-kb-sujet]').value = 'Wifi corrigé'
  clic(b, b.doc.querySelector('[data-kb-enregistrer]'))
  await reposer(b)
  clic(b, boutonVolet(b, 'programmes'))
  await reposer(b)
  assert.equal(b.note(), null, 'l écriture est partie : rien n est perdu')
  lacher(); await reposer(b)
  assert.equal(b.envois.filter(e => e.methode === 'POST' && /connaissance/.test(e.chemin)).length, 1)
  b.fermer()
})

// ─── L'icône À CÔTÉ DE LA SAISIE (recette du 7 novembre 2026) ─────────────
// Au téléphone, le bouton d'en-tête ne vit que sur la LISTE : pour l'atteindre
// il fallait quitter le fil, et la page s'ouvrait sur le premier logement,
// sans voyageur (mesuré en recette sur staging). L'icône de la saisie est DANS
// le fil — et comme on peut la toucher en pleine frappe, quitter la page ne
// doit ni perdre un texte, ni couper un envoi, ni laisser partir deux fois.
const iconeSaisie = (b) => b.doc.querySelector('[data-bind="saisie"] [data-ouvre-volet="connaissance"]')
const auTelephone = (b) => {
  b.window.matchMedia = (q) => ({ matches: /max-width: 899px/.test(q), media: q, addEventListener () {}, removeEventListener () {} })
}
const fil = (bookId, propertyId) => ({ bookId, propertyId, messages: [], lastNight: '2099-01-02' })
const noteSaisie = (b) => {
  const n = b.doc.querySelector('[data-bind="saisie-etat"]')
  return n.hidden ? null : n.textContent
}

// Le téléphone, un fil ouvert (B7, logement P2), le tiroir fermé.
async function telephoneSurB7 (o = {}) {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2'), fil('B8', 'P1')],
    taches: o.taches || [] })
  b.msg.ouvrirTiroir(false)
  // Le vrai geste : ouvrir le fil peint la saisie (cachée sans fil).
  b.msg.ouvrir('B7')
  auTelephone(b)
  return b
}

test('LE TEST QUI COMPTE : l icône de la base vit DANS la saisie du fil, titulaire seul', async () => {
  const b = banc()
  await amorcer(b)
  const icone = iconeSaisie(b)
  assert.ok(icone, 'à côté du champ de saisie')
  assert.match(icone.innerHTML, /#i-book/)
  assert.equal(icone.hidden, false)
  b.fermer()
  const m = banc({ titulaire: false })
  await amorcer(m)
  assert.equal(iconeSaisie(m).hidden, true, 'l endpoint refuse un membre : l icône aussi')
  m.fermer()
})

test('à l ordinateur, l icône de la saisie ouvre le volet sur le logement ET le voyageur du fil', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2')], ouverte: 'B7' })
  b.msg.ouvrirTiroir(false)
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.equal(tiroirOuvert(b), true)
  assert.equal(b.msg.etat.tiroirVolet, 'connaissance')
  assert.deepEqual(lecturesKb(b).map(e => e.chemin), ['/api/ecran/connaissance?bien=P2&resa=B7'])
  assert.deepEqual(b.navigations, [], 'on ne quitte pas Messages')
  b.fermer()
})

test('LE TEST QUI COMPTE : au téléphone, l icône de la saisie ouvre la base PAR-DESSUS le fil, texte tapé intact', async () => {
  const b = await telephoneSurB7()
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = 'Bonjour, le code est '
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.deepEqual(b.navigations, [], 'rien ne quitte la page, donc rien n est coupé')
  assert.equal(tiroirOuvert(b), true)
  assert.deepEqual(lecturesKb(b).map(e => e.chemin), ['/api/ecran/connaissance?bien=P2&resa=B7'],
    'le logement ET le voyageur de la conversation')
  assert.equal(zone.value, 'Bonjour, le code est ')
  // Fermer la base rend la conversation telle qu'elle était.
  clic(b, b.doc.querySelector('[data-bind="tiroir-fermer"]'))
  assert.equal(tiroirOuvert(b), false)
  assert.equal(zone.value, 'Bonjour, le code est ')
  b.fermer()
})

test('LE TEST QUI COMPTE : pendant un « Modifier », la base s ouvre aussi — la limite d hier tombe', async () => {
  const echeance = new Date(Date.now() + 3600e3).toISOString()
  const b = await telephoneSurB7({ taches: [{ id: 'T1', booking_id: 'B7', suggested_reply: 'Texte de l IA', send_after: echeance }] })
  b.msg.etat.enEdition = { bookId: 'B7', tacheId: 'T1' }
  b.doc.querySelector('[data-bind="texte"]').value = 'Texte retouché'
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.equal(tiroirOuvert(b), true)
  assert.equal(noteSaisie(b), null, 'aucun refus')
  assert.deepEqual(b.navigations, [])
  b.fermer()
})

// ─── « Utiliser » une réponse prête (spec kb-utiliser-reponse) ─────────────
const utiliser = (b, id = 'r1') => clic(b, b.doc.querySelector(`[data-bind="tiroir-corps"] [data-kb-utiliser="${id}"]`))
// TOUT appel qui écrit — pas seulement `/api/messages` : l'envoi au voyageur
// passe par `/api/beds24` ou `/api/channel-message` (constat 2 de la review).
const ecrituresHorsBase = (b) => b.envois.filter(e => e.methode !== 'GET' && !/^\/api\/ecran\/connaissance/.test(e.chemin))
const envoisVoyageur = (b) => b.envois.filter(e => /^\/api\/(beds24|channel-message)/.test(e.chemin))

test('LE TEST QUI COMPTE : « Utiliser » ajoute À LA SUITE du texte tapé, referme la base, et rien ne part', async () => {
  const b = await telephoneSurB7()
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = 'Bonjour !  '
  clic(b, iconeSaisie(b))
  await reposer(b)
  const avant = ecrituresHorsBase(b).length
  utiliser(b)
  await reposer(b)
  assert.equal(zone.value, 'Bonjour !\nBonjour Ana, Le wifi est RESEAU', 'à la suite, avec un retour à la ligne')
  assert.equal(tiroirOuvert(b), false, 'retour à la conversation')
  assert.equal(b.doc.activeElement, zone, 'le curseur est dans le champ')
  assert.equal(zone.selectionStart, zone.value.length, 'à la fin du texte')
  assert.equal(ecrituresHorsBase(b).length, avant, 'R4 : AUCUNE écriture — l envoi reste le bouton « Envoyer »')
  b.fermer()
})

test('« Utiliser » dans un champ vide pose le texte seul, sans ligne vide en tête', async () => {
  const b = await telephoneSurB7()
  clic(b, iconeSaisie(b))
  await reposer(b)
  utiliser(b)
  await reposer(b)
  assert.equal(b.doc.querySelector('[data-bind="texte"]').value, 'Bonjour Ana, Le wifi est RESEAU')
  b.fermer()
})

test('R5 — pendant un « Modifier », « Utiliser » ajoute au texte en cours de correction, et l édition reste la même', async () => {
  const echeance = new Date(Date.now() + 3600e3).toISOString()
  const b = await telephoneSurB7({ taches: [{ id: 'T1', booking_id: 'B7', suggested_reply: 'Texte de l IA', send_after: echeance }] })
  b.msg.etat.enEdition = { bookId: 'B7', tacheId: 'T1' }
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = 'Texte retouché'
  clic(b, iconeSaisie(b))
  await reposer(b)
  utiliser(b)
  await reposer(b)
  assert.equal(zone.value, 'Texte retouché\nBonjour Ana, Le wifi est RESEAU')
  assert.deepEqual(JSON.parse(JSON.stringify(b.msg.etat.enEdition)), { bookId: 'B7', tacheId: 'T1' })
  b.fermer()
})

test('LE TEST QUI COMPTE : R1 — le fil change sous la base : sa vue se remonte pour le NOUVEAU voyageur', async () => {
  // À l'ordinateur, le volet reste ouvert quand on clique un autre fil. Même
  // logement, autre voyageur : sans remontage, « Bonjour Ana » partait dans
  // la conversation de Marie.
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2'), fil('B8', 'P2')] })
  b.msg.ouvrirTiroir(false)
  b.msg.ouvrir('B7')
  clic(b, iconeSaisie(b))
  await reposer(b)
  const vueAna = b.msg.vueConnaissance
  b.msg.ouvrir('B8')
  await reposer(b)
  assert.notEqual(b.msg.vueConnaissance, vueAna, 'la vue a été remontée')
  assert.equal(lecturesKb(b).pop().chemin, '/api/ecran/connaissance?bien=P2&resa=B8')
  utiliser(b)
  await reposer(b)
  assert.equal(b.doc.querySelector('[data-bind="texte"]').value, 'Bonjour Marie, Le wifi est RESEAU')
  b.fermer()
})

test('LE TEST QUI COMPTE : R1 — un texte rempli pour une AUTRE conversation est refusé au geste, le champ intact', async () => {
  // La garde au geste, indépendante du remontage : une vue périmée (ou un
  // second chemin d'appel) ne peut rien poser dans le mauvais fil.
  const b = await telephoneSurB7()
  b.msg.ouvrir('B8')
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = 'Pour Marie'
  assert.equal(b.msg.utiliserDansLaSaisie({ texte: 'Bonjour Ana', resa: 'B7', ref: 'P2' }), false)
  assert.equal(zone.value, 'Pour Marie')
  assert.equal(b.msg.utiliserDansLaSaisie({ texte: 'Bonjour Marie', resa: 'B8', ref: 'P2' }), false,
    'R2 : B8 est à P1, pas à P2')
  assert.equal(zone.value, 'Pour Marie')
  b.fermer()
})

// ─── Le texte posé par « Utiliser » appartient à SA conversation ────────────
// Constat 1 de la review, mesuré : la saisie est PARTAGÉE entre les fils, et un
// texte rempli pour Ana partait chez Marie après un changement de fil.
async function bancDeuxFils (convs) {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: convs })
  b.msg.ouvrirTiroir(false)
  b.msg.ouvrir('B7')
  clic(b, iconeSaisie(b))
  await reposer(b)
  utiliser(b)
  await reposer(b)
  return b
}
const envoyer = (b) => clic(b, b.doc.querySelector('[data-bind="envoyer"]'))

test('LE TEST QUI COMPTE : changer de fil RETIRE le texte posé pour l autre voyageur, en silence', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B8', 'P2')])
  const zone = b.doc.querySelector('[data-bind="texte"]')
  assert.equal(zone.value, 'Bonjour Ana, Le wifi est RESEAU')
  b.msg.ouvrir('B8')
  assert.equal(zone.value, '', 'le texte d Ana ne reste pas dans le fil de Marie')
  assert.equal(noteSaisie(b), null, 'retiré en silence (recette du 8 novembre)')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [])
  b.fermer()
})

test('LE TEST QUI COMPTE : un texte posé PUIS retouché reste, mais « Envoyer » le refuse dans un autre fil', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = zone.value.replace('Ana', 'Ana !')
  zone.dispatchEvent(new b.window.Event('input', { bubbles: true }))
  b.msg.ouvrir('B9')
  assert.equal(zone.value, 'Bonjour Ana !, Le wifi est RESEAU', 'rien n est jeté de ce que l hôte a tapé')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [], 'le wifi d une autre maison ne part pas chez ce voyageur')
  assert.equal(zone.value, 'Bonjour Ana !, Le wifi est RESEAU', 'le champ est intact')
  assert.equal(noteSaisie(b), FR_USE_WRONG)
  // De retour dans SA conversation, il part.
  b.msg.ouvrir('B7')
  envoyer(b)
  await reposer(b)
  assert.equal(envoisVoyageur(b).length, 1)
  assert.equal(envoisVoyageur(b)[0].corps.bookingId, 'B7')
  b.fermer()
})

test('un champ vidé à la main ne porte plus le texte d aucune conversation', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = ''
  zone.dispatchEvent(new b.window.Event('input', { bubbles: true }))
  // L'hôte écrit ensuite SON texte, avant de changer de fil : ce n'est plus
  // le texte de la base, rien ne doit le retenir.
  zone.value = 'Bonjour, à demain'
  zone.dispatchEvent(new b.window.Event('input', { bubbles: true }))
  b.msg.ouvrir('B9')
  assert.equal(zone.value, 'Bonjour, à demain')
  assert.notEqual(noteSaisie(b), FR_USE_WRONG)
  envoyer(b)
  await reposer(b)
  assert.equal(envoisVoyageur(b).length, 1)
  assert.equal(envoisVoyageur(b)[0].corps.bookingId, 'B9')
  b.fermer()
})

// ─── Review 2 : la marque suit TOUS les textes posés, et rien d'autre ne passe ─
const utiliserEncore = async (b) => {
  clic(b, iconeSaisie(b))
  await reposer(b)
  utiliser(b)
  await reposer(b)
}
const taper = (b, valeur) => {
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = valeur
  zone.dispatchEvent(new b.window.Event('input', { bubbles: true }))
}

test('LE TEST QUI COMPTE : deux « Utiliser » dans le même fil, changer de fil les retire TOUS', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  await utiliserEncore(b)
  const zone = b.doc.querySelector('[data-bind="texte"]')
  assert.equal(zone.value, 'Bonjour Ana, Le wifi est RESEAU\nBonjour Ana, Le wifi est RESEAU')
  b.msg.ouvrir('B9')
  assert.equal(zone.value, '', 'aucun des deux textes d Ana ne reste')
  assert.equal(noteSaisie(b), null, 'retiré en silence (recette du 8 novembre)')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [])
  b.fermer()
})

test('LE TEST QUI COMPTE : une phrase AJOUTÉE au texte posé est une retouche — tout reste, et « Envoyer » refuse ailleurs', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  taper(b, 'Belle soirée Ana, à demain 15 h\nBonjour Ana, Le wifi est RESEAU')
  b.msg.ouvrir('B9')
  const zone = b.doc.querySelector('[data-bind="texte"]')
  assert.equal(zone.value, 'Belle soirée Ana, à demain 15 h\nBonjour Ana, Le wifi est RESEAU', 'rien n est jeté')
  assert.equal(noteSaisie(b), FR_USE_WRONG)
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [], 'ce qui était écrit pour Ana ne part pas chez un autre voyageur')
  b.msg.ouvrir('B7')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b).map(e => e.corps.bookingId), ['B7'])
  b.fermer()
})

test('LE TEST QUI COMPTE : « Utiliser » dans un autre fil n ajoute rien à un texte préparé pour Ana', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B8', 'P2')])
  taper(b, 'Bonjour Ana !, Le wifi est RESEAU')
  b.msg.ouvrir('B8')
  await reposer(b)
  await utiliserEncore(b)
  const zone = b.doc.querySelector('[data-bind="texte"]')
  assert.equal(zone.value, 'Bonjour Ana !, Le wifi est RESEAU', 'le texte de Marie n a pas été ajouté')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [], 'la marque est restée sur le fil d Ana')
  b.fermer()
})

test('LE TEST QUI COMPTE : « Modifier » (sans échéance) + « Utiliser », puis changer de fil : le texte de l IA repart aussi', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2'), fil('B9', 'P1')],
    taches: [{ id: 'T1', booking_id: 'B7', suggested_reply: 'Bonjour Ana, voici votre code de boite' }] })
  b.msg.ouvrirTiroir(false)
  b.msg.ouvrir('B7')
  // Le vrai « Modifier » (le banc n'indexe pas les bulles de proposition).
  b.msg.modifierProposition('T1')
  const zone = b.doc.querySelector('[data-bind="texte"]')
  assert.equal(zone.value, 'Bonjour Ana, voici votre code de boite')
  await utiliserEncore(b)
  assert.equal(zone.value, 'Bonjour Ana, voici votre code de boite\nBonjour Ana, Le wifi est RESEAU')
  b.msg.ouvrir('B9')
  assert.equal(zone.value, '', 'ni le texte de l IA ni celui de la base ne restent')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [])
  b.fermer()
})

test('tiroir OUVERT et nouveau fil dans un autre logement : la note R7 se lit sous le champ', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  taper(b, 'Bonjour Ana !, Le wifi est RESEAU')
  clic(b, iconeSaisie(b))
  await reposer(b)
  b.msg.ouvrir('B9')
  await reposer(b)
  assert.equal(noteSaisie(b), FR_USE_WRONG)
  b.fermer()
})

test('« Modifier » remplace le champ : ce qui suit se comporte comme sans « Utiliser »', async () => {
  const scenario = async (avecUtiliser) => {
    const b = banc()
    await amorcer(b)
    peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2'), fil('B9', 'P1')],
      taches: [{ id: 'T1', booking_id: 'B7', suggested_reply: 'Texte de l IA' }] })
    b.msg.ouvrirTiroir(false)
    b.msg.ouvrir('B7')
    if (avecUtiliser) await utiliserEncore(b)
    b.msg.modifierProposition('T1')
    taper(b, 'Texte de l IA, relu')
    b.msg.ouvrir('B9')
    const vu = { champ: b.doc.querySelector('[data-bind="texte"]').value, note: noteSaisie(b) }
    b.fermer()
    return vu
  }
  assert.deepEqual(await scenario(true), await scenario(false))
})

// ─── Review 3 : un champ vidé puis rétabli, et la note qui suit le fil ──────
test('LE TEST QUI COMPTE : vider puis rétablir (Ctrl+Z) le texte posé ne le libère pas pour un autre fil', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  taper(b, '')
  taper(b, 'Bonjour Ana, Le wifi est RESEAU')
  b.msg.ouvrir('B9')
  assert.equal(b.doc.querySelector('[data-bind="texte"]').value, '', 'rétabli tel quel : il est retiré comme un texte posé')
  assert.equal(noteSaisie(b), null, 'en silence')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [])
  b.fermer()
})

test('LE TEST QUI COMPTE : vider, changer de fil, PUIS rétablir : « Envoyer » refuse encore', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  taper(b, '')
  b.msg.ouvrir('B9')
  taper(b, 'Bonjour Ana, Le wifi est RESEAU')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b), [], 'le texte d Ana revenu par l annulation ne part pas chez un autre voyageur')
  assert.equal(noteSaisie(b), FR_USE_WRONG)
  b.fermer()
})

test('la note R7 tombe en revenant dans le bon fil, et après un envoi', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  taper(b, 'Bonjour Ana !, Le wifi est RESEAU')
  b.msg.ouvrir('B9')
  assert.equal(noteSaisie(b), FR_USE_WRONG)
  b.msg.ouvrir('B7')
  assert.equal(noteSaisie(b), null, 'dans le fil d Ana, « il ne partira pas ici » serait faux')
  b.msg.ouvrir('B9')
  envoyer(b)
  await reposer(b)
  assert.equal(noteSaisie(b), FR_USE_WRONG, 'le refus se redit au geste')
  b.msg.ouvrir('B7')
  envoyer(b)
  await reposer(b)
  assert.equal(envoisVoyageur(b).length, 1)
  assert.equal(noteSaisie(b), null, 'après l envoi, plus de note')
  b.fermer()
})

test('le refus « il ne partira pas ici » tombe quand l hôte envoie SON message dans ce fil', async () => {
  const b = await bancDeuxFils([fil('B7', 'P2'), fil('B9', 'P1')])
  taper(b, 'Bonjour Ana !, Le wifi est RESEAU')
  b.msg.ouvrir('B9')
  assert.equal(noteSaisie(b), FR_USE_WRONG)
  taper(b, '')
  taper(b, 'Bonjour, à demain')
  envoyer(b)
  await reposer(b)
  assert.deepEqual(envoisVoyageur(b).map(e => e.corps.bookingId), ['B9'])
  assert.equal(noteSaisie(b), null, 'après l envoi, plus de note')
  b.fermer()
})

test('LE TEST QUI COMPTE (recette du 8 novembre) : au téléphone, changer de fil ne fige pas une hauteur de zéro', async () => {
  const b = await telephoneSurB7()
  const zone = b.doc.querySelector('[data-bind="texte"]')
  // jsdom ne mesure rien : on rend au champ la mesure d'un vrai navigateur —
  // 0 quand la saisie est cachée (téléphone, liste affichée), 48 sinon.
  Object.defineProperty(zone, 'scrollHeight', { configurable: true, get: () => (b.doc.body.dataset.fil ? 48 : 0) })
  clic(b, iconeSaisie(b))
  await reposer(b)
  utiliser(b)
  await reposer(b)
  assert.equal(zone.style.height, '48px')
  clic(b, b.doc.querySelector('[data-bind="retour"]'))
  b.msg.ouvrir('B8')
  assert.equal(zone.style.height, '48px', 'remesuré une fois la saisie visible')
  b.fermer()
})

test('R2 — dans Messages, choisir un autre logement au sélecteur du tiroir retire « Utiliser »', async () => {
  const b = await telephoneSurB7()
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.ok(b.doc.querySelector('[data-kb-utiliser]'))
  const sel = b.doc.querySelector('[data-bind="tiroir-bien"]')
  sel.value = 'P1'
  sel.dispatchEvent(new b.window.Event('change', { bubbles: true }))
  await reposer(b)
  assert.equal(lecturesKb(b).pop().chemin, '/api/ecran/connaissance?bien=P1', 'sans la réservation du fil')
  assert.equal(b.doc.querySelector('[data-kb-utiliser]'), null)
  b.fermer()
})

test('changer de fil dans le même logement n efface pas une réponse prête EN COURS D ÉCRITURE', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2'), fil('B8', 'P2')] })
  b.msg.ouvrirTiroir(false)
  b.msg.ouvrir('B7')
  clic(b, iconeSaisie(b))
  await reposer(b)
  clic(b, b.doc.querySelector('[data-kb-ouvrir="r1"]'))
  b.doc.querySelector('[data-kb-sujet]').value = 'Wifi corrigé'
  const vue = b.msg.vueConnaissance
  b.msg.ouvrir('B8')
  await reposer(b)
  assert.equal(b.msg.vueConnaissance, vue, 'la vue n est pas remontée')
  assert.equal(b.doc.querySelector('[data-kb-sujet]').value, 'Wifi corrigé')
  // Et la vue d'avant ne pose rien dans le fil de Marie : refus au geste.
  assert.equal(b.msg.utiliserDansLaSaisie({ texte: 'Bonjour Ana', resa: 'B7', ref: 'P2' }), false)
  b.fermer()
})

test('sans conversation ouverte, la base n offre aucun « Utiliser »', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'connaissance', bien: 'P1' })
  await reposer(b)
  assert.ok(b.doc.querySelector('[data-bind="tiroir-corps"] .kb-carte'))
  assert.equal(b.doc.querySelector('[data-kb-utiliser]'), null)
  b.fermer()
})

test('l ancienne adresse (?volet=connaissance) ouvre aussi la base par-dessus au téléphone', async () => {
  const b = monter({
    titulaire: true,
    appel: async (chemin) => (/^\/api\/ecran\/connaissance/.test(chemin) ? ECRAN : {})
  })
  b.window.history.replaceState(null, '', '/messages?volet=connaissance')
  b.window.matchMedia = (q) => ({ matches: /max-width: 899px/.test(q), media: q, addEventListener () {}, removeEventListener () {} })
  await amorcer(b)
  await reposer(b)
  assert.deepEqual(b.navigations, [])
  assert.equal(tiroirOuvert(b), true)
  assert.equal(b.msg.etat.tiroirVolet, 'connaissance')
  b.fermer()
})

// ─── La saisie s'élargit pendant la frappe (recette du 7 novembre 2026) ────
// Avec le livre en plus, le champ n'avait plus qu'un tiers de la largeur du
// téléphone. Toucher le champ le passe sur toute la largeur, boutons dessous.
const barre = (b) => b.doc.querySelector('[data-bind="saisie"]')
const enFrappe = (b) => barre(b).classList.contains('msg-saisie--frappe')

test('LE TEST QUI COMPTE : toucher le champ l élargit ; quitter le champ seul ne le replie PAS', async () => {
  // Le `blur` part au toucher d'un bouton, AVANT son clic : replier à cet
  // instant déplacerait le bouton sous le doigt.
  const b = await telephoneSurB7()
  const zone = b.doc.querySelector('[data-bind="texte"]')
  assert.equal(enFrappe(b), false)
  zone.focus()
  assert.equal(enFrappe(b), true)
  zone.blur()
  assert.equal(enFrappe(b), true, 'toujours large au blur')
  b.fermer()
})

test('un clic dans la saisie la garde large ; un clic ailleurs la replie, APRÈS avoir atteint sa cible', async () => {
  const b = await telephoneSurB7()
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.focus(); zone.blur()
  clic(b, b.doc.querySelector('[data-bind="proposer"]'))
  assert.equal(enFrappe(b), true, 'un bouton de la saisie')
  let atteint = null
  const ailleurs = b.doc.querySelector('.msg-fil__titre') || b.doc.querySelector('[data-bind="fil"]')
  ailleurs.addEventListener('click', () => { atteint = enFrappe(b) })
  clic(b, ailleurs)
  assert.equal(atteint, true, 'la cible du clic voit la saisie encore large : rien n a bougé sous le doigt')
  assert.equal(enFrappe(b), false, 'repliée ensuite')
  await reposer(b)
  b.fermer()
})

test('la saisie large ne vit qu au téléphone, et le champ y prend toute la ligne', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const i = css.indexOf('.msg-saisie--frappe {')
  assert.ok(i > 0)
  const media = css.lastIndexOf('@media', i)
  assert.match(css.slice(media, media + 40), /^@media \(max-width: 899px\)/, 'réservée au téléphone')
  assert.equal(css.slice(media, i).split('{').length - 1 - (css.slice(media, i).split('}').length - 1), 1,
    'la règle est DANS ce bloc @media, pas après sa fermeture')
  assert.match(css, /\.msg-saisie--frappe \{ flex-wrap: wrap;/)
  assert.match(css, /\.msg-saisie--frappe textarea \{ flex: 1 1 100%; \}/)
})
