// Un enfant qui avorte sans que son tas soit plein
// (tests/charges-fil-isole.test.js).
process.once('disconnect', () => process.exit(0))
process.once('message', () => { process.stderr.write('autre chose qu\'un tas plein\n'); process.abort() })
