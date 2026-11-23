// ═══════════════════════════════════════════════════════════════════════════
// POST /api/logement-archive — archiver un bien, et le ranimer
// ═══════════════════════════════════════════════════════════════════════════
//
// Lot « archiver un bien », etapes 0 a 4. Go de Thierry du 31 octobre 2026.
//
// ⚠ POURQUOI UN FICHIER NEUF, et c'est le meme raisonnement que pour
// `api/logement.js` : `api/channel-property.js` porte deja GET, POST, PATCH et
// DELETE sur 1 100 lignes avec quatre gardes differentes — et c'est celui ou un
// patch mecanique a casse l'iframe de connexion le 19 octobre 2026. Une action,
// une garde, un fichier : ca se relit.
//
// ⚠ ET LA LOGIQUE N'EST PAS ICI. Elle vit dans `lib/logement/archive.js`, pour
// qu'elle s'eprouve sans passer par HTTP : le geste touche quatre tables et doit
// rendre compte des echecs partiels, ce qui ne se teste pas a travers un code de
// statut.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { archiver, reactiver } = require('../lib/logement/archive')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler (req, res) {
  // Une action : rien a mettre en cache, et la reponse est propre a un compte.
  res.setHeader('cache-control', 'private, no-store')
  res.setHeader('vary', 'authorization, x-compte')

  // ⚠ L'EN-TETE `allow` PART AVANT LE REFUS, et ce n'est pas du zele : la revue
  // du 24 octobre a mesure 11 refus sans en-tete dans ce depot, dont 5 en 405.
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  const corps = req.body && typeof req.body === 'object' ? req.body : {}
  const id = corps.id != null ? String(corps.id).trim() : ''
  const action = corps.action != null ? String(corps.action).trim() : 'archiver'
  if (!id) return res.status(400).json({ error: 'Logement non précisé' })
  if (action !== 'archiver' && action !== 'reactiver') {
    return res.status(400).json({ error: 'Action inconnue' })
  }

  // ⚠ `reglages: write` SUR CE BIEN, la meme garde que la suppression. Et
  // `bienRequis` rend 404 sur un bien inconnu sans distinguer « n'existe pas »
  // de « ne vous appartient pas » : le bien designe le compte, donc `X-Compte`
  // ne peut pas servir a atteindre le bien d'un autre.
  const garde = await requirePermission(req, res, {
    domaine: 'reglages', niveau: 'write', bien: id, bienRequis: true
  })
  if (!garde.ok) return

  const bienId = garde.bien ? garde.bien.id : id
  const compte = garde.accountUserId

  // ⚠ LE MOTIF EST BORNE. Il est libre — « supprime chez le provider » et
  // « l'hote arrete la location » demandent des gestes differents le jour ou on
  // reactive — mais un champ de texte sans borne est une colonne a remplir.
  const motif = corps.motif != null ? String(corps.motif).slice(0, 500).trim() || null : null

  try {
    const r = action === 'archiver'
      ? await archiver(supabase, { bienId, compte, parQui: garde.userId || null, motif })
      : await reactiver(supabase, { bienId, compte })

    if (!r.ok) {
      // `bien_introuvable` ne peut pas arriver apres `bienRequis`, mais le dire
      // en 404 plutot qu'en 500 reste la reponse juste si cela arrivait.
      const code = r.motif_refus === 'bien_introuvable' ? 404 : 503
      console.error('[logement-archive]', action, r.motif_refus, r.detail || '')
      return res.status(code).json({ error: code === 404
        ? 'Bien introuvable'
        : 'Impossible d\'archiver ce logement pour l\'instant. Réessayez dans un instant.' })
    }

    // ⚠ LES ECHECS PARTIELS REMONTENT A L'ECRAN. Le bien EST archive — donc
    // hors des boucles — mais si les taches IA n'ont pas pu etre closes, l'hote
    // doit le lire. Un 200 muet serait un faux vert de plus.
    return res.status(200).json(r)
  } catch (e) {
    console.error('[logement-archive] echec inattendu :', e.message)
    return res.status(503).json({ error: 'Impossible d\'archiver ce logement pour l\'instant. Réessayez dans un instant.' })
  }
}
