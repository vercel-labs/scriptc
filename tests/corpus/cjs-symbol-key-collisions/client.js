'use strict';

const { kClose, kUrl } = require('./core-symbols');

class Client {
  constructor(url) {
    this[kUrl] = url;
    this[kClose] = 'core close slot';
  }

  close() {
    return 'closing ' + this[kUrl] + ' (' + this[kClose] + ')';
  }
}

module.exports = Client;
