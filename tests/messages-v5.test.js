// tests/messages-v5.test.js — page « Messages » V5, lot 2 ETAPE 1 (lecture
// seule). Spec : docs/specs/spec-refonte-ui-v5-lot-messages.md §9.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')

const html = () => lire('pages/messages.html')

// ─── Regles V5 ───────────────────────────────────────────────────────────────
test('messages : aucun hexa, aucun emoji, aucune icone dessinee', () => {
  const src = sansCommentaires(html())
  assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(src), 'forme SVG dessinee dans la page')
})

test('messages : chaque cle de texte existe dans les trois langues', () => {
  const src = html()
  const cles = new Set([
    ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...src.matchAll(/data-i18n-attr="[^"]*?:([\w.]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1])
  ])
  assert.ok(cles.size > 10, 'extraction vide')
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(k in d, `${l} : cle « ${k} » absente`)
  }
})

test('messages : le point « non lu » et le robot d\'attente sont INFO, jamais ambre', () => {
  const css = lire('shared/ui.css')
  assert.ok(/\.conv__nonlu[^}]*var\(--info\)/.test(css), 'non lu = bleu info (l\'ambre dit « HôteSmart attend ta décision »)')
  assert.ok(/\.conv \.icon--robot[^}]*var\(--info\)/.test(css))
  const theme = lire('shared/theme.css')
  assert.ok((theme.match(/--info:/g) || []).length >= 2, '--info defini en clair ET en sombre')
})

// ─── Etape 1 : LECTURE SEULE ─────────────────────────────────────────────────
test('messages etape 2 : l\'envoi manuel route par la source, jamais un provider', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes("'/api/channel-message'") && src.includes("'/api/beds24'"),
    'les DEUX chemins de l\'ancienne page, choisis par la forme de la reference')
  assert.ok(src.includes("String(c.propertyId || '').includes('-')"), 'UUID = Channex, numerique = Beds24')
  assert.ok(!/channex\.io|beds24\.com/i.test(src), 'aucun appel provider direct (les endpoints internes sont le chemin normal)')
})

test('messages etape 2 : un echec d\'envoi garde le texte et propose Reessayer', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes("entree.etatEnvoi = 'echec'"), 'l\'entree reste dans etat.envois')
  assert.ok(src.includes('messages.not_sent') && src.includes('messages.retry'))
  assert.ok(src.includes('data-reessayer'), 'Reessayer rejoue le MEME envoi')
  assert.ok(!src.includes('envois.delete'), 'le texte n\'est jamais jete sur echec')
  const css = lire('shared/ui.css')
  assert.ok(/\.bulle--echec[^}]*var\(--danger\)/.test(css))
})

test('messages etape 2 : la saisie est RETIREE sans droit d\'ecriture', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('saisie.hidden = !peutEcrireMessages()'))
  assert.ok(src.includes("peutEcrire('messages')"), 'le droit vient de compte-courant')
})

test('messages etape 2 : read_at pose a l\'ouverture, et repondre vaut lecture', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes("{ action: 'lu', booking_id: String(bookId) }"), 'l\'ouverture poste action=lu')
  assert.ok(src.includes('nonLue(c) && peutEcrireMessages()'), 'un profil en lecture seule n\'ecrit pas')
  assert.ok(src.includes('dernierSortant'), 'repondre vaut lecture (reference = max(read_at, dernier sortant))')
  const api = sansCommentaires(lire('api/messages.js'))
  assert.ok(api.includes("req.body.action === 'lu'") && api.includes('marquerLu'))
  assert.ok(api.includes('pinned: false'), 'une ligne creee par le marquage n\'epingle pas (la colonne nait true)')
  assert.ok(/domaine: 'messages', niveau: 'write', compteDelegue: true \}\)\n  if \(!garde\.ok\) return\n  const userId = garde\.accountUserId\n  const bookingId/.test(api.replace(/\r/g, '')), 'marquerLu est garde en ecriture')
})

