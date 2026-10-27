// require() of a JSON document: Node parses it at the first require and
// caches the object, so every require of the document, from any module,
// returns the same object and a mutation is visible to all requirers.
// Destructuring copies the properties at the require.
'use strict';

const data = require('./data.json');
const { count, nested: { flag, ratio }, tags: [firstTag] } = require('./data.json');
const version = require('./data.json').version;

console.log(data.name, version, data.count, count, flag, ratio, firstTag);
console.log('same object', require('./data.json') === data);

const { bump } = require('./counter.js');
console.log('after counter', data.count, count);
bump();
console.log('after bump', data.count, data.tags.join(','), count);

function load() {
  return require('./data.json');
}
console.log('lazy same object', load() === data, load().count);
load().nested.flag = false;
console.log('flag', data.nested.flag, flag);

const list = require('./list.json');
console.log(list.length, list.slice().sort().join(','), require('./list.json') === list);
