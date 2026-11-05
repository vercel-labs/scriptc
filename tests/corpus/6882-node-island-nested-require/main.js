// @requires-libnode
// require() of a Node island package inside functions of a CommonJS
// entry: the module loads at the first call that requires it (after the
// environment write before that call), later calls get the same module.
'use strict'

function viaExpression(name) {
  return require('lazykit').greet(name)
}

function viaBinding(name) {
  const lazykit = require('lazykit')
  return `${lazykit.greet(name)} (${lazykit.loads()} load)`
}

const lazy = {
  get kit() {
    return require('lazykit')
  },
}

console.log('start')
process.env.ISLAND_PHASE = 'after-start'
console.log(viaExpression('first'))
console.log(viaBinding('second'))
console.log(lazy.kit.greet('getter'), lazy.kit === require('lazykit'))

// A function's own binding of a package the module also requires at its
// top level, called before that line runs.
function early(name) {
  const kit = require('lazykit')
  return kit.greet(name)
}
console.log(early('local binding'))
console.log(require('./spaced').viaSpaced('spaced'))
const topKit = require('lazykit')
console.log('top level', topKit.loads())
