// tests/bookings-snapshot-troncature.test.js
//
// ⚠ L'INCIDENT QUE CES TESTS FERMENT — 7 septembre 2026.
// Une mission de menage assignee et ACCEPTEE etait invisible dans l'app de la
// prestataire, la veille du depart.
//
// Le back-end etait correct : la reservation modifiee (6->7 devenue 6->8) avait
// bien annule l'ancienne mission et cree la nouvelle. Le defaut etait en
// LECTURE : `api/menages-public.js` lisait `bookings_snapshot` en filtrant
// seulement par hote et par bien, et appliquait la fenetre de dates en
// JavaScript APRES.
//
// PostgREST plafonne un rendu a 1000 lignes. Au-dela, il en rend 1000 —
// SANS ERREUR, sans avertissement. Mesure du jour : 1418 lignes correspondantes,
// 1000 rendues. Le backfill de l'historique du 5 septembre avait fait passer la
// table de 214 a 1437 lignes ; depuis, les reservations les plus RECENTES
// tombaient hors du rendu. Leur menage arrivait, leur reservation non, et
// l'ecran qui joint les deux n'affichait rien.
//
// Aggravant : sans `order by`, les 1000 lignes rendues sont ARBITRAIRES.
//
// CE QUI EST DEFENDU ICI : que le filtre de dates soit dans la REQUETE. C'est ce
// qui ramene le rendu a quelques dizaines de lignes et rend la troncature
// impossible — pas une precaution de style.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')

// Retire les commentaires pour que ces tests ne se satisfassent pas d'une
// mention dans une explication.
function code (src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}

// La requete `bookings_snapshot`, decoupee A SA VRAIE FIN.
//
// ⚠ CONSTAT DE REVIEW. La premiere version prenait une fenetre FIXE de 700
// caracteres. Elle debordait sur l'instruction SUIVANTE, si bien qu'une requete
// non bornee pouvait etre declaree bornee grace au `.in('booking_id', …)` d'un
// `delete` sans rapport, quelques lignes plus bas. Faux negatif reel : la purge
// de `api/channel-property.js` passait pour bornee.
//
// On s'arrete donc au PREMIER separateur d'instruction : une autre requete, un
// nouvel `await supabase`, ou une ligne vide.
function finDeRequete (net, debut) {
  const bornes = [
    net.indexOf(".from('", debut + 10),
    net.indexOf('await supabase', debut + 10),
    net.indexOf('\n\n', debut)
  ].filter(i => i !== -1)
  const fin = bornes.length ? Math.min(...bornes) : net.length
  return Math.min(fin, debut + 700)
}

