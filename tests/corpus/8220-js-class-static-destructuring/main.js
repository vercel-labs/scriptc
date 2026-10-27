'use strict'
// Object patterns over a class value read its static getters, fields and
// methods as Node does, defaults included.
const Comparator = require('./classes/comparator')
const { outside, ANY, any, isLoose, name } = require('./ranges/outside')
const { FormData, getFormDataState, setFormDataState, boundary } = require('./formdata')

console.log(typeof ANY, ANY === Comparator.ANY, any === ANY, isLoose, name)
console.log(outside(''), outside('1.2.3'))
console.log(Comparator.parse('').semver === ANY, Comparator.parse('2.0.0').semver === ANY)

const form = new FormData()
form.append('a', 1)
form.append('b', 'two')
console.log(getFormDataState(form))
setFormDataState(form, [{ name: 'c', value: true }])
console.log(getFormDataState(form), boundary)

class Defaults {
  static count = 0
  static missing = undefined
  static nested = { inner: 'value' }
}
const { count = 5, missing = 'fallback', nested: { inner, other = 'other' } } = Defaults
console.log(count, missing, inner, other)

// Inherited statics, and a static getter reading the class it is read
// through.
class Base {
  static tag = 'base'
  static get label () { return `label:${this.tag}` }
  static make () { return this.tag }
}
class Sub extends Base {
  static tag = 'sub'
}
const { tag, label, make, name: subName } = Sub
const { label: baseLabel } = Base
console.log(tag, label, typeof make, subName, baseLabel)
