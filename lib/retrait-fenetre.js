// lib/retrait-fenetre.js — QUELLES NUITS SORTENT DE LA FENETRE QUAND L'HOTE LA
// REDUIT (lot 4.6.6, decision de Thierry du 30 septembre 2026).
// Writer du retrait : lib/calendrier-writer.js (`retirerDeLaVente`).
//
// ⚠ LE DEFAUT QU'IL FERME. Le moteur ne ferme jamais une nuit (4.6.3) et ne
// tarife que DANS la fenetre (lib/moteur-prix.js). Reduire la fenetre laissait
// donc en vente, a un prix FIGE, toutes les nuits deja ouvertes au-dela : 64 en
// production le 30 septembre 2026 (La bulle 24, Cœur de vie 23 40), et l'ecran
// les disait « pas encore ouvertes » (dette 4).
//
// ⚠ CE MODULE LIT, IL N'ECRIT RIEN. Il rend la liste que la confirmation
// annonce et que le retrait execute : UNE seule regle pour les deux.
//
// LA REGLE, EN UNE PHRASE : sort de la fenetre toute nuit OUVERTE en base
// (`stop_sell = false`), a partir d'aujourd'hui, posterieure a la nouvelle fin,
// et NON VENDUE. Decisions de Thierry (30 septembre 2026) : une nuit au prix
// pose par l'hote (✎) sort aussi — son prix n'est pas efface, le pilote la
// rouvrira a ce prix ; une nuit ouverte a la main sort aussi — l'hote confirme
// en voyant la liste. Une nuit FERMEE n'est jamais listee (elle n'est pas en
// vente) ; une fermeture de l'hote porte `stop_sell = true`, donc n'y est pas.

const { nuitsVendues } = require('./nuits-du-moteur')
const { finDeFenetre } = require('./pilote-tarifaire')

const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
const LIGNES_MAX = 5000

/**
 * @param bien        ligne `properties` (id, user_id, provider_property_id,
 *                    inventory_units, pilote_*)
 * @param fenetre     la NOUVELLE fenetre { type, valeur }
 * @param aujourdHui  'AAAA-MM-JJ', heure de Paris — injecte
 * @returns { reduction, ancienneFin, nouvelleFin, dates: [...], vendues: n }
 *          `reduction` : la nouvelle fin est plus proche que l'ancienne
 *          (information pour l'ecran ; la liste ne depend pas d'elle).
 * @throws  sur une lecture en echec — une liste vide par erreur dirait « rien
 *          a retirer » et laisserait les nuits en vente sans un mot.
 */
async function nuitsQuiSortent (supabase, bien, fenetre, aujourdHui) {
  if (!JOUR_RE.test(String(aujourdHui || ''))) throw new Error('[retrait-fenetre] aujourdHui illisible')
  if (!bien || !bien.id || !bien.user_id) throw new Error('[retrait-fenetre] bien incomplet (id, user_id)')
  const ancienneFin = finDeFenetre(bien, aujourdHui)
  const nouvelleFin = finDeFenetre({ ...bien, pilote_fenetre_type: fenetre.type, pilote_fenetre_valeur: fenetre.valeur }, aujourdHui)
  if (!nouvelleFin) throw new Error('[retrait-fenetre] nouvelle fenetre illisible')
  // ⚠ ON NE SE FIE PAS A L'ANCIENNE FIN : des nuits ont pu etre ouvertes
  // au-dela par une fenetre plus grande encore (La bulle, 12 mois au
  // 23 septembre, 11 ensuite). Tout ce qui est ouvert apres la NOUVELLE fin
  // sort, jusqu'a la derniere ligne — que la fenetre se reduise, s'agrandisse
  // ou soit reenregistree telle quelle (c'est ainsi qu'un reliquat se range).
  const reduction = !ancienneFin || nouvelleFin < ancienneFin
  const debut = nouvelleFin >= aujourdHui ? nouvelleFin : aujourdHui
  const lignes = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, stop_sell, avail, rate')
      .eq('property_id', bien.id).eq('stop_sell', false).gt('date', debut)
      .order('date').range(from, from + 999)
    if (error) throw new Error(`[retrait-fenetre] lecture du calendrier : ${error.message}`)
    lignes.push(...(data || []))
    if (!data || data.length < 1000) break
    if (lignes.length > LIGNES_MAX) throw new Error('[retrait-fenetre] calendrier trop volumineux')
  }
  if (!lignes.length) return { reduction, ancienneFin, nouvelleFin, dates: [], vendues: 0 }
  const vendues = await nuitsVendues(supabase, bien, lignes[0].date, lignes[lignes.length - 1].date)
  const dates = lignes.map(l => l.date).filter(d => !vendues.has(d))
  return { reduction, ancienneFin, nouvelleFin, dates, vendues: lignes.length - dates.length }
}

module.exports = { nuitsQuiSortent }
