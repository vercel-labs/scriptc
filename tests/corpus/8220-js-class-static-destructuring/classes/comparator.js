'use strict'
// semver's Comparator: a static getter returning a module symbol.
const ANY = Symbol('SemVer ANY')

class Comparator {
  static get ANY () {
    return ANY
  }

  static loose = false

  static parse (text) {
    return new Comparator(text)
  }

  constructor (text) {
    this.semver = text === '' ? ANY : text
    this.value = text === '' ? '' : `>=${text}`
  }
}

module.exports = Comparator