test('messages etape 2 : pagination SERVEUR, arrivees toujours en premiere page', () => {
  const api = sansCommentaires(lire('api/messages.js'))
  assert.ok(api.includes("Number.parseInt(req.query.limit, 10)"))
  assert.ok(api.includes('req.query.before'))
  assert.ok(api.includes('has_more') && api.includes('next_before'))
  assert.ok(/if \(!before\) \{\s*for \(const c of conversations\) if \(arrivee\(c\)/.test(api), 'les arrivees j/j+1 ne peuvent pas attendre la page 2')
  const src = sansCommentaires(html())
  assert.ok(src.includes('chargerPageSuivante') && src.includes('next_before'), 'la page consomme le curseur')
})

test('messages etape 2 : les correctifs de la revue de af57948 tiennent', () => {
  const api = sansCommentaires(lire('api/messages.js'))
  // 1. Curseur COMPOSITE : deux fils a la meme seconde restent atteignables,
  //    et un lastTime nul a la frontiere ne ment plus (next_before '').
  assert.ok(api.includes('before_id') && api.includes('next_before_id'))
  assert.ok(api.includes("t < before || (t === before && id < beforeId)"))
  // 9. Le marquage lu porte le perimetre par bien, comme l'archivage.
  assert.ok(/marquerLu[\s\S]{0,2500}property_id_ref: String\(bien\)/.test(api))
  const prop = sansCommentaires(lire('api/guestflow-proposer.js'))
  // 3. Le fil se lit par les plus RECENTS (desc 1000), comme le cron.
  assert.ok(prop.includes("ascending: false }).limit(1000)") && prop.includes('.reverse()'))
  const src = sansCommentaires(html())
  // 2+7. Statuts exclus PARTAGES (module commun), plus aucune copie locale.
  assert.ok(src.includes('STATUTS_SANS_SEJOUR') && !/SANS_ARRIVEE|const SANS_SEJOUR/.test(src))
  assert.ok(lire('shared/aujourdhui.js').includes('export const STATUTS_SANS_SEJOUR'))
  // 6. Le rang se precalcule avant le tri.
  assert.ok(/\.map\(c => \(\{ c, rg: rang\(c\)/.test(src))
  // 8. Plus d'etat mort ni de regle perimee en commentaire.
  assert.ok(!src.includes('etat.limite'))
  assert.ok(!html().includes('dernier message < 7 jours'), 'commentaire perime retire')
})

test('guestflow-proposer : reutilise le cron, cle sur la REFERENCE provider, ne court-circuite pas les alertes', () => {
  const api = sansCommentaires(lire('api/guestflow-proposer.js'))
  assert.ok(/require\('\.\.\/lib\/cron-classify'\)/.test(api), 'generation = celle du cron, rien de duplique')
  assert.ok(api.includes('peutAppeler') && api.includes('noterAppel'), 'la garde de cout du cron s\'applique')
  assert.ok(api.includes('const refBien = String(bien.provider_property_id)'), 'agent_tasks/knowledge/garde cles sur la reference TEXT, jamais l\'UUID')
  assert.ok(api.includes('property_id: refBien'))
  assert.ok(/if \(!classification\.auto_reply\)[\s\S]{0,400}proposition: false/.test(api), 'intervention : RIEN depose, le cron alertera (sinon sa garde se tairait)')
  assert.ok(/domaine: 'messages', niveau: 'write'/.test(api))
  assert.ok(api.includes("status: 'pending_validation'"))
})

test('messages : une proposition d\'une conversation FERMEE n\'apparait pas (regle du lot 1, partagee)', () => {
  const src = sansCommentaires(html())
  assert.ok(/import \{[^}]*tachesOuvertes[^}]*\} from '\/shared\/aujourdhui\.js'/.test(src),
    'la regle vient du module partage, jamais recopiee')
  assert.ok(/etat\.taches = tachesOuvertes\(/.test(src), 'et elle est APPLIQUEE')
  assert.ok(!/in\('status', \['pending', /.test(src), 'seules les pending_validation alimentent la page')
})

test('messages : aucun appel provider, X-Compte partout', () => {
  const src = sansCommentaires(html())
  // `/api/beds24` et `/api/channel-message` sont NOS endpoints (l'envoi route
  // par la source cote serveur) : seuls les domaines provider et les endpoints
  // qui interrogent un provider en LECTURE sont interdits ici.
  for (const interdit of ['/api/channel-property', '/api/channel-mapping', 'beds24.com', 'channex.io']) {
    assert.ok(!src.toLowerCase().includes(interdit.toLowerCase()), `appel interdit : ${interdit}`)
  }
  for (const m of src.matchAll(/fetch\(/g)) {
    assert.ok(src.slice(m.index, m.index + 300).includes('enteteCompte()'), 'fetch sans X-Compte')
  }
})

test('messages : sur telephone, le fil ouvert masque la barre du bas', () => {
  const css = lire('shared/ui.css')
  assert.ok(/body\[data-fil\] \.bottombar \{ display: none; \}/.test(css))
  const src = sansCommentaires(html())
  assert.ok(src.includes("document.body.dataset.fil = '1'") && src.includes('delete document.body.dataset.fil'))
})

test('messages : les correctifs de la revue de acf0fa0 tiennent', () => {
  const src = sansCommentaires(html())
  const css = lire('shared/ui.css')
  // 1. Le retour du fil couvre TOUTE la plage du fil plein ecran (<900px).
  assert.ok(src.includes('msg-retour') && !/only-mobile" data-bind="retour"/.test(src))
  assert.ok(css.includes('@media (max-width: 899px) {' + String.fromCharCode(10) + '  .msg-retour { display: inline-flex; }'))
  // 2. Un sejour annule ne tient pas une proposition ouverte.
  assert.ok(src.includes('STATUTS_SANS_SEJOUR'), 'les statuts exclus viennent du module partage')
  // 3. La garde de date vaut pour la LISTE comme pour le fil.
  assert.ok(src.includes("function heureCourte (iso) {" + String.fromCharCode(10) + "  if (!valide(iso)) return ''"))
  // 5. Coche verte distincte du bleu d'attente.
  assert.ok(src.includes("icone('i-check', 'icon icon--fait')"))
  assert.ok(/\.conv \.icon--fait[^}]*var\(--ok\)/.test(css))
  // 6. Canal inconnu neutre, jamais le A d'Airbnb.
  assert.ok(src.includes("lettreCanal") && !src.includes("(c.ota || '?')[0]"))
  // 4. Echec de chargement : aucun compte, aucun badge calcules sur du vide.
  assert.ok(src.includes("etat.chargementOk === false) { $('.msg-liste__outils').hidden = true"))
  assert.ok(src.includes('etat.chargementOk ? { pendingMessages'))
  // 7. Index des taches par reservation.
  assert.ok(src.includes('tachesParResa'))
})

test('messages : les arrivees du jour et de demain sont CONSERVEES (inventaire §12)', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('function groupeArrivee'), 'le groupe d\'arrivee existe')
  assert.ok(src.includes('return g < 2 ? g : tachesDe(c).length ? 2'),
    'arrivees du JOUR en tete, demain ensuite, AVANT les « a valider » (decision du 11 octobre)')
  assert.ok(src.includes('msg-groupe'), 'etiquettes de groupe « Arrive aujourd\'hui / demain »')
  assert.ok(src.includes('msg-separe'), 'separation visuelle avec le reste de la liste')
  assert.ok(/badgeArrivee[\s\S]{0,800}lienTelephone\(c\)/.test(src), 'le telephone vit dans la LIGNE pour les arrivees')
  assert.ok(src.includes("icone('i-phone'"), 'logo telephone, pas le mot « Appeler » (il reste en aria-label)')
  assert.ok(src.includes("num.startsWith('00')") && src.includes('33'), 'un numero « 33… » sans le plus est retabli en +33')
  assert.ok(lire('shared/icons.svg').includes('id="i-phone"'))
  assert.ok(src.includes('messages.arrives_today') && src.includes('messages.arrives_tomorrow'))
  assert.ok(src.includes("c.arrivee?.menage === 'fait'"), 'pastille menage POSITIVE seulement')
  assert.ok(src.includes('function lienTelephone'), 'le telephone en lien d\'appel')
  assert.ok(/groupeArrivee\(c\) > 1 \|\| !c\.guestPhone/.test(src), 'le tel reste borne aux arrivees j / j+1')
  assert.ok(src.includes('STATUTS_SANS_SEJOUR'), 'une annulee n\'est pas une arrivee (statuts du module partage)')
})

test('messages : miniature du logement et logos de canal (demande du 11 octobre)', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('function avatarConv'), 'le grand cercle porte la photo du bien')
  assert.ok(src.includes('bien?.photo'), 'repli : les initiales quand pas de photo')
  assert.ok(src.includes("icone('i-canal-airbnb'"), 'le belo Airbnb vient du sprite')
  assert.ok(src.includes("'B.'"), 'le logo Booking est son « B. »')
  const theme = lire('shared/theme.css')
  for (const tk of ['--canal-airbnb', '--canal-booking', '--canal-direct', '--on-canal']) {
    assert.ok(theme.includes(tk + ':'), `jeton ${tk} dans theme.css (seul fichier a hexas)`)
  }
  const css = lire('shared/ui.css')
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(css), 'aucune couleur de marque en dur hors theme.css')
})

test('icons.svg : XML valide, et JAMAIS de double tiret dans un commentaire', () => {
  // Vecu du 11 octobre 2026 : « .icon--fill » cite dans un commentaire a coupe
  // l'analyse du sprite — tous les symboles suivants (belo compris)
  // disparaissaient, sans erreur visible.
  const svg = lire('shared/icons.svg')
  for (const m of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!m[1].includes('--'), 'double tiret dans un commentaire XML : le sprite casse a partir de la')
  }
  assert.ok(svg.includes('id="i-canal-airbnb"'))
  const apres = svg.slice(svg.indexOf('i-canal-airbnb'))
  assert.ok(apres.includes('id="i-help"') && apres.includes('id="i-logout"'),
    'les symboles places APRES le belo restent atteignables')
})

// ─── Branchements ────────────────────────────────────────────────────────────
test('l\'onglet Messages mene a la nouvelle page, l\'ancienne messagerie ne vit plus dans aucun menu', () => {
  assert.ok(lire('shared/nav.js').includes("href: '/pages/messages'"))
  assert.ok(!lire('shared/nav.js').includes('agent-ai/messagerie'))
  assert.ok(!sansCommentaires(lire('components/sidebar.js')).includes('agent-ai/messagerie'),
    'la barre laterale des anciens ecrans ne pointe plus l\'ancienne messagerie')
})

test('la reecriture /messages est posee sans .html (cleanUrls)', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  const r = vercel.rewrites.find(x => x.source === '/messages')
  assert.ok(r && r.destination === '/pages/messages')
})

