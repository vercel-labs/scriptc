'use strict';
// Direct node:path calls whose JavaScript arguments are not strings, and
// computed reads of the path namespaces.
const path = require('path');

function attempt(label, fn) {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

// toNamespacedPath answers a non-string argument as it is.
console.log('toNamespacedPath', path.toNamespacedPath(null), path.toNamespacedPath(100),
  path.toNamespacedPath(false), path.posix.toNamespacedPath(), path.toNamespacedPath(path) === path,
  path.win32.toNamespacedPath(7), path.win32.toNamespacedPath(''));
attempt('matchesGlob path', () => path.matchesGlob(123, 'foo/bar/baz'));
attempt('matchesGlob pattern', () => path.matchesGlob('foo/bar/baz', 123));
attempt('basename suffix', () => path.basename('/a/b.js', 7));
attempt('basename undefined suffix', () => path.basename('/a/b.js', undefined));
attempt('dirname null', () => path.dirname(null));
attempt('extname object', () => path.extname({}));
attempt('isAbsolute undefined', () => path.isAbsolute(undefined));
attempt('relative', () => path.relative('/a', 5));
attempt('normalize none', () => path.normalize());
attempt('parse number', () => path.parse(1));

for (const family of ['posix', 'win32']) {
  const ns = path[family];
  console.log(family, ns.sep, ns.delimiter, path[family].basename('/x/y.txt'), ns === path[family]);
  attempt(`${family} computed join`, () => path[family]['join']('a', 'b'));
}
const assert = require('assert');
assert.strictEqual(path, process.platform === 'win32' ? path.win32 : path.posix);
assert.notStrictEqual(path.posix, path.win32);
assert.strictEqual(require('path/posix'), path.posix);
const key = 'missing';
console.log('missing member', typeof path[key], typeof path.posix['_makeLong']);
