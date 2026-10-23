#!/usr/bin/env node
// scripts/verifier-isolation-ecran.js
// LA PREUVE D'ISOLATION DE `/api/ecran/aujourdhui`, SUR LES DONNEES REELLES.
// LECTURE SEULE. DOC : docs/specs/spec-performance-pages.md (lot (b))
//
// Demande de Thierry, 23 octobre 2026 : « un test reel avec le compte de test
// invite en profil restreint (La bulle seule) : il ne doit voir que La bulle,
// ni donnees ni comptages des autres biens. »
//
//   ENV_FILE=/chemin/.env.local node scripts/verifier-isolation-ecran.js
//
// ⚠ POURQUOI UN SCRIPT ET PAS UN TEST DE LA SUITE. `tests/ecran-aujourdhui-isolation.test.js`
// eprouve la REGLE sur des donnees fabriquees : il dit que le perimetre est
// applique a chaque lecture, et il rougit sur dix mutations. Il ne peut pas
// dire que le profil restreint de PRODUCTION, avec ses droits reels et ses
// quatre biens reels, rend bien un seul bien. Les deux sont necessaires : la
// regle se teste hors ligne, la DONNEE se mesure contre la base.
//
// ⚠ AUCUNE ECRITURE, ET AUCUNE SESSION FABRIQUEE. Le profil existe deja en
// production (le compte de test invite, restreint a La bulle, `avis: none`).
// On lit ce profil et ses droits REELS, on en construit le contexte, et on
// double la seule chose qu'on ne peut pas avoir : la session. Le PERIMETRE,
// lui, tourne pour de vrai — c'est le code de production, non modifie.
// Le client Supabase est enveloppe : toute ecriture LEVE.
//
// Sortie : 0 si aucune reference hors perimetre, 1 sinon (et la liste).
require('dotenv').config({ path: process.env.ENV_FILE })
const path = require('node:path')
const Module = require('node:module')
const vrai = require('@supabase/supabase-js')

const INTERDITS = ['insert', 'upsert', 'update', 'delete']
function lectureSeule (client) {
  const env = (o) => new Proxy(o, {
    get (c, p) {
      if (INTERDITS.includes(p)) return () => { throw new Error(`ECRITURE REFUSEE : .${String(p)}()`) }
      const v = c[p]
      if (typeof v === 'function') return (...a) => { const r = v.apply(c, a); return (r && typeof r === 'object') ? env(r) : r }
      return v
    }
  })
  // ⚠ ON ENVELOPPE LE CLIENT ENTIER, PAS QUATRE NOMS DE METHODES. La version
  // precedente faisait `{ ...client, from, rpc }` : le spread recopiait `rest`
  // et `storage` tels quels, passait `auth` brut, et PERDAIT les methodes du
  // prototype (`schema`, `channel`, `functions`). `client.rest.from(t).delete()`,
  // `client.storage.from(b).upload()` et `client.auth.admin.createUser()`
  // s'echappaient donc, et un `rpc` mutant (`rekey_property`,
  // `claim_availability_push`…) ne touche aucun des quatre noms gardes.
  // Un proxy sur le client lui-meme enveloppe tout ce qui en sort.
  return new Proxy(client, {
    get (c, p) {
      if (INTERDITS.includes(p)) return () => { throw new Error(`ECRITURE REFUSEE : .${String(p)}()`) }
      if (p === 'rpc') return (...a) => { throw new Error('RPC REFUSE : ' + String(a[0])) }
      const v = c[p]
      if (typeof v === 'function') {
        return (...a) => { const r = v.apply(c, a); return (r && typeof r === 'object') ? env(r) : r }
      }
      return (v && typeof v === 'object') ? env(v) : v
    }
  })
}
const absSdk = require.resolve('@supabase/supabase-js')
require.cache[absSdk].exports = { ...vrai, createClient: (u, k, o) => lectureSeule(vrai.createClient(u, k, o)) }

// ⚠ CE CLIENT PASSE PAR L'ENVELOPPE, ET IL NE LE FAISAIT PAS. Je l'avais
// construit depuis la reference `vrai` SAUVEGARDEE avant le remplacement du
// SDK : il echappait donc entierement a `lectureSeule`, avec la cle de service
// contre la PRODUCTION, insert/update/delete vivants — pendant que l'en-tete
// du fichier annonce « toute ecriture LEVE ». C'est le client que le script
// utilise pour ses quatre lectures.
const nu = lectureSeule(vrai.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY))

function fausseReponse () {
  const r = { code: null, corps: null, entetes: {} }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.corps = b; return r }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  return r
}

