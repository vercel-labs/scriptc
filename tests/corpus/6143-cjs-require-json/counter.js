'use strict';

// A second requirer: it receives the same cached object and mutates it.
const data = require('./data.json');

console.log('counter: sees', data.count);
data.count += 1;

function bump() {
  data.count += 100;
  data.tags.push('bumped');
}

module.exports = { bump };