test('messages : l\'ouverture directe ?conv= exige que le fil existe', () => {
  const src = sansCommentaires(html())
  assert.ok(/etat\.conversations\.some\([\s\S]{0,120}?demandee/.test(src),
    'jamais un ecran « introuvable » depuis un lien interne')
})

// ─── Etape 3 : propositions dans le fil (Envoyer / Modifier / Rejeter) ───────
test('messages etape 3 : Envoyer suit le chemin de l\'ancienne page, jamais un second chemin', () => {
  const src = sansCommentaires(html())
  // posterMessage d'abord (routage par source), la cloture ensuite — et le
  // statut RELU juste avant (deux onglets = pas de double message, revue).
  assert.ok(/async function envoyerProposition[\s\S]*?pending_validation[\s\S]*?await posterMessage\(c, texte\)[\s\S]*?await cloreTache\(x, 'done'/.test(src),
    'statut relu, envoi par posterMessage PUIS cloture — la sequence de messagerie.html')
  assert.ok(/if \(!texte\) return/.test(src), 'jamais un message vide (revue de 06e6d50)')
  assert.ok(/\$\{texteProp \? `<button/.test(src), 'sans texte propose : ni Envoyer ni Modifier')
  assert.ok(src.includes("action: 'proposition'"), 'la cloture passe par /api/messages')
  // L'echec d'envoi laisse la proposition en attente avec Reessayer.
  assert.ok(/envoi proposition[\s\S]*?x\.etatEnvoi = 'echec'/.test(src), 'echec = proposition conservee')
})

test('messages etape 3 : Modifier descend le texte, et l\'envoi porte l\'avatar hote', () => {
  const src = sansCommentaires(html())
  assert.ok(/function modifierProposition[\s\S]*?zone\.value = x\.suggested_reply/.test(src), 'le texte descend dans la saisie')
  assert.ok(src.includes('etat.enEdition = { tacheId: x.id'), 'la proposition se masque pendant l\'edition')
  // Apres Modifier, c'est lancerEnvoi (envoi MANUEL) qui clot : kind message,
  // donc avatar hote — jamais le robot pose a la main.
  assert.ok(/if \(entree\.valideTache\)[\s\S]*?await cloreTache\(x, 'done', entree\.texte, c\)/.test(src),
    'l\'envoi apres Modifier valide la proposition — par l\'ENTREE du geste, pas tout envoi du fil (revue)')
  assert.ok(/function envoyer \(\)[\s\S]*?entree\.valideTache = ed\.tacheId/.test(src),
    'le marquage nait dans envoyer(), le Reessayer d\'un autre message ne clot rien')
  assert.ok(/window\.confirm\(t\('messages\.draft_replace'\)\)/.test(src),
    'un brouillon ne s\'ecrase pas en silence (revue)')
  assert.ok(!/kind: 'auto'/.test(src), 'la page ne fabrique jamais une bulle robot (le coeur ecrit kind message)')
})

test('messages etape 3 : Rejeter vit dans le menu, et les boutons disparaissent sans droit d\'ecriture', () => {
  const src = sansCommentaires(html())
  assert.ok(/<details class="bulle-menu">[\s\S]*?data-rejeter/.test(src), 'Rejeter dans le menu (spec §3.3)')
  assert.ok(/peutEcrireMessages\(\) && !enCoursEnvoi \? `<span class="bulle__actions">/.test(src),
    'profil en lecture : AUCUN bouton dans le DOM (spec §9)')
  assert.ok(/async function rejeterProposition[\s\S]*?cloreTache\(x, 'ignored'/.test(src),
    'rejet = statut ignored, celui de l\'ancienne page')
  assert.ok(/statut === 'ignored'[\s\S]*?messages\.reject_failed/.test(src),
    'un rejet non enregistre ne disparait pas de l\'ecran (revue de 06e6d50)')
})

test('messages etape 3 : la cloture retire la tache et met le badge a jour', () => {
  const src = sansCommentaires(html())
  assert.ok(/async function cloreTache[\s\S]*?etat\.taches = etat\.taches\.filter[\s\S]*?majBadge\(\)/.test(src),
    'une seule source de verite : agent_tasks, et le badge suit')
  assert.ok(/function majBadge[\s\S]*?pendingMessages: etat\.taches\.length/.test(src))
})

test('api/messages action=proposition : garde write, perimetre, statuts de l\'ancienne page, course fermee', () => {
  const src = lire('api/messages.js')
  const bloc = src.slice(src.indexOf('async function cloreProposition'), src.indexOf('async function archiverFil'))
  assert.ok(bloc.length > 100, 'cloreProposition present')
  assert.ok(/domaine: 'messages', niveau: 'write', compteDelegue: true/.test(bloc), 'ecriture du domaine messages')
  assert.ok(/refsDuPerimetre[\s\S]*?status\(404\)/.test(bloc), 'hors perimetre = 404, jamais 403')
  assert.ok(bloc.includes("'done'") && bloc.includes("'ignored'") && !bloc.includes("'rejected'"),
    'les statuts de l\'ancienne page, pas une seconde famille')
  assert.ok(/\.update\(\{ status: statut \}\)[\s\S]*?\.eq\('status', 'pending_validation'\)/.test(bloc),
    'l\'UPDATE conditionne par le statut ferme la course entre deux clics')
  assert.ok(/deja_close/.test(bloc), 'une tache deja close se dit, ne se re-ecrit pas')
  // Le journal de l'ancienne page, memes colonnes.
  assert.ok(/from\('conversations'\)\.insert\(\{[\s\S]*?guest_message: tache\.guest_message, agent_reply: texte, book_id: String\(tache\.book_id\)/.test(bloc),
    'le journal conversations de messagerie.html, a l\'identique')
  assert.ok(src.includes("req.body.action === 'proposition'"), 'route branchee')
  assert.ok(/texte\.length > 10000/.test(bloc), 'texte borne comme les autres champs (revue)')
})
