// Chained export declarations with array values, read through destructured
// requires (renamed and not), through the module binding, and after writes
// made by the exporting module's own functions.
const { patterns, index, sources, order } = require('./tokens.cjs')
const { patterns: again, limit, sequence, count } = require('./tokens.cjs')
const tokens = require('./tokens.cjs')

console.log(sources[index.NUMBER], patterns[index.WORD].test('abc'), again === patterns, tokens.patterns === patterns)
console.log(Object.keys(index).join(','), limit, order.join('|'), sequence === order, count())

function isNumber(text) {
  return patterns[index.NUMBER].test(text)
}
console.log(isNumber('12'), isNumber('x'), sources.length, patterns.length, tokens.sources.length)

const WORDS = new RegExp(sources[index.WORD], 'g')
console.log('a bc d'.match(WORDS).length, Array.isArray(sources), Array.isArray(tokens.order))

sources.push('late')
console.log(tokens.sources[3], tokens.sources.length)

const { stack, push, top, seen: marks, plain } = require('./fresh.cjs')
const fresh = require('./fresh.cjs')
console.log(push('a'), push('b'), stack.join(''), fresh.stack === stack, top(), stack.length)
console.log(JSON.stringify(marks), plain.join(''), fresh.plain === plain, typeof fresh.push, fresh.top(), fresh.seen === marks)
