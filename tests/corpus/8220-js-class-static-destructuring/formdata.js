'use strict'
// undici's FormData: statics that read private instance state, taken off
// the class before the class is exposed.
class FormData {
  #state = []

  append (name, value) {
    this.#state.push({ name, value })
  }

  static getFormDataState (formData) {
    return formData.#state
  }

  static setFormDataState (formData, state) {
    formData.#state = state
  }

  static get boundary () {
    return undefined
  }
}

const { getFormDataState, setFormDataState, boundary = '----formdata-default' } = FormData

module.exports = { FormData, getFormDataState, setFormDataState, boundary }
