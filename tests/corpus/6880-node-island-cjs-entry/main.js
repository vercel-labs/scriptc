// @requires-libnode
// The shape of a Next.js standalone server.js: a CommonJS entry that writes
// process.env, then requires packages that ship no declarations (TS7016 in
// a JavaScript file is relaxed), destructures one of them, and calls into
// it. The packages run in Node islands. Each require loads its island module
// at the statement, so the environment writes before it are visible to the
// module's evaluation, as in Node.
const path = require('path')

console.log('entry start')
process.env.ISLAND_MODE = 'production'
process.env.ISLAND_CONFIG = JSON.stringify({ name: path.basename('/srv/app'), port: 3000 })

require('envkit')
const envkit = require('envkit')
const { startServer, version: startVersion } = require('startkit')

console.log(envkit.seen())
console.log('loads', envkit.loads())
console.log('startkit', startVersion, typeof startServer)

const config = JSON.parse(process.env.ISLAND_CONFIG)
startServer({ name: config.name, port: config.port })
  .then((message) => {
    console.log(message)
    return startServer({ name: 'bad', port: -1 })
  })
  .catch((err) => {
    console.log('caught', err.message)
  })