// Les ECRITURES ne se bornent pas : un upsert ou un delete vise deja ses lignes.
// Les inclure faisait passer le writer pour fautif, et obligeait a exempter tout
// le fichier — ce qui masquait ses vraies lectures.
function estEcriture (q) {
  return /\.(upsert|insert|update|delete)\(/.test(q)
}

function requetes (src) {
  const net = code(src)
  const out = []
  let i = net.indexOf("from('bookings_snapshot')")
  while (i !== -1) {
    const q = net.slice(i, finDeRequete(net, i))
    if (!estEcriture(q)) out.push(q)
    i = net.indexOf("from('bookings_snapshot')", i + 1)
  }
  return out
}

// Une requete est BORNEE si elle porte un filtre de dates, ou vise une
// reservation precise, ou pagine explicitement.
function bornee (q) {
  return /\.(gte|lte)\('snapshot->>(departure|arrival)'/.test(q) ||
         /\.eq\('booking_id'/.test(q) ||
         /\.in\('booking_id'/.test(q) ||
         /\.range\(/.test(q) ||
         /\.limit\(/.test(q) ||
         // ⚠ UN COMPTAGE NE RAMENE AUCUNE LIGNE. `{ count: 'exact', head: true }`
         // demande un nombre, pas des donnees : le plafond de 1000 lignes de
         // PostgREST ne s'y applique pas, et exiger une borne dessus obligerait
         // a inventer un filtre qui fausserait le compte. Ajoute le 9 septembre
         // 2026 pour lib/migration-etapes.js, et valable pour tout comptage a
         // venir — plutot qu'une exemption par fichier, qui rendrait invisible
         // la prochaine vraie lecture ajoutee au meme endroit.
         /head:\s*true/.test(q)
}

// ─── Les deux endpoints de l'incident ───────────────────────────────────────

test('api/menages-public.js borne sa lecture des reservations par DATES', () => {
  // C'est l'endpoint de l'incident : l'app de la prestataire.
  const q = requetes(lire('api/menages-public.js'))
  assert.equal(q.length, 1, 'une seule lecture attendue dans ce fichier')
  assert.match(q[0], /\.gte\('snapshot->>departure', dateFrom\)/)
  assert.match(q[0], /\.lte\('snapshot->>departure', dateTo\)/)
})

test('api/menages-public.js ne peut plus AVALER une erreur de lecture', () => {
  // Une panne rendait `snaps` indefini, donc zero reservation, donc un planning
  // vide — indiscernable de « rien a faire aujourd hui ».
  const src = code(lire('api/menages-public.js'))
  assert.match(src, /const \{ data: snaps, error: errSnaps \}/)
  assert.match(src, /if \(errSnaps\)/)
})

test('api/calendar.js borne sa lecture des reservations par la FENETRE demandee', () => {
  // Le cas le plus grave : le calendrier de l'hote. Une troncature y affiche
  // libres des nuits deja vendues — sans aucun signal.
  const q = requetes(lire('api/calendar.js'))
  const lecture = q.find(x => /select\('booking_id, property_id, snapshot'\)/.test(x))
  assert.ok(lecture, 'la lecture des reservations doit exister')
  assert.match(lecture, /\.gte\('snapshot->>departure', start\)/)
  assert.match(lecture, /\.lte\('snapshot->>arrival', end\)/)
})

// ─── Le filet : aucun lecteur non borne ne doit reapparaitre ────────────────

test('RECENSEMENT : toute lecture de bookings_snapshot est bornee', () => {
  // ⚠ C'est ce test qui empeche la rechute. Une lecture ajoutee demain sans
  // borne le fait echouer — on ne redecouvre pas le probleme au prochain seuil
  // de 1000 lignes, en production, la veille d'un depart.
  const fichiers = []
  for (const dossier of ['api', 'lib', 'lib/cleaning', 'scripts']) {
    const abs = path.join(racine, dossier)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js')) fichiers.push(`${dossier}/${f}`)
    }
  }

  // ⚠ LES EXEMPTIONS COMPTENT LES REQUETES, PAS LES FICHIERS.
  // Constat de review : exempter un fichier entier rendait INVISIBLE toute
  // lecture non bornee qu'on y ajouterait ensuite — dans le seul test cense
  // empecher la rechute. La valeur est le nombre de lectures non bornees
  // ATTENDUES. Une de plus, ou une de moins, et le test parle.
  // DETTE OUVERTE — trouvee le 7 septembre 2026, PAS corrigee ce jour-la.
  // Aucune de ces trois ne se repare par un filtre de dates.
  // (`cron-overbooking` et `booking-changes-dispatch` figuraient ici avant que le
  // decoupage ne soit corrige : ils sont bornes pour de vrai, et le filet le voit
  // maintenant. Ils n'ont plus d'exemption.)
  const ATTENDU = {
    'api/messages.js': 1,                // a borner par les booking_id des messages charges
    'lib/cron-channel-reviews.js': 1,    // a paginer : une fenetre de dates serait FAUSSE
                                         // (un avis peut porter sur un sejour ancien)
    'lib/cron-classify.js': 1            // a borner par les booking_id references
  }

  const constate = {}
  for (const f of fichiers) {
    const src = lire(f)
    if (!src.includes("from('bookings_snapshot')")) continue
    const n = requetes(src).filter(q => !bornee(q)).length
    if (n > 0) constate[f] = n
  }
  assert.deepStrictEqual(constate, ATTENDU,
    'lectures de bookings_snapshot sans borne : elles seront tronquees a 1000 lignes SANS erreur.\n' +
    'Une de plus = rechute. Une de moins = corrigee, retirez-la de ATTENDU pour qu elle soit protegee.')
})

test('le decoupage s arrete a la FIN de la requete, pas 700 caracteres plus loin', () => {
  // ⚠ LE FAUX NEGATIF QUE LA REVIEW A TROUVE. Une fenetre fixe debordait sur
  // l'instruction suivante : une requete non bornee passait pour bornee grace au
  // `.in('booking_id', …)` d'un `delete` sans rapport, quelques lignes plus bas.
  const faux = [
    "  const { data } = await supabase.from('bookings_snapshot')",
    "    .select('booking_id')",
    "    .eq('user_id', u)",
    '',
    "  await supabase.from('message_sent_log')",
    "    .delete().in('booking_id', ids)"
  ].join('\n')
  const q = requetes(faux)
  assert.equal(q.length, 1)
  assert.equal(bornee(q[0]), false,
    'la borne d une instruction voisine ne doit JAMAIS valider celle-ci')
})

test('les ECRITURES ne sont pas comptees comme des lectures a borner', () => {
  // Un upsert vise deja ses lignes. Les compter obligeait a exempter tout le
  // fichier du writer — ce qui masquait ses vraies lectures.
  const ecriture = "await supabase.from('bookings_snapshot').upsert(rows, { onConflict: 'x' })"
  assert.deepStrictEqual(requetes(ecriture), [])
})
