// tests/outils/base-enregistreuse.js — un double de supabase-js qui ENREGISTRE
// chaque requête (table, opération, charge, filtres, ordre, borne) et le
// stockage (bucket, geste, chemin). `repondre(r)` rend `{ data, error, count }`.
//
// ⚠ IL APPLIQUE SES FILTRES `eq` (REVIEW.md règle 22) : une ligne rendue par
// le test qui porte la colonne filtrée avec une AUTRE valeur ne revient pas.
// Une requête qui oublie `user_id` rend donc les lignes de l'autre compte que
// le test lui tend — et le test le voit. Les tests d'isolation affirment EN
// PLUS les filtres posés, requête par requête (`sansFuite`).

function baseEnregistreuse (repondre = () => ({ data: null, error: null }), stockage = {}) {
  const requetes = []
  const gestes = []

  function from (table) {
    const r = { table, op: 'select', colonnes: null, optionsSelect: null, charge: null, options: null, filtres: [], ordre: [], limite: null, unique: false, retour: null }
    // Une ligne passe si, pour chaque `eq`, elle n'a pas la colonne ou porte
    // la même valeur (la règle 22, une ligne).
    const garde = (l) => !l || typeof l !== 'object' ||
      r.filtres.filter(f => f[0] === 'eq').every(([, c, v]) => !(c in l) || String(l[c]) === String(v))
    const fin = () => {
      requetes.push(r)
      const brut = repondre(r) || { data: null, error: null }
      const rep = { ...brut }
      // Seulement pour une LECTURE : une écriture rend les lignes APRÈS
      // modification, et le filtre `statut = 'a_lire'` d'un update ne vaut
      // plus pour la ligne devenue `a_verifier`.
      if (r.op === 'select') {
        if (Array.isArray(rep.data)) rep.data = rep.data.filter(garde)
        else if (rep.data && typeof rep.data === 'object' && !garde(rep.data)) rep.data = null
      }
      if (r.unique) {
        const d = Array.isArray(rep.data) ? (rep.data[0] || null) : rep.data
        return Promise.resolve({ data: rep.error ? null : (d === undefined ? null : d), error: rep.error || null })
      }
      // `count` n'est rendu que si le test le donne : `select(c, { count })`.
      return Promise.resolve({ data: rep.data === undefined ? null : rep.data, error: rep.error || null, count: rep.count === undefined ? null : rep.count })
    }
    const q = {
      select (c, o) { if (r.op === 'select') { r.colonnes = c; r.optionsSelect = o || null } else r.retour = c; return q },
      insert (x) { r.op = 'insert'; r.charge = x; return q },
      update (x) { r.op = 'update'; r.charge = x; return q },
      upsert (x, o) { r.op = 'upsert'; r.charge = x; r.options = o; return q },
      delete () { r.op = 'delete'; return q },
      eq (c, v) { r.filtres.push(['eq', c, v]); return q },
      neq (c, v) { r.filtres.push(['neq', c, v]); return q },
      lt (c, v) { r.filtres.push(['lt', c, v]); return q },
      gte (c, v) { r.filtres.push(['gte', c, v]); return q },
      in (c, v) { r.filtres.push(['in', c, v]); return q },
      not (c, o, v) { r.filtres.push(['not', c, o, v]); return q },
      is (c, v) { r.filtres.push(['is', c, v]); return q },
      order (c, o) { r.ordre.push([c, (o || {}).ascending]); return q },
      limit (n) { r.limite = n; return q },
      maybeSingle () { r.unique = true; return fin() },
      single () { r.unique = true; return fin() },
      then (ok, ko) { return fin().then(ok, ko) }
    }
    return q
  }

  const storage = {
    from (bucket) {
      const geste = (nom, args, defaut) => {
        const g = { bucket, nom, args }
        gestes.push(g)
        const f = stockage[nom]
        return Promise.resolve(f ? f(...args) : defaut)
      }
      return {
        createSignedUploadUrl: (chemin) => geste('createSignedUploadUrl', [chemin],
          { data: { signedUrl: `https://stockage.test/envoi/${chemin}`, token: 'jeton', path: chemin }, error: null }),
        createSignedUrl: (chemin, s) => geste('createSignedUrl', [chemin, s],
          { data: { signedUrl: `https://stockage.test/lire/${chemin}` }, error: null }),
        download: (chemin) => geste('download', [chemin], { data: null, error: { message: 'absent' } }),
        remove: (chemins) => geste('remove', [chemins], { data: [], error: null })
      }
    }
  }

  const rpcs = []
  const client = {
    from,
    storage,
    rpc (nom, args) {
      rpcs.push({ nom, args })
      const f = stockage.rpc
      return Promise.resolve(f ? f(nom, args) : { data: [], error: null })
    }
  }
  return { client, requetes, gestes, rpcs }
}

/** Le filtre `eq` d'une requête sur une colonne, ou `undefined`. */
const filtre = (r, colonne) => {
  const f = r && r.filtres.find(x => x[0] === 'eq' && x[1] === colonne)
  return f ? f[2] : undefined
}

/** Un Blob minimal, comme le rend `storage.download`. */
const blob = (octets) => ({ arrayBuffer: async () => Uint8Array.from(octets).buffer })

module.exports = { baseEnregistreuse, filtre, blob }
