// A top-level destructured require with a rest element: Node copies the
// module's remaining own enumerable exports into a FRESH object at the
// require, in the exports object's own key order. The binding's remaining
// members read like any object's, and a rest of the rest works too.
'use strict';

const { double, ...rest } = require('./lib.js');
const { alpha, ...members } = require('./members.js');

console.log(double(21), rest.VERSION, rest.bump(41), rest.label);
const { VERSION, ...more } = rest;
console.log(VERSION, more.label, more.bump(1));
console.log(alpha, members.beta, JSON.stringify(members));
