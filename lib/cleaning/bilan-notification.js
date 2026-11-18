// lib/cleaning/bilan-notification.js — lire le bilan d'une notification de
// prestataire (lib/cleaning/notifier-prestataire.js) : a-t-elle été prévenue ?
//
// ⚠ UNE NOTIFICATION REÇUE COMPTE, au même titre qu'un SMS ou un e-mail (PWA
// lot 3). Depuis que la notification passe d'abord et que le SMS ne part qu'en
// secours, un compteur qui ne lisait que `sms`/`email` aurait compté « muette »
// une personne prévenue sur son téléphone.
//
// ⚠ UN MODULE À PART, SANS DÉPENDANCE : les appelants le lisent directement, et
// les tests qui remplacent `notifier-prestataire` par un double n'emportent pas
// la règle avec lui.
function aEtePrevenue (bilan) {
  return !!(bilan && (Number(bilan.push) > 0 || bilan.sms === true || bilan.email === true))
}

module.exports = { aEtePrevenue }