async function appeler (contexte, compte) {
  const absPerm = require.resolve(path.join(process.cwd(), 'lib/require-permission.js'))
  const vraiePerm = require(absPerm)
  const m = new Module(absPerm)
  m.exports = {
    ...vraiePerm,
    contexteDEcran: async (req, res) => {
      res.setHeader('cache-control', 'private, no-store')
      return { ok: true, userId: contexte.userId, accountUserId: compte, contexte }
    }
  }
  m.loaded = true
  const sauvegarde = require.cache[absPerm]
  require.cache[absPerm] = m
  delete require.cache[require.resolve(path.join(process.cwd(), 'api/ecran/aujourdhui.js'))]
  const handler = require(path.join(process.cwd(), 'api/ecran/aujourdhui.js'))
  const res = fausseReponse()
  const t = Date.now()
  try {
    await handler({ method: 'GET', query: {}, headers: {}, url: '/' }, res)
  } finally {
    // ⚠ ET ON REMET LE VRAI MODULE. Sans cette restauration, un second appel
    // rechargeait l'endpoint CONTRE LE FAUX deja installe : la garde du
    // deuxieme contexte etait celle du premier, et le script se mesurait
    // lui-meme.
    if (sauvegarde) require.cache[absPerm] = sauvegarde
    else delete require.cache[absPerm]
    delete require.cache[require.resolve(path.join(process.cwd(), 'api/ecran/aujourdhui.js'))]
  }
  return { res, ms: Date.now() - t }
}

