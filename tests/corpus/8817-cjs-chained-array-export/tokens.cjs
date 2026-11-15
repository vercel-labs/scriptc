// Each export is defined inside the declaration of the local that names it.
// The local and the export are one array (or one object), which the
// function below grows after both are bound.
const patterns = exports.patterns = []
const sources = exports.sources = []
const index = exports.index = {}
var order = exports.order = module.exports.sequence = []
let next = 0

const define = (name, source, global) => {
  const at = next++
  index[name] = at
  sources[at] = source
  patterns[at] = new RegExp(source, global ? 'g' : undefined)
  order.push(name)
}

define('NUMBER', '0|[1-9]\\d*')
define('WORD', '[a-z]+', true)
define('DASH', '-')

exports.limit = 16
exports.count = () => next
