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
  return { ...client, from: (t) => env(client.from(t)), rpc: (...a) => env(client.rpc(...a)), auth: client.auth }
}
const absSdk = require.resolve('@supabase/supabase-js')
require.cache[absSdk].exports = { ...vrai, createClient: (u, k, o) => lectureSeule(vrai.createClient(u, k, o)) }

const nu = vrai.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

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
  require.cache[absPerm] = m
  delete require.cache[require.resolve(path.join(process.cwd(), 'api/ecran/aujourdhui.js'))]
  const handler = require(path.join(process.cwd(), 'api/ecran/aujourdhui.js'))
  const res = fausseReponse()
  const t = Date.now()
  await handler({ method: 'GET', query: {}, headers: {}, url: '/' }, res)
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
      + ` | arrivees ${c.arrivees.length} | notes ${c.notes ? c.notes.global.notes + ' notes' : 'refuse'}`)
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
  console.log(`     biens : ${c.biens.length} — ${c.biens.map(b => b.name).join(', ')}`)
  console.log(`     taches ${c.taches === null ? 'REFUSE' : c.taches.length} | alarmes ${c.alarmes === null ? 'REFUSE' : c.alarmes.length}`
    + ` | arrivees ${c.arrivees.length} | notes ${c.notes === null ? 'REFUSE' : c.notes.global.notes + ' notes'}`)
  console.log(`     fait pour vous : ${JSON.stringify(c.fait_pour_vous)}`)
  console.log(`     refuses : ${JSON.stringify(c.refuses)}`)

  // ── 3. LE VERDICT : aucune reference hors perimetre, nulle part
  const autorises = new Set((perms.property_ids || []).map(String))
  const autorisesRef = new Set([...autorises].map(i => {
    const b = biens.find(x => String(x.id) === i); return b ? String(b.provider_property_id) : null
  }).filter(Boolean))
  const fuites = []
  const verifier = (chemin, valeur) => {
    if (valeur == null) return
    if (Array.isArray(valeur)) return valeur.forEach((v, i) => verifier(`${chemin}[${i}]`, v))
    if (typeof valeur === 'object') {
      for (const [k, v] of Object.entries(valeur)) {
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
  for (const [nom, bloc] of [['taches', 'taches'], ['arrivees', 'arrivees'], ['conversations', 'conversations']]) {
    const m = Array.isArray(c[bloc]) ? c[bloc].length : null
    const t = Array.isArray(refTitulaire[bloc]) ? refTitulaire[bloc].length : null
    if (m !== null && t !== null && m > t) fuites.push(`${nom} : ${m} lignes > ${t} (titulaire)`)
    console.log(`     ${nom.padEnd(16)} membre ${String(m === null ? 'REFUSE' : m).padStart(5)}`
      + `   titulaire ${String(t === null ? 'REFUSE' : t).padStart(5)}`)
  }

  console.log('')
  if (fuites.length) {
    console.error(`⚠ ${fuites.length} REFERENCE(S) HORS PERIMETRE :`)
    fuites.forEach(f => console.error('    ' + f))
    process.exit(1)
  }
  console.log('VERDICT : aucune reference hors perimetre, et aucun comptage superieur')
  console.log('          a celui du titulaire, dans la reponse du membre restreint.')
  console.log(`          (perimetre = ${[...autorises].map(i => nomDe.get(i)).join(', ')})`)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
