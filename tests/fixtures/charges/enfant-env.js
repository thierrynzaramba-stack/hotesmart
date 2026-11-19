// Un enfant qui rend les NOMS de ses variables d'environnement — jamais leurs
// valeurs — et la borne de son tas (tests/charges-fil-isole.test.js).
process.once('disconnect', () => process.exit(0))
process.once('message', () => process.send({ noms: Object.keys(process.env), tas: require('node:v8').getHeapStatistics().heap_size_limit }))
