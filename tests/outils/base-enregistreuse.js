// tests/outils/base-enregistreuse.js — un double de supabase-js qui ENREGISTRE
// chaque requête (table, opération, charge, filtres, ordre, borne) et le
// stockage (bucket, geste, chemin). `repondre(r)` rend `{ data, error }`.
//
// ⚠ IL N'APPLIQUE AUCUN FILTRE DE LUI-MÊME : il rend ce que le test décide.
// Un double qui filtrerait à la place du code rendrait le code conforme quoi
// qu'il fasse — et les tests d'isolation par compte ne prouveraient rien. Les
// tests AFFIRMENT les filtres posés, requête par requête.

function baseEnregistreuse (repondre = () => ({ data: null, error: null }), stockage = {}) {
  const requetes = []
  const gestes = []

  function from (table) {
    const r = { table, op: 'select', colonnes: null, charge: null, options: null, filtres: [], ordre: [], limite: null, unique: false, retour: null }
    const fin = () => {
      requetes.push(r)
      const rep = repondre(r) || { data: null, error: null }
      if (r.unique) {
        const d = Array.isArray(rep.data) ? (rep.data[0] || null) : rep.data
        return Promise.resolve({ data: rep.error ? null : (d === undefined ? null : d), error: rep.error || null })
      }
      return Promise.resolve({ data: rep.data === undefined ? null : rep.data, error: rep.error || null })
    }
    const q = {
      select (c) { if (r.op === 'select') r.colonnes = c; else r.retour = c; return q },
      insert (x) { r.op = 'insert'; r.charge = x; return q },
      update (x) { r.op = 'update'; r.charge = x; return q },
      upsert (x, o) { r.op = 'upsert'; r.charge = x; r.options = o; return q },
      delete () { r.op = 'delete'; return q },
      eq (c, v) { r.filtres.push(['eq', c, v]); return q },
      neq (c, v) { r.filtres.push(['neq', c, v]); return q },
      lt (c, v) { r.filtres.push(['lt', c, v]); return q },
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
