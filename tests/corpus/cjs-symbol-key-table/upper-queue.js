'use strict';

const Queue = require('./queue');
const symbols = require('./symbols');

class UpperQueue extends Queue {
  [symbols.kRun](items) {
    return items.map((item) => String(item).toUpperCase()).join(' ');
  }
}

module.exports = UpperQueue;
