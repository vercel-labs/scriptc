// The module builds its export object anew, then defines members on it:
// some inside a declaration, some as plain statements.
exports = module.exports = {}

const stack = exports.stack = []
const seen = exports.seen = {}
exports.plain = []

exports.push = function (value) {
  stack[stack.length] = value
  seen[value] = stack.length
  exports.plain.push(value.toUpperCase())
  return stack.length
}
exports.top = () => stack[stack.length - 1]
