'use strict'
// A CommonJS module of the package: member exports, a class, and a table
// whose getter stops Node's lexer before the names after it.
class Pool {
  constructor (origin, options) {
    this.origin = origin
    this.connections = options.connections
    this.requests = 0
  }

  request (path) {
    this.requests += 1
    return `${this.origin}${path} #${this.requests}`
  }
}

function setGlobalDispatcher (dispatcher) {
  exports.current = dispatcher
  return dispatcher.origin
}

exports.Pool = Pool
exports.setGlobalDispatcher = setGlobalDispatcher
exports.current = null
exports.defaults = { connections: 4, keepAlive: true }
exports.format = function format (value) { return `[${value}]` }
