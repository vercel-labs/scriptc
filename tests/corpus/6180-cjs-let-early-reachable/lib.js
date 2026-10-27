'use strict';

let source;
const parse = function parse(text) {
  source = text;
  return lex();
};
module.exports = parse;

try {
  console.log('early', parse('early'));
} catch (e) {
  console.log('early', e instanceof ReferenceError, e.message);
}

let state;
let count;
function lex() {
  state = state === undefined ? 'fresh' : 'seen';
  count = count === undefined ? 1 : count + 1;
  return source + ':' + state + ':' + count;
}

console.log('loaded', state, count);
