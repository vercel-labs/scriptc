'use strict'
const util = require('node:util')
const getCallSites = util.getCallSites
console.log(typeof getCallSites, getCallSites.name, getCallSites.length)
console.log(getCallSites === util.getCallSites)
const optional = util.getCallSites ?? util.getCallSite
console.log(optional === getCallSites)
function configure (options) {
  const { caller = getCallSites() } = options
  return caller
}
console.log(configure({ caller: 'explicit' }))
console.log('logger remains enabled')