;(async () => {
  console.log(`projet = ${(process.env.SUPABASE_URL.match(/\/\/([a-z0-9]+)\./) || [])[1]}  (LECTURE SEULE)\n`)

  const { data: biens } = await nu.from('properties').select('id, name, user_id, provider_property_id')
  const nomDe = new Map(biens.map(b => [String(b.id), b.name]))
  const nomDeRef = new Map(biens.map(b => [String(b.provider_property_id), b.name]))

  // ── 1. Le TITULAIRE, pour la reference
  const TITULAIRE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
  let refTitulaire = null
  {
    const ctx = { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    const { res, ms } = await appeler(ctx, TITULAIRE)
    const c = res.corps
    console.log(`── TITULAIRE  ${res.code}  ${c.cout.requetes} requetes, ${ms} ms`)
    console.log(`     biens : ${c.biens.length} — ${c.biens.map(b => b.nom || b.name).join(', ')}`)
    console.log(`     taches ${c.taches ? c.taches.length : 'refuse'} | alarmes ${c.alarmes ? c.alarmes.length : 'refuse'}`
      + ` | arrivees ${c.arrivees_nombre} | notes ${c.notes ? c.notes.global.notes + ' notes' : 'refuse'}`)
    console.log(`     fait pour vous : ${JSON.stringify(c.fait_pour_vous)}`)
    console.log(`     Server-Timing : ${res.entetes['server-timing']}`)
    console.log(`     indisponibles : ${JSON.stringify(c.indisponibles)} | tronquees : ${JSON.stringify(c.tronquees)}`)
    const octets = Buffer.byteLength(JSON.stringify(c))
    console.log(`     POIDS : ${octets.toLocaleString('fr-FR')} octets`)
    const parBloc = Object.entries(c).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v ?? null))])
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
    console.log('     les 5 blocs les plus lourds : ' + parBloc.map(([k, n]) => `${k} ${n.toLocaleString('fr-FR')}`).join(', '))
    refTitulaire = c
  }

  // ── 2. LE MEMBRE RESTREINT, avec ses droits REELS lus en base
  // Le profil restreint : son prefixe est donne en argument, ou vaut celui du
  // compte de test invite. On ne devine pas — un profil absent ARRETE le
  // script, il ne le fait pas passer sur un autre.
  const PREFIXE_PROFIL = process.argv[2] || '851879e4'
  const { data: profs } = await nu.from('profiles').select('*')
    .eq('is_owner', false).eq('account_user_id', TITULAIRE)
  const cible = (profs || []).find(p =>
    p.member_user_id && String(p.id).startsWith(PREFIXE_PROFIL))
  if (!cible) {
    console.error(`\nprofil restreint ${PREFIXE_PROFIL} introuvable sur ce compte`)
    console.error('profils delegues presents : '
      + (profs || []).map(p => String(p.id).slice(0, 8)).join(', '))
    process.exit(1)
  }
  const { data: perms } = await nu.from('profile_permissions').select('*').eq('profile_id', cible.id).maybeSingle()
  console.log(`\n── MEMBRE RESTREINT  profil ${String(cible.id).slice(0, 8)}`)
  console.log(`     perimetre declare : ${JSON.stringify(perms.property_ids)} = ${(perms.property_ids || []).map(i => nomDe.get(String(i)) || '?').join(', ')}`)
  console.log(`     droits : reservations=${perms.reservations} menages=${perms.menages} avis=${perms.avis} reglages=${perms.reglages} messages=${perms.messages}`)

  const ctx = { userId: cible.member_user_id, accountUserId: TITULAIRE, profil: cible, permissions: perms }
  const { res, ms } = await appeler(ctx, TITULAIRE)
  const c = res.corps
  console.log(`\n   reponse ${res.code} — ${c.cout.requetes} requetes, ${ms} ms`)
  console.log(`     indisponibles : ${JSON.stringify(c.indisponibles)}`
    + ` | tronquees : ${JSON.stringify(c.tronquees)}`)
  console.log(`     biens : ${c.biens.length} — ${c.biens.map(b => b.name).join(', ')}`)
  console.log(`     taches ${c.taches === null ? 'REFUSE' : c.taches.length} | alarmes ${c.alarmes === null ? 'REFUSE' : c.alarmes.length}`
    + ` | arrivees ${c.arrivees_nombre} | notes ${c.notes === null ? 'REFUSE' : c.notes.global.notes + ' notes'}`)
  console.log(`     fait pour vous : ${JSON.stringify(c.fait_pour_vous)}`)
  console.log(`     refuses : ${JSON.stringify(c.refuses)}`)

  // ── 3. LE VERDICT : aucune reference hors perimetre, nulle part
  const autorises = new Set((perms.property_ids || []).map(String))
  const autorisesRef = new Set([...autorises].map(i => {
    const b = biens.find(x => String(x.id) === i); return b ? String(b.provider_property_id) : null
  }).filter(Boolean))
  const fuites = []

  // ─── 0. LE SCRIPT DOIT ECHOUER S'IL N'A RIEN LU ─────────────────────────
  //
  // ⚠ CE BLOC EST LE CORRECTIF LE PLUS IMPORTANT DE CE FICHIER, et c'est la
  // review qui l'a nomme. Le verdict ne verifiait que deux choses — aucune
  // reference interdite, aucun comptage au-dessus du titulaire — et une
  // reponse ENTIEREMENT VIDE les satisfait toutes les deux : `[]` ne contient
  // aucune reference interdite, et `0 <= n` pour tout compteur. Le script
  // affichait donc « biens : 0 — » puis « VERDICT : aucune reference hors
  // perimetre », et sortait 0.
  // C'est exactement le filet qui devait attraper le defaut 22P02 sur
  // `properties.id` — et il ne pouvait pas, par construction.
  // Memoire du projet, mot pour mot : « un script qui n'a rien lu doit
  // echouer ; asserter HTTP + non-vacuite + couverture ».
  const exige = (vrai, dit) => { if (!vrai) fuites.push('NON-VACUITE : ' + dit) }
  exige(res.code === 200, `la reponse du membre est ${res.code}, pas 200`)
  exige(refTitulaire !== null, 'la reponse du titulaire manque')
  exige(Array.isArray(refTitulaire.biens) && refTitulaire.biens.length > 0,
    'le titulaire ne rend AUCUN bien : le script ne mesure rien')
  exige((refTitulaire.indisponibles || []).length === 0,
    `le titulaire a des blocs indisponibles (${JSON.stringify(refTitulaire.indisponibles)})`)
  // Le membre doit voir EXACTEMENT son perimetre, intersecte avec les biens du
  // compte — ni plus (fuite), ni moins (un ecran vide qui passerait le tamis).
  const attendus = (perms.property_ids || []).map(String)
    .filter(i => (biens || []).some(b => String(b.id) === i && String(b.user_id) === TITULAIRE))
  exige(Array.isArray(c.biens) && c.biens.length === attendus.length,
    `le membre rend ${(c.biens || []).length} bien(s) pour un perimetre de ${attendus.length}`)
  exige((c.indisponibles || []).length === 0,
    `le membre a des blocs indisponibles (${JSON.stringify(c.indisponibles)}) :`
    + ' une lecture en echec se lit « rien a voir », pas « rien »')

  const verifier = (chemin, valeur) => {
    if (valeur == null) return
    if (Array.isArray(valeur)) return valeur.forEach((v, i) => verifier(`${chemin}[${i}]`, v))
    if (typeof valeur === 'object') {
      for (const [k, v] of Object.entries(valeur)) {
        // ⚠ LES CLES AUSSI, ET C'ETAIT LE TROU LE PLUS FIN. `notes.par_bien`
        // est indexe PAR la reference du bien : la reference y est une CLE, pas
        // une valeur. Un `refs: null` arrivant a `notesDuPerimetre` aurait donc
        // livre a un membre restreint la note et le NOMBRE D'AVIS de tout le
        // compte, sans que ce tamis ne voie rien. (Et le profil de la mesure du
        // 23 octobre a `avis: none`, donc ce perimetre n'etait meme pas
        // exerce : le tamis doit tenir pour le jour ou il le sera.)
        const estUuidCle = nomDe.has(k)
        const estRefCle = nomDeRef.has(k)
        if ((estUuidCle && !autorises.has(k)) || (estRefCle && !autorisesRef.has(k))) {
          fuites.push(`${chemin} a une CLE de bien interdite : ${k} (${nomDe.get(k) || nomDeRef.get(k)})`)
        }
        if (/^(property_id|property_id_ref|propertyId|bien|id)$/.test(k) && typeof v === 'string') {
          const estUuid = nomDe.has(v)
          const estRef = nomDeRef.has(v)
          if ((estUuid && !autorises.has(v)) || (estRef && !autorisesRef.has(v))) {
            fuites.push(`${chemin}.${k} = ${v} (${nomDe.get(v) || nomDeRef.get(v)})`)
          }
        }
        verifier(`${chemin}.${k}`, v)
      }
    }
  }
  verifier('reponse', c)

  // ── 4. LES COMPTAGES AUSSI. « Ni donnees ni comptages des autres biens » :
  // un compteur est un nombre, donc rien a l'ecran ne trahirait qu'il porte
  // quatre biens au lieu d'un. On le compare a celui du titulaire — il doit
  // etre INFERIEUR OU EGAL, jamais au-dessus, et jamais egal par hasard sur un
  // compteur ou le titulaire a de l'activite hors perimetre.
  console.log('\n   les comptages, membre contre titulaire :')
  for (const [k, v] of Object.entries(c.fait_pour_vous)) {
    if (k === 'jours') continue
    const t = refTitulaire.fait_pour_vous[k]
    const etat = v === null ? 'refuse'
      : (typeof t === 'number' && v > t) ? '⚠ SUPERIEUR AU TITULAIRE' : 'ok'
    if (etat.startsWith('⚠')) fuites.push(`fait_pour_vous.${k} = ${v} > ${t} (titulaire)`)
    console.log(`     ${k.padEnd(16)} membre ${String(v).padStart(5)}   titulaire ${String(t).padStart(5)}   ${etat}`)
  }
  // ⚠ `notes` EST DANS CETTE LISTE. C'est un NOMBRE d'avis : rien a l'ecran ne
  // dirait qu'il porte quatre biens au lieu d'un.
  const nAvis = (x) => (x && x.notes && x.notes.global) ? x.notes.global.notes : null
  if (nAvis(c) !== null && nAvis(refTitulaire) !== null && nAvis(c) > nAvis(refTitulaire)) {
    fuites.push(`notes.global.notes = ${nAvis(c)} > ${nAvis(refTitulaire)} (titulaire)`)
  }
  console.log(`     ${'notes (avis)'.padEnd(16)} membre `
    + `${String(nAvis(c) === null ? 'REFUSE' : nAvis(c)).padStart(5)}`
    + `   titulaire ${String(nAvis(refTitulaire) === null ? 'REFUSE' : nAvis(refTitulaire)).padStart(5)}`)
  for (const [nom, bloc] of [['taches', 'taches'], ['conversations', 'conversations']]) {
    const m = Array.isArray(c[bloc]) ? c[bloc].length : null
    const t = Array.isArray(refTitulaire[bloc]) ? refTitulaire[bloc].length : null
    if (m !== null && t !== null && m > t) fuites.push(`${nom} : ${m} lignes > ${t} (titulaire)`)
    console.log(`     ${nom.padEnd(16)} membre ${String(m === null ? 'REFUSE' : m).padStart(5)}`
      + `   titulaire ${String(t === null ? 'REFUSE' : t).padStart(5)}`)
  }

  const nArr = (x) => (typeof x.arrivees_nombre === 'number' ? x.arrivees_nombre : null)
  if (nArr(c) !== null && nArr(refTitulaire) !== null && nArr(c) > nArr(refTitulaire)) {
    fuites.push(`arrivees_nombre = ${nArr(c)} > ${nArr(refTitulaire)} (titulaire)`)
  }
  console.log(`     ${'arrivees'.padEnd(16)} membre ${String(nArr(c)).padStart(5)}`
    + `   titulaire ${String(nArr(refTitulaire)).padStart(5)}`)

  console.log('')
  if (fuites.length) {
    console.error(`⚠ ${fuites.length} CONSTAT(S) — fuite de perimetre ou mesure vide :`)
    fuites.forEach(f => console.error('    ' + f))
    process.exit(1)
  }
  console.log('VERDICT : aucune reference hors perimetre, et aucun comptage superieur')
  console.log('          a celui du titulaire, dans la reponse du membre restreint.')
  console.log(`          (perimetre = ${[...autorises].map(i => nomDe.get(i)).join(', ')})`)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
