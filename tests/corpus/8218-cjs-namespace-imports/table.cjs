'use strict'
const add = (a, b) => a + b
const scale = 10
let calls = 0
module.exports = {
  add,
  scale,
  get calls () { return calls },
  bump () { calls += 1 }
}
