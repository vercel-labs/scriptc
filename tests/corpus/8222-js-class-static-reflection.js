'use strict'
// A class's statics extracted, then removed with Reflect.deleteProperty, and
// redefined with Object.defineProperties (undici's FormData and Response).

const kEnumerableProperty = { __proto__: null, enumerable: true }

class FormData {
  #state = []
  append (name, value) { this.#state.push({ name, value }) }
  static getFormDataState (formData) { return formData.#state }
  static setFormDataState (formData, state) { formData.#state = state }
}

const getFormDataState = FormData.getFormDataState
const setFormDataState = FormData.setFormDataState
console.log(Reflect.deleteProperty(FormData, 'getFormDataState'))
console.log(Reflect.deleteProperty(FormData, 'setFormDataState'))
console.log(Reflect.deleteProperty(FormData, 'missing'))
console.log(typeof FormData.getFormDataState, typeof FormData.setFormDataState)

const form = new FormData()
form.append('a', 1)
form.append('b', 'two')
console.log(getFormDataState(form))
setFormDataState(form, [{ name: 'c', value: true }])
console.log(getFormDataState(form).length, getFormDataState(form)[0].name)
try {
  FormData.getFormDataState(form)
} catch (error) {
  console.log(error.constructor.name, error.message)
}

class Response {
  #status
  constructor (status) { this.#status = status }
  get status () { return this.#status }
  static json () { return new Response(200) }
  static error () { return new Response(0) }
  static getResponseState (response) { return response.#status }
}

const getResponseState = Response.getResponseState
Reflect.deleteProperty(Response, 'getResponseState')
Object.defineProperties(Response, {
  json: kEnumerableProperty,
  error: kEnumerableProperty
})
const response = Response.json()
console.log(response.status, Response.error().status, getResponseState(response))
for (const key of ['json', 'error', 'getResponseState']) {
  const descriptor = Object.getOwnPropertyDescriptor(Response, key)
  console.log(key, descriptor === undefined ? 'absent' : [descriptor.enumerable, descriptor.writable, descriptor.configurable, typeof descriptor.value])
}

// Statics a subclass inherits, a static field and a static accessor.
class Base {
  static helper () { return 'helper' }
  static count = 3
  static get label () { return 'label' }
}
class Child extends Base {}
console.log(Child.helper(), Child.count, Child.label)
console.log(Reflect.deleteProperty(Base, 'helper'), Reflect.deleteProperty(Base, 'count'))
console.log(typeof Child.helper, Child.count, typeof Base.helper, Base.count)
console.log(Reflect.deleteProperty(Base, 'label'), Base.label, Child.label)
Base.helper = () => 'replaced'
console.log(Base.helper(), Child.helper())
Base.count = 4
const countKey = { toString () { return 'count' } }
console.log(Reflect.deleteProperty(Base, countKey), Base.count)
class Key {
  constructor (name) { this.name = name }
  toString () { return this.name }
}
Base.count = 5
console.log(Reflect.deleteProperty(Base, new Key('count')), Base.count)

// Checked-dynamic objects and primitive targets.
const parsed = JSON.parse('{"a":1,"b":2}')
console.log(Reflect.deleteProperty(parsed, 'a'), parsed)
const frozen = Object.freeze(JSON.parse('{"a":1}'))
console.log(Reflect.deleteProperty(frozen, 'a'), frozen)
const attempt = (run) => {
  try {
    run()
  } catch (error) {
    console.log(error.constructor.name, error.message)
  }
}
attempt(() => Reflect.deleteProperty(1, 'a'))
attempt(() => Reflect.deleteProperty('text', 'a'))
attempt(() => Reflect.deleteProperty(null, 'a'))
attempt(() => Reflect.deleteProperty(undefined, 'a'))
attempt(() => Reflect.deleteProperty(true, 'a'))
