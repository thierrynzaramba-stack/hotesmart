// Un enfant qui remplit son tas JavaScript jusqu'à l'avortement
// (tests/charges-fil-isole.test.js).
process.once('disconnect', () => process.exit(0))
process.once('message', () => {
  const a = []
  for (;;) a.push(new Array(1e5).fill(Math.random()))
})
