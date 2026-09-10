// tests/disconnect-mauvais-canal.test.js
// LE DEFAUT : deconnecter Airbnb supprimait le canal BOOKING.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('LE TEST QUI COMPTE : l ecran Airbnb ne voit QUE les canaux Airbnb', () => {
  // ⚠ MESURE DU 10 SEPTEMBRE 2026. Le canal Booking de La bulle a disparu, et
  // la date rouverte le 31 octobre est restee fermee chez Booking — faute de
  // canal pour la porter. Airbnb, lui, l'avait bien ouverte.
  //
  // LA CHAINE : `action=channels` rend TOUS les canaux du bien (il expose meme
  // le champ `ota`), et `detectAndRoute` prenait `chans.find(c => c.is_active)`.
  // Le canal Booking, cree en premier et actif, etait donc retenu comme « la
  // connexion Airbnb » : l'ecran annoncait « Airbnb est deja connecte », et
  // « Deconnecter cette annonce » envoyait `disconnect` sur le canal BOOKING.
  const src = lire('components/airbnb-connect.js')
  const i = src.indexOf('async function detectAndRoute')
  const bloc = src.slice(i, i + 1800)
  assert.ok(/filter\(c => \/airbnb\/i\.test\(String\(c\.ota \|\| ''\)\)\)/.test(bloc),
    'la liste est filtree sur l OTA avant toute selection')
  const iFiltre = bloc.indexOf('filter(c => /airbnb/i')
  const iFind = bloc.indexOf('.find(c => c.is_active)')
  assert.ok(iFiltre > 0 && iFind > iFiltre,
    'le filtre precede la selection du canal actif')
})

test('LE TEST QUI COMPTE : disconnect ne devine plus le canal, et refuse un canal non Airbnb', () => {
  const src = lire('api/channel-mapping.js')
  const i = src.indexOf("if (action === 'disconnect')")
  const bloc = src.slice(i, src.indexOf("if (action === ", i + 10))

  // ⚠ `rows[0]` PRENAIT LE PREMIER CANAL DU BIEN, quel que soit l'OTA.
  assert.ok(!/channelId = rows\[0\]\?\.id/.test(bloc),
    'plus de rows[0] aveugle')
  assert.ok(/abnb = rows\.filter\(c => \/airbnb\/i\.test/.test(bloc),
    'la resolution automatique ne retient que les canaux Airbnb')
  assert.ok(/Plusieurs canaux Airbnb sur ce logement/.test(bloc),
    'et refuse plutot que de choisir s il y en a plusieurs')

  // ⚠ ET LE `channel_id` FOURNI PAR L'APPELANT EST VERIFIE AUSSI : le filtre
  // ci-dessus ne couvre que le cas ou il est absent, et c'est justement un
  // channel_id fourni qui a supprime le canal Booking.
  assert.ok(/n'est pas un canal Airbnb/.test(bloc),
    'un channel_id qui designe un autre OTA est refuse')
  // On compare a l'APPEL reseau, pas au mot « DELETE » : il apparait dans un
  // commentaire plus haut (« .id = mapping_id a DELETE »), et le test tombait
  // sur sa propre documentation.
  const iVerif = bloc.indexOf("n'est pas un canal Airbnb")
  const iDelete = bloc.indexOf("channelCall('DELETE'")
  assert.ok(iVerif > 0 && iDelete > 0 && iVerif < iDelete,
    'la verification precede tout appel DELETE')
})

test('LE TEST QUI COMPTE : le repli `sole_entry` n est plus le chemin normal', () => {
  // ⚠ MON PROPRE CORRECTIF AVAIT ARME CE PIEGE.
  // `provider_rate_plan_id` est le tarif de BASE. Depuis que tous les mappings
  // pointent le tarif DERIVE du canal (correctif du 10 septembre : mapper la
  // base envoyait le prix non derive a l'OTA), le match sur la base
  // n'aboutissait PLUS JAMAIS — et `sole_entry`, concu comme l'exception pour
  // Colomiers, devenait le SEUL chemin. Un repli qui devient la regle supprime
  // un mapping que la fonction n'a pas identifie comme le sien.
  const src = lire('api/channel-mapping.js')
  const i = src.indexOf("if (action === 'disconnect')")
  const bloc = src.slice(i, src.indexOf("if (action === ", i + 10))

  assert.ok(/\.eq\('channel', 'airbnb'\)\.eq\('role', 'derived'\)/.test(bloc),
    'le tarif derive airbnb est lu depuis property_channel_rate_plans')
  assert.ok(/const cibles = \[ratePlanId, lienAbnb\?\.provider_rate_plan_id\]/.test(bloc),
    'base ET derive sont des cibles valides')
  assert.ok(/cibles\.includes\(String\(rpUnderlying\(rp\)\)\)/.test(bloc),
    'le match porte sur les deux')
  // Le repli existe encore — il couvre un mapping pose a la main hors de nos
  // liens — mais il n'est plus atteint dans le cas courant.
  assert.ok(/matchedBy = 'sole_entry'/.test(bloc), 'le repli reste, en dernier recours')
})
