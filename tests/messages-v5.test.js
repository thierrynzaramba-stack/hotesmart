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
  // 3 et 5 : l'heure de la liste et l'apercu du dernier message (et sa coche
  // verte) ont DISPARU avec la retouche du 12 octobre — plus de garde
  // heureCourte ni de coche a proteger ; la ligne garde nom, bien + dates,
  // telephone, robot, epingle, point non lu.
  assert.ok(!src.includes('heureCourte') && !src.includes('conv__apercu'),
    'ni heure ni extrait dans la liste (retouche du 12 octobre)')
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
  assert.ok(src.includes('return g < 2 ? g : c.epinglee ? 2 : tachesDe(c).length ? 3'),
    'arrivees du JOUR en tete, demain ensuite, AVANT epinglees et « a valider » (decision du 11 octobre)')
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
  assert.ok(/async function envoyerProposition[\s\S]*?pending_validation[\s\S]*?await posterMessage\(c, texte, 'ia_validee'\)[\s\S]*?await cloreTache\(x, 'done'/.test(src),
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
  assert.ok(/if \(entree\.valideTache\)[\s\S]*?await cloreTache\(x, 'done', entree\.texte, c, 'ia_modifiee'\)/.test(src),
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

// ─── Etape 4 : Test/Auto, tiroir reglages, redirections ──────────────────────
test('messages etape 4 : passer en Auto exige une confirmation, et l\'etat est RELU apres l\'ecriture', () => {
  const src = sansCommentaires(html())
  assert.ok(/nouveau === 'auto' && !window\.confirm\(t\('messages\.mode_confirm_auto'\)\)/.test(src),
    'Auto est un geste lourd : confirmation explicite avant (demande de Thierry)')
  // Apres le POST : un GET de relecture nourrit l'interrupteur — jamais
  // l'etat suppose. Idem pour la pause.
  assert.ok(/await appel\('\/api\/agent-config', \{ mode_ref: ref, mode: nouveau \}\)[\s\S]*?await appel\('\/api\/agent-config'\)[\s\S]*?etat\.modes = modesDe\(relu\.config\)/.test(src),
    'le mode affiche vient de la base relue')
  assert.ok(/await appel\('\/api\/property-automation', \{ provider_property_id[\s\S]*?await appel\('\/api\/property-automation'\)[\s\S]*?etat\.pauses = relu\.paused/.test(src),
    'la pause affichee vient de la base relue')
  // L'ecriture est un POST CIBLE : le MERGE du seul mode vit au SERVEUR
  // (deux onglets s'ecrasaient des configs d'alertes, releve en review).
  const api = lire('api/agent-config.js')
  assert.ok(/mode_ref/.test(api) && /\? \{ \.\.\.\(blob\[ref\] \|\| \{\}\), mode \}/.test(api),
    'agent-config merge le seul mode du bien dans le blob relu en base')
  assert.ok(/mode !== 'test' && mode !== 'auto'/.test(api), 'mode borne a test|auto')
})

test('messages etape 4 : les reglages IA sont reserves au TITULAIRE (dette 68)', () => {
  // agent-config et le GET de property-automation n'honorent pas X-Compte :
  // ouverts a un delegue, l'ecran lirait et ecrirait le MAUVAIS compte sans
  // erreur (releve en review). Gating estTitulaire() jusqu'a l'audit.
  const src = sansCommentaires(html())
  assert.ok(/const reglagesIci = \(\) => \{ try \{ return estTitulaire\(\) \}/.test(src),
    'la garde est le titulaire, pas le droit reglages du compte courant')
  assert.ok(/reglagesIci\(\) \? \[\s*appel\('\/api\/agent-config'\)/.test(src),
    'la config IA n\'est pas demandee autrement')
  assert.ok(/b\.hidden = !reglagesIci\(\)/.test(src), 'les deux boutons d\'en-tete disparaissent sans titulaire')
  assert.ok(/mode !== null \?/.test(src), 'le volet IA ne montre pas un mode illisible')
  // Et l'echec d'une bascule de pause SE DIT (dans le tiroir sur mobile).
  assert.ok(/function noteReglage/.test(src) && /\(etat\.pauses\[ref\] === true\) !== paused/.test(src),
    'un kill switch qui n\'a pas pris s\'affiche, jamais silencieux')
})

test('etape 4 : l\'ancienne messagerie et l\'ancienne config GuestFlow sont des redirections', () => {
  // Depuis le go de Thierry du 12 octobre (apres recette 2 en prod), les
  // TROIS pages de l'ancienne app redirigent : plus aucune n'ecrit en direct.
  for (const [page, attendu] of [
    ['apps/agent-ai/messagerie.html', "location.replace('/messages' + (conv ? '?conv=' + encodeURIComponent(conv) : ''))"],
    ['apps/agent-ai/config.html', "location.replace('/messages?volet=ia')"],
    ['apps/agent-ai/messages.html', "location.replace('/messages?volet=programmes')"]
  ]) {
    const src = lire(page)
    assert.ok(src.includes(attendu), `${page} redirige vers /messages`)
    // Plus AUCUNE lecture provider ni ecriture RLS directe : la dette 43
    // (filet legacy Beds24) et les ecritures agent_tasks/conversations de
    // l'ancienne page sont closes par la redirection. (Hors commentaires :
    // l'en-tete de la redirection RACONTE ce qui a disparu.)
    const code = sansCommentaires(src)
    for (const interdit of ['/api/beds24', 'supabase', 'agent_tasks', "from('conversations')", 'fetch(']) {
      assert.ok(!code.includes(interdit), `${page} ne doit plus contenir ${interdit}`)
    }
  }
})

test('etape 4 : plus aucun lien vers l\'ancienne app, hors Connaissances', () => {
  const accueil = lire('pages/aujourdhui.html')
  assert.ok(!accueil.includes('agent-ai'), 'l\'accueil pointe /messages')
  assert.ok(/\/messages\?conv=/.test(accueil), 'les « Voir » ouvrent le fil dans la nouvelle page')
  const resa = lire('shared/calendrier-resa.js')
  assert.ok(resa.includes("'/messages?conv=' + encodeURIComponent(resa.id)"),
    'urlConversation (module partage des deux calendriers) pointe /messages')
  // La nouvelle page garde UN SEUL lien vers l'ancienne app : Connaissances.
  const page = html()
  const liens = [...page.matchAll(/agent-ai\/([\w-]+)/g)].map(m => m[1])
  assert.deepEqual([...new Set(liens)], ['knowledge'],
    'seul Connaissances survit (le renvoi provisoire est parti avec la redirection)')
  // Et la barre laterale des anciennes pages ne liste plus que Connaissances.
  const sidebar = lire('components/sidebar.js')
  assert.ok(!sidebar.includes('agent-ai/messages') && !sidebar.includes('agent-ai/config'),
    'Envoi programme et Configuration retires de la sidebar')
})

// ─── Recette 1 du changement de perimetre : volets IA + Alertes ──────────────
test('tiroir : l\'inventaire §12 bis (volets IA + Alertes) est couvert, champ par champ', () => {
  // Demande de Thierry (12 octobre) : ce test NOMME chaque champ manquant.
  const src = html()
  const CHAMPS = {
    'mode Test/Auto par bien': 'data-tiroir-mode',
    'kill switch (pause) par bien': 'data-tiroir-pause',
    'consignes generales de l\'IA': 'data-consignes="global"',
    'consignes du logement': 'data-consignes="bien"',
    'enregistrer les consignes': 'data-consignes-save',
    'intervention / SMS actif': 'data-alerte="${k}|sms_enabled"',
    'intervention / destinataires SMS': 'data-alerte="${k}|sms_lines"',
    'intervention / e-mail actif': 'data-alerte="${k}|email_enabled"',
    'intervention / destinataires e-mail': 'data-alerte="${k}|email_lines"',
    'les DEUX types d\'alerte': "[['intervention', 'messages.alert_intervention'], ['info_unknown', 'messages.alert_info']]",
    'bouton Tester par canal': 'data-tester',
    'enregistrer les alertes': 'data-alertes-save',
    'porte SMS sans cle Brevo (lien /connexions)': 'messages.sms_needs_brevo',
    'garde des appels IA (circuit breaker, en etat)': 'messages.breaker_desc',
    'ce qu\'il valide seul (Auto)': 'messages.auto_scope',
    'lien Connaissances': 'agent-ai/knowledge',
    'choix du logement en tete du panneau': 'data-bind="tiroir-bien"',
    'bouton Messages programmes (en-tete)': 'data-ouvre-volet="programmes"',
    'bouton Reponses de l\'IA (en-tete)': 'data-ouvre-volet="ia"',
    'alertes EN BAS du volet IA': "voletAlertes(ref)"
  }
  // Et les verrous de la revue de ddfc88a :
  assert.ok(/\[hidden\] \{ display: none !important; \}/.test(lire('shared/ui.css')),
    'hidden gagne TOUJOURS (regle generale, pas une rustine par selecteur)')
  // (le renvoi provisoire sans bien a vecu : le VRAI volet programmes depend
  // du bien choisi, et ses donnees ne se chargent qu'a l'OUVERTURE du volet)
  assert.ok(/etat\.templatesBien !== ref \|\| etat\.templates === undefined/.test(sansCommentaires(src)),
    'les messages programmes se chargent a l\'ouverture du volet, pas au boot')
  assert.ok(/aria-expanded', String\(ouvert && etat\.tiroirVolet === b\.dataset\.ouvreVolet\)/.test(src),
    'les boutons annoncent l\'etat du volet')
  // Les redirections rouvrent le bon volet, et JS coupe a son repli.
  assert.ok(/voletDemande === 'ia' \|\| voletDemande === 'programmes'\) && reglagesIci\(\)/.test(src),
    '?volet= honore a l\'arrivee, titulaire seulement')
  for (const page of ['apps/agent-ai/config.html', 'apps/agent-ai/messages.html']) {
    assert.ok(/http-equiv="refresh" content="0;url=\/messages\?volet=/.test(lire(page)),
      page + ' : repli meta refresh (JS bloque = page blanche sinon)')
  }
  const manquants = Object.entries(CHAMPS)
    .filter(([, motif]) => !src.includes(motif))
    .map(([nom]) => nom)
  assert.deepEqual(manquants, [],
    'champs de l\'inventaire §12 bis ABSENTS du tiroir : ' + manquants.join(' ; '))
})

test('tiroir alertes : merge serveur borne, SMS preserve sans Brevo, test depuis la BASE', () => {
  const api = lire('api/agent-config.js')
  assert.ok(api.includes('alertes_ref') && /for \(const type of \['intervention', 'info_unknown'\]\)/.test(api),
    'le POST cible merge les DEUX types au serveur (jamais le blob entier depuis l\'ecran)')
  assert.ok(/length > 2000/.test(api), 'destinataires bornes champ par champ')
  const src = sansCommentaires(html())
  assert.ok(/sms_enabled: etat\.brevo[\s\S]{0,120}avant\[k\] && avant\[k\]\.sms_enabled/.test(src),
    'sans cle Brevo, les champs SMS absents de l\'ecran PRESERVENT la base')
  assert.ok(/const relu = await appel\('\/api\/agent-config'\)[\s\S]*?etat\.configIA = relu\.config/.test(src),
    'l\'ecran montre la base RELUE apres chaque enregistrement')
  assert.ok(/'\/api\/alert-test', \{ channel: canal, to \}/.test(src), 'le test passe par alert-test')
  assert.ok(/\(etat\.configIA\[ref\] \|\| \{\}\)\[type\]/.test(src),
    'le destinataire du test vient de la base ENREGISTREE (piege documente par l\'ancienne page)')
  // Les consignes : meme table, mais INSERT d'abord puis delete des AUTRES
  // lignes, chaque erreur lue — plus de fenetre de perte ni de doublons
  // silencieux (releve en review de 634ee15).
  assert.ok(/\.insert\(\{ user_id: uid, property_id: propertyId, instructions: texte \}\)\.select\('id'\)/.test(src)
    && /\.neq\('id', neuve\.id\)/.test(src) && /if \(eD\) throw eD/.test(src),
    'agent_prompting : insert d\'abord, delete des autres, erreurs lues')
})

test('tiroir : une lecture echouee FERME le volet, elle ne montre jamais un faux vide', () => {
  // Un formulaire vide enregistre aurait efface destinataires et consignes
  // de la base (releve en review de 634ee15).
  const src = sansCommentaires(html())
  assert.ok(/etat\.modes = null; etat\.configIA = null/.test(src), 'blob illisible = volet Alertes ferme')
  assert.ok(/if \(etat\.configIA === null\) \{\s*return `<p/.test(src), 'le volet Alertes le dit au lieu de se rendre')
  assert.ok(/etat\.prompting = null; return/.test(src), 'consignes illisibles = bloc ferme')
  assert.ok(/etat\.prompting === null \? `<p/.test(src), 'et le bloc le dit')
  // Pendant une ecriture, les champs gelent (une frappe serait ecartee).
  assert.ok(/function geler \(corps, fige\)/.test(src) && /geler\(corps, true\)/.test(src), 'champs geles pendant le POST')
  // Le test refuse une edition non enregistree (il partirait a l'ANCIEN destinataire).
  assert.ok(/ecran\.value\.trim\(\) !== lignes\.trim\(\)/.test(src), 'tester exige l\'ecran = la base')
  // Et le serveur refuse un POST a double cible.
  assert.ok(/viseMode && viseAlertes/.test(lire('api/agent-config.js')), 'une cible par requete')
})

// ─── Recette 2 : volet « Messages programmes » (inventaire §12 bis B) ────────
test('programmes : le module partage reste fidele aux listes relevees de l\'ancienne app, ecart nomme', () => {
  // L'ancienne app est une REDIRECTION depuis le 12 octobre 2026 : les
  // temoins ci-dessous sont ses litteraux, releves avant sa disparition
  // (git 89cd48e, apps/agent-ai/messages.html) et prouves sur les 11
  // messages reels par scripts/verifier-parite-templates.js (0 ecart).
  // Ils FIGENT le contrat : une valeur retiree du module perdrait les
  // templates en base qui la portent.
  const module_ = lire('shared/messages-programmes.js')
  const ecarts = []
  if (!module_.includes("delais: ['5min', '15min', '1h', '2h', '4h', '8h', '24h']")) ecarts.push('delais booking_confirmed divergents')
  if (!module_.includes("delais: ['0min', '10min', '30min', '1h', '2h']")) ecarts.push('delais menage_done divergents')
  if (!module_.includes('[-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7]')) ecarts.push('jours divergents')
  for (const cle of ["event_type: 'arrival'", "reference: 'arrival'", 'offset_days: -1', "send_time: '10:00'",
    "earliest_send_time: '15:00'", 'send_anyway: true', 'active: true', "template_text: ''", 'lock_id: null']) {
    if (!module_.includes(cle)) ecarts.push(`defaut du module divergent : ${cle}`)
  }
  if (!/eventType === 'departure' \? 'departure'\s*: eventType === 'booking_confirmed' \? 'booking' : 'arrival'/.test(module_)) {
    ecarts.push('mapping reference divergent')
  }
  assert.deepEqual(ecarts, [], 'parite rompue : ' + ecarts.join(' ; '))
})

test('programmes : memes writers RLS que l\'ancienne app, confirmation avant suppression', () => {
  const src = sansCommentaires(html())
  assert.ok(/from\('message_templates'\)\.update\(\{\s*event_type: v\.event_type, reference: referenceDe\(v\.event_type\),\s*offset_days: v\.offset_days, offset_value: v\.offset_value,\s*send_time: v\.send_time, earliest_send_time: v\.earliest_send_time \|\| '15:00',\s*send_anyway: v\.send_anyway, active: v\.active,\s*template_text: v\.template_text, lock_id: v\.lock_id \|\| null/.test(src),
    'l\'UPDATE de l\'ancienne app, memes colonnes')
  assert.ok(/\.insert\(\{ user_id: compteCourant\(\), property_id: ref, \.\.\.DEFAUTS_NOUVEAU_PROGRAMME \}\)/.test(src),
    'le Nouveau pose les defauts du module partage')
  assert.ok(/window\.confirm\(t\('messages\.prog_delete_confirm'\)\)/.test(src),
    'la suppression se confirme (geste destructif)')
  // Les verrous de la revue de 49c6ad4 :
  assert.ok(/function sauverTextesProgrammes/.test(src) && /sauverTextesProgrammes\(\)\n/.test(src),
    'TOUS les brouillons survivent a un re-render, pas seulement la carte touchee')
  assert.ok(/if \(champ === 'event_type'\) reinitialiserMoment\(v\)/.test(src),
    'changer l\'evenement reinitialise le moment (regle de l\'ancienne app)')
  assert.ok(/textarea, input, button, select/.test(src), 'geler fige aussi les select')
  assert.ok(/if \(tpl\.error \|\| verrous\.error\)/.test(src),
    'des serrures illisibles ferment le volet (un select mensonger detruisait lock_id)')
  assert.ok(/etat\.templates = undefined\n/.test(src.replace(/\r/g, '')) || /etat\.templates = undefined/.test(src),
    'undefined des le depart du chargement (pas les cartes de l\'ancien bien)')
  assert.ok(/v\.apercuEnCours/.test(src), 'pas d\'appels IA concurrents sur Apercu')
  assert.ok(/\.select\(\)\.single\(\)/.test(src), 'la ligne RELUE remplace l\'etat local')
  // Lecture echouee = volet ferme (regle des alertes).
  assert.ok(/etat\.templates = null/.test(src) && /etat\.templates === null/.test(src),
    'un volet illisible se FERME, il ne montre pas un faux vide')
})

test('programmes : Apercu AI sur bouton EXPLICITE seulement, par /api/grok', () => {
  const src = sansCommentaires(html())
  assert.ok(/data-prog-apercu/.test(src) && /appel\('\/api\/grok'/.test(src),
    'le chemin de l\'ancienne app (wrapper interne, jamais un provider)')
  // Jamais declenche a l'ouverture ni a la saisie (consigne de Thierry) :
  // apercuProgramme n'est appele QUE par le click du bouton.
  const appels = [...src.matchAll(/apercuProgramme\s*\(/g)].length
  assert.strictEqual(appels, 2, 'une definition + un seul appel (le click)')
  assert.ok(/\[data-prog-apercu\]'\)\.forEach\(x => x\.addEventListener\('click'/.test(src.replace(/\n/g, ' ')) || /data-prog-apercu.*addEventListener\('click'/.test(src.replace(/\n/g, ' ')),
    'declenche par click uniquement')
  assert.ok(!/addEventListener\('input', [^)]*apercu/i.test(src), 'jamais a la saisie')
})

// ─── Dettes 66 + 67 : origine des envois, evaluation au depart ───────────────
test('dette 66 : l\'origine est posee A L\'ENVOI par les writers, liste FERMEE', () => {
  const rm = lire('lib/record-message.js')
  assert.ok(/const ORIGINES = new Set\(\['ia_validee', 'ia_modifiee', 'hote', 'ia_auto'\]\)/.test(rm),
    'la liste fermee vit dans le writer commun')
  assert.ok(/origine inconnue ignoree/.test(rm) && /colonneOrigineAbsente/.test(rm),
    'valeur inconnue = null logge ; migration absente = repli sans casser l\'envoi')
  // Les deux endpoints de page REFUSENT ia_auto (reserve au cron).
  for (const f of ['api/channel-message.js', 'api/beds24.js']) {
    const src = lire(f)
    assert.ok(/'ia_validee', 'ia_modifiee', 'hote'/.test(src) && !/'ia_auto'/.test(src.replace(/\/\/[^\n]*/g, '')),
      f + ' : liste client a trois valeurs, jamais ia_auto depuis une page')
  }
  // La reponse generee par l'IA et partie seule porte ia_auto ; les templates
  // programmes (cron-messages, cron-arrival-code) restent SANS origine.
  assert.ok(/origine:\s+'ia_auto'/.test(lire('lib/cron-classify.js')), 'cron-classify pose ia_auto')
  assert.ok(!/origine/.test(sansCommentaires(lire('lib/cron-messages.js'))), 'un template programme n\'est pas l\'IA')
  assert.ok(!/origine/.test(sansCommentaires(lire('lib/cron-arrival-code.js'))), 'un code d\'acces non plus')
  // La migration ferme la liste en base.
  const mig = lire('migrations/2026-10-12-messages-origine.sql')
  assert.ok(/'ia_validee', 'ia_modifiee',\s*\n\s*'hote', 'ia_auto'/.test(mig) && /check/.test(mig))
})

test('dette 66 : la page pose l\'origine au GESTE, et le robot suit ia_*', () => {
  const src = sansCommentaires(html())
  assert.ok(/await posterMessage\(c, texte, 'ia_validee'\)/.test(src), 'Envoyer tel quel = ia_validee')
  assert.ok(/entree\.valideTache \? 'ia_modifiee' : 'hote'/.test(src), 'apres Modifier = ia_modifiee, sinon hote')
  assert.ok(/m\.kind === 'auto' \|\| \/\^ia_\/\.test\(String\(m\.origine \|\| ''\)\)/.test(src),
    'le robot s\'affiche sur les bulles ia_* (consigne du 12 octobre), le coeur fait foi')
  // Le GET expose origine avec repli (migration pas posee = pas de panne).
  const api = lire('api/messages.js')
  assert.ok(/kind, origine'/.test(api) && /r\.error && \/origine\/\.test/.test(api), 'lecture avec repli')
})

test('dette 66 : la tuile IA compte la COLONNE seule, au serveur, jamais un faux zero', () => {
  const api = lire('api/messages.js')
  assert.ok(/stats === 'ia'/.test(api)
    && /\.in\('origine', \['ia_validee', 'ia_modifiee', 'ia_auto'\]\)/.test(api)
    && /indisponible: true/.test(api),
    'compte serveur sur origine, indisponible si migration absente')
  const accueil = lire('pages/aujourdhui.html')
  assert.ok(/stats=ia/.test(accueil) && /r\.indisponible/.test(accueil),
    'la tuile se masque quand le compte est indisponible (faits comptes seulement)')
})

test('dette 67 : « Evaluer {prenom} ? » au DEPART seulement, par le BUS seulement', () => {
  const src = sansCommentaires(html())
  assert.ok(/depart && depart < etat\.aujourdHui/.test(src), 'jamais avant le depart du voyageur')
  assert.ok(/bus\.demander\('avis\.statut'/.test(src) && /bus\.ouvrir\('avis\.evaluer'/.test(src),
    'statut et geste par le bus du coeur — meme writer que la fiche resa (les boutons a niveaux)')
  assert.ok(!/from\('ota_reviews'\)/.test(src) && !/\/api\/avis/.test(src),
    'jamais les tables ni l\'endpoint des avis en direct')
  assert.ok(/await bus\.disponible\('avis\.evaluer'\)/.test(src), 'silencieux sans droit')
  assert.ok(/review_published/.test(src), 'publiee = dit, sans bouton')
  assert.ok(/etat\.evaluations\.delete\(String\(c\.bookId\)\)/.test(src),
    'au retour de la fenetre, le statut se RELIT (publiee sans rechargement)')
})
