// @dynamic
// The computed-require program: `require(path.join(__dirname, ...))` with a
// specifier known only at runtime — nothing embedded to resolve at build
// time, so each site lowers to a per-site island that answers the require
// exactly like Node (file resolution, the module cache's shared state
// across calls, JSON documents, and a throw on a miss). Island VALUES read
// through the supported spellings: template wraps for strings, numbers and
// booleans marshal directly.
'use strict';

const path = require('node:path');

// A computed specifier for a CommonJS sibling: resolution walks the
// extension candidates (the exact ".cjs" name here), and the loaded
// module's exports answer like any require table.
const libName = ['lib', 'cjs'].join('.');
const lib = require(path.join(__dirname, libName));
console.log(lib.double(21), `${lib.VERSION}`);

// A JSON document sibling: parsed once, cached by key.
const docName = 'data' + '.json';
const doc = require(path.join(__dirname, docName));
console.log(`${doc.name}`, doc.tags.length, `${doc.tags[1]}`);

// Node's module cache: the same resolved key answers with the SAME
// module instance — a stateful export proves the cache is shared across
// the two require sites (a re-load would restart the counter).
const again = require(path.join(__dirname, 'lib.cjs'));
console.log(lib.bump(), again.bump(), lib.bump());

// A miss throws (Node's MODULE_NOT_FOUND shape inside the island).
try {
  require(path.join(__dirname, 'nope' + '.cjs'));
  console.log('no throw');
} catch (e) {
  console.log(e instanceof Error);
}
