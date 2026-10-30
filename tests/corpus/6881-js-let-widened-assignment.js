// A JavaScript binding whose later assignments store values its
// initializer's type does not admit (TS2322, relaxed in JavaScript files):
// the binding holds whatever the program stores, as in Node. Next.js's
// standalone server.js does this with KEEP_ALIVE_TIMEOUT.
let keepAliveTimeout = parseInt(process.env.SCRIPTC_UNSET_TIMEOUT, 10)
if (Number.isNaN(keepAliveTimeout) || !Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) {
  keepAliveTimeout = undefined
}
console.log(keepAliveTimeout, typeof keepAliveTimeout)
const opts = { keepAliveTimeout }
console.log(JSON.stringify(opts), 'keepAliveTimeout' in opts, opts.keepAliveTimeout === undefined)

let label = 'none'
function relabel(n) {
  label = n
}
relabel(42)
console.log(label, typeof label)

function show(raw) {
  let value = Number(raw)
  if (Number.isNaN(value)) value = null
  console.log('value', value, value === null)
}
show('12')
show('x')

var counter = 0
counter = counter + 1
console.log('counter', counter)

let port = parseInt('8080', 10)
if (port > 65535) port = undefined
console.log('port', port, typeof port)
