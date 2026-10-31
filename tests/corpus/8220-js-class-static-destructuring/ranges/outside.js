'use strict'
// semver's ranges/outside.js and ranges/subset.js destructure the class's
// statics at module load.
const Comparator = require('../classes/comparator')
const { ANY } = Comparator
const { ANY: any, loose: isLoose = true, parse, name } = Comparator

const outside = (text) => {
  const comparator = parse(text)
  return comparator.semver === ANY ? 'any' : comparator.value
}

module.exports = { outside, ANY, any, isLoose, name }
