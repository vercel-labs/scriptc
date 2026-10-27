'use strict'
// semver's internal/re.js shape: export members assigned in value position.
exports = module.exports = {}
const re = exports.re = []
const src = exports.src = []
const t = exports.t = {}
let R = 0
const createToken = (name, value) => {
  const index = R++
  t[name] = index
  src[index] = value
  re[index] = value.length
}
exports.count = () => R
createToken('MAIN', 'x.y.z')
createToken('LOOSE', 'v?x')
