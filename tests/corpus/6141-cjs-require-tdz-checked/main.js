// Require bindings that code running before the require can read. Every
// read that happens before the require throws Node's ReferenceError for
// the local binding name, before any argument of the access evaluates;
// the same reads succeed once the require ran.
'use strict';

/**
 * @param {string} label
 * @param {() => unknown} read
 */
function attempt(label, read) {
  try {
    console.log(label, 'ok', read());
  } catch (e) {
    if (!(e instanceof ReferenceError)) throw e;
    console.log(label, e.name, e.message);
  }
}

/** @param {string} s */
function note(s) {
  console.log('evaluated', s);
  return s;
}

const later = [() => greet('later'), () => new Counter(5).next()];

attempt('call', () => greet('a'));
attempt('call-arguments', () => greet(note('argument')));
attempt('member', () => lib.greet('b'));
attempt('construct', () => new Counter(1).next());
attempt('builtin', () => path.join('a', 'b'));
attempt('value', () => answer + 1);
attempt('renamed', () => hello('c'));

const { greet } = require('./lib.js');
const lib = require('./lib.js');
const Counter = require('./counter.js');
const path = require('path');
const { answer, greet: hello } = require('./lib.js');

attempt('call', () => greet('a'));
attempt('call-arguments', () => greet(note('argument')));
attempt('member', () => lib.greet('b'));
attempt('construct', () => new Counter(1).next());
attempt('builtin', () => path.join('a', 'b'));
attempt('value', () => answer + 1);
attempt('renamed', () => hello('c'));
for (const read of later) console.log('later', read());
