'use strict';

const Client = require('./client');
const { kClose, kCalls } = require('./mock-symbols');

// Inherits the core `Symbol('close')` slot and declares a method under the
// mock table's distinct `Symbol('close')` (undici's MockClient shape).
class MockClient extends Client {
  constructor(url) {
    super(url);
    this[kCalls] = '';
  }

  [kClose]() {
    this[kCalls] = this[kCalls] + '*';
    return 'mock close ' + this[kCalls];
  }

  shutdown() {
    return this[kClose]() + ' then ' + this.close();
  }
}

module.exports = MockClient;
