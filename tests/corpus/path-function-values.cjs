'use strict';
// node:path namespaces and functions used as values: identity, Node's
// argument validation, and the parse/format/resolve/toNamespacedPath forms.
const path = require('path');

const platform = process.platform === 'win32' ? path.win32 : path.posix;
console.log('identity',
  path === platform,
  require('path/posix') === path.posix,
  require('path/win32') === path.win32,
  path.posix.win32 === path.win32,
  path.win32.posix === path.posix);

function call(fn, args) {
  try {
    return JSON.stringify(fn.apply(null, args));
  } catch (e) {
    return `${e.name} ${e.code} ${e.message}`;
  }
}

for (const [name, ns] of [['posix', path.posix], ['win32', path.win32]]) {
  console.log(`-- ${name}`);
  for (const value of [true, 7, null, {}, undefined, []]) {
    console.log('join', call(ns.join, ['a', value]));
    console.log('normalize', call(ns.normalize, [value]));
    console.log('basename suffix', call(ns.basename, [value, 7]));
    console.log('basename', call(ns.basename, [value]));
    console.log('relative from', call(ns.relative, [value, 'x']));
    console.log('relative to', call(ns.relative, ['x', value]));
    console.log('matchesGlob', call(ns.matchesGlob, ['a', value]));
    console.log('parse', call(ns.parse, [value]));
    console.log('format', call(ns.format, [value]));
    console.log('toNamespacedPath', call(ns.toNamespacedPath, [value]));
  }
  console.log('join none', call(ns.join, []));
  console.log('basename undefined suffix', call(ns.basename, ['/a/b.js', undefined]));
  // resolve reads its arguments last first and stops at an absolute path.
  console.log('resolve stop', call(ns.resolve, [7, '/abs/x']));
  console.log('resolve bad', call(ns.resolve, ['/abs', 7, 'y']));
  console.log('resolve bad last', call(ns.resolve, ['/abs', 'y', null]));
  console.log('parse', call(ns.parse, ['/home/user/dir/file.txt']));
  console.log('format base', call(ns.format, [{ base: 5 }]));
  console.log('format dir root', call(ns.format, [{ root: '/', dir: '/', base: 'x' }]));
  console.log('format ext', call(ns.format, [{ name: 'x', ext: 'png' }]),
    call(ns.format, [{ name: 'x', ext: '.png' }]), call(ns.format, [{ name: 'x', ext: 5 }]));
  console.log('format empty', call(ns.format, [{}]));
}
console.log('win32 resolve devices',
  call(path.win32.resolve, [null, 'c:\\a', 'd:\\b']),
  call(path.win32.resolve, [null, 'c:a', 'd:\\b']),
  call(path.win32.resolve, [null, '\\\\server\\share\\x']),
  call(path.win32.resolve, ['d:x', null, 'c:\\b']));
console.log('win32 namespaced', call(path.win32.toNamespacedPath, ['c:\\x']),
  call(path.win32.toNamespacedPath, ['']));

// The same members reached through the namespace object are the same values.
const ns = path.posix;
console.log('members', ns.join === path.posix.join, typeof ns.parse, ns.sep, path.win32.delimiter);
for (const key of ['basename', 'extname']) console.log(key, path[key]('/a/b.txt'));
