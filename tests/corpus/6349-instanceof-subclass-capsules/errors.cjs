'use strict';
class UndiciError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UndiciError';
    this.code = 'UND_ERR';
  }
  get kind() {
    return 'undici';
  }
}
class SocketError extends UndiciError {
  constructor(message) {
    super(message);
    this.name = 'SocketError';
  }
}
class HTTPParserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HTTPParserError';
  }
}
module.exports = { UndiciError, SocketError, HTTPParserError };
