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
  reponses: [{ id: 'r1', sujet: 'Wifi', brut: 'x', segments: [{ texte: 'x' }], verifieLe: null, aRevoir: false, horsIa: false, apercu: 'x' }],
  balises: [{ cle: 'prenom', libelle: 'Prénom', origine: 'reservation', marqueur: null }],
  voyageur: null
}
const BIENS = [{ ref: 'P1', nom: 'La bulle' }, { ref: 'P2', nom: 'Cœur' }]
const lecturesKb = (banc) => banc.envois.filter(e => /^\/api\/ecran\/connaissance/.test(e.chemin) && e.methode === 'GET')

function banc (o = {}) {
  return monter({
    titulaire: o.titulaire !== false,
    appel: async (chemin) => {
      if (/^\/api\/ecran\/connaissance/.test(chemin)) {
        const bien = (/bien=(\w+)/.exec(chemin) || [])[1] || 'P1'
        return { ...ECRAN, bien: { ref: bien, nom: bien === 'P2' ? 'Cœur' : 'La bulle', photo: null } }
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

test('LE TEST QUI COMPTE : au téléphone, le bouton n ouvre PAS le tiroir — il mène à la page', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1',
    conversations: [{ bookId: 'B7', propertyId: 'P2', messages: [], lastNight: '2099-01-02' }], ouverte: 'B7' })
  b.msg.ouvrirTiroir(false)
  b.window.matchMedia = (q) => ({ matches: /max-width: 899px/.test(q), media: q, addEventListener () {}, removeEventListener () {} })
  // L'adresse : le logement du fil ouvert, et sa réservation pour l'aperçu.
  assert.equal(b.msg.urlConnaissance(), '/connaissance?bien=P2&resa=B7')
  clic(b, boutonVolet(b, 'connaissance'))
  await reposer(b)
  assert.equal(tiroirOuvert(b), false, 'pas de tiroir au téléphone')
  assert.equal(lecturesKb(b).length, 0, 'la page lira elle-même')
  assert.deepEqual(b.navigations, [{ forme: 'assign', adresse: '/connaissance?bien=P2&resa=B7' }])
  b.fermer()
})

test('sans fil ouvert, la page s ouvre sur le logement du tiroir, sans réservation', async () => {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1' })
  assert.equal(b.msg.urlConnaissance(), '/connaissance?bien=P1')
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
const CLE = 'hs-messages-saisie'
const noteSaisie = (b) => {
  const n = b.doc.querySelector('[data-bind="saisie-etat"]')
  return n.hidden ? null : n.textContent
}
const conv = (b) => new b.window.URL(b.window.location.href).searchParams.get('conv')

// Le téléphone, un fil ouvert (B7, logement P2), le tiroir fermé.
async function telephoneSurB7 (o = {}) {
  const b = banc()
  await amorcer(b)
  peupler(b, { biens: BIENS, volet: 'ia', bien: 'P1', conversations: [fil('B7', 'P2'), fil('B8', 'P1')],
    ouverte: 'B7', taches: o.taches || [] })
  b.msg.ouvrirTiroir(false)
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

test('LE TEST QUI COMPTE : au téléphone, l icône part vers la page du fil et GARDE le texte libre tapé', async () => {
  const b = await telephoneSurB7()
  b.doc.querySelector('[data-bind="texte"]').value = 'Bonjour, le code est '
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.deepEqual(b.navigations, [{ forme: 'assign', adresse: '/connaissance?bien=P2&resa=B7' }])
  assert.equal(tiroirOuvert(b), false, 'pas de tiroir au téléphone')
  assert.equal(lecturesKb(b).length, 0, 'la page lira elle-même')
  const garde = JSON.parse(b.window.sessionStorage.getItem(CLE))
  assert.equal(garde.texte, 'Bonjour, le code est ')
  assert.equal(garde.bookId, 'B7')
  assert.equal(garde.compte, 'U1', 'lié au compte')
  assert.ok(Math.abs(Date.now() - garde.t) < 5000, 'horodaté')
  assert.equal(conv(b), 'B7', 'le retour arrière rouvre le fil')
  b.fermer()
})

test('LE TEST QUI COMPTE : pendant un « Modifier », l icône ne quitte PAS la page, et le dit', async () => {
  // Son enregistrement part au `blur`, avant le clic, et rien ne permet d'en
  // attendre la fin ; gardé comme texte libre, son envoi ne validerait pas la
  // proposition, qui partirait AUSSI à son échéance (constats 1 et 2).
  const echeance = new Date(Date.now() + 3600e3).toISOString()
  const b = await telephoneSurB7({ taches: [{ id: 'T1', booking_id: 'B7', suggested_reply: 'Texte de l IA', send_after: echeance }] })
  b.msg.etat.enEdition = { bookId: 'B7', tacheId: 'T1' }
  const zone = b.doc.querySelector('[data-bind="texte"]')
  zone.value = 'Texte retouché'
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.deepEqual(b.navigations, [], 'on reste')
  assert.equal(noteSaisie(b), 'Envoyez d’abord la réponse modifiée, ou touchez « Ne pas envoyer » : la base de connaissance s’ouvre dans une autre page.')
  assert.equal(zone.value, 'Texte retouché', 'rien n est touché')
  assert.equal(b.window.sessionStorage.getItem(CLE), null, 'jamais gardé comme texte libre')
  assert.equal(conv(b), null)
  b.fermer()
})

test('LE TEST QUI COMPTE : un envoi en cours, n importe où, retient la page (constat 3)', async () => {
  const b = await telephoneSurB7()
  b.msg.etat.envois.set('B8', [{ texte: 'Bonjour', etatEnvoi: 'en_cours' }])
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.deepEqual(b.navigations, [])
  assert.equal(noteSaisie(b), 'Un message est en cours d’envoi : ouvrez la base de connaissance quand il est parti.')
  b.fermer()
  // Une proposition envoyée depuis sa bulle, elle aussi.
  const p = await telephoneSurB7({ taches: [{ id: 'T2', booking_id: 'B7', suggested_reply: 'x', etatEnvoi: 'en_cours' }] })
  clic(p, iconeSaisie(p))
  await reposer(p)
  assert.deepEqual(p.navigations, [])
  p.fermer()
})

test('un message « Non envoyé » de ce fil retient la page : il ne vit qu en mémoire', async () => {
  const b = await telephoneSurB7()
  b.msg.etat.envois.set('B7', [{ texte: 'Bonjour', etatEnvoi: 'echec' }])
  clic(b, iconeSaisie(b))
  await reposer(b)
  assert.deepEqual(b.navigations, [])
  assert.equal(noteSaisie(b), 'Un message n’est pas parti : touchez « Réessayer » avant d’ouvrir la base de connaissance.')
  b.fermer()
})

// ─── Le retour : le texte gardé est rendu UNE fois, au fil de l'adresse ────
// Le vrai chemin : `init()` de la page, avec `?conv=` dans l'adresse.
async function retour ({ adresse = '/messages?conv=B7', garde, saisieDejaRemplie = '' } = {}) {
  const b = monter({
    titulaire: true,
    appel: async (chemin) => {
      if (/^\/api\/messages\?limit=/.test(chemin)) return { conversations: [fil('B7', 'P2'), fil('B8', 'P1')] }
      return {}
    }
  })
  b.window.history.replaceState(null, '', adresse)
  if (garde) b.window.sessionStorage.setItem(CLE, JSON.stringify(garde))
  b.doc.querySelector('[data-bind="texte"]').value = saisieDejaRemplie
  await amorcer(b)
  await reposer(b)
  return b
}
const garde = (o = {}) => ({ compte: 'U1', bookId: 'B7', texte: 'Bonjour, le code est ', t: Date.now(), ...o })

test('LE TEST QUI COMPTE : au retour, le texte gardé revient dans la saisie de SON fil, une seule fois', async () => {
  const b = await retour({ garde: garde() })
  assert.equal(b.msg.etat.ouverte, 'B7')
  assert.equal(b.doc.querySelector('[data-bind="texte"]').value, 'Bonjour, le code est ')
  assert.equal(b.window.sessionStorage.getItem(CLE), null, 'lu et retiré')
  b.fermer()
})

test('LE TEST QUI COMPTE : le texte gardé ne revient ni dans un autre fil, ni pour un autre compte, ni périmé — et il est retiré', async () => {
  for (const [nom, o] of [
    ['autre fil', { garde: garde({ bookId: 'B8' }) }],
    ['autre compte', { garde: garde({ compte: 'U2' }) }],
    ['plus d une heure', { garde: garde({ t: Date.now() - 2 * 3600e3 }) }],
    ['retour sans fil', { adresse: '/messages', garde: garde() }]
  ]) {
    const b = await retour(o)
    assert.equal(b.doc.querySelector('[data-bind="texte"]').value, '', nom)
    assert.equal(b.window.sessionStorage.getItem(CLE), null, nom + ' : retiré quand même')
    b.fermer()
  }
})

test('le texte gardé n écrase pas une saisie que le navigateur a déjà remise', async () => {
  const b = await retour({ garde: garde(), saisieDejaRemplie: 'Autre chose' })
  assert.equal(b.doc.querySelector('[data-bind="texte"]').value, 'Autre chose')
  b.fermer()
})

test('un retour servi depuis le cache du navigateur retire le texte gardé : la page est revenue intacte', async () => {
  const b = await telephoneSurB7()
  b.window.sessionStorage.setItem(CLE, JSON.stringify(garde()))
  const ev = new b.window.Event('pageshow')
  Object.defineProperty(ev, 'persisted', { value: true })
  b.window.dispatchEvent(ev)
  assert.equal(b.window.sessionStorage.getItem(CLE), null)
  b.fermer()
})
