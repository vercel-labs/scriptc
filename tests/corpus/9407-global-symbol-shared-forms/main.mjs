// A file-scope binding initialized from the global object's symbol store,
// shared in the ways a module shares a binding besides a plain read in a
// function: an object shorthand inside a function, an export list entry,
// an export list entry under another name, a default export.
import { state } from './listed.mjs';
import { shared } from './renamed.mjs';
import held from './default.mjs';

const KEY = Symbol.for('corpus.9407.local');
const local = globalThis[KEY] ?? { marks: [] };
function snapshot() {
  return { local };
}
snapshot().local.marks.push('a');
console.log('shorthand', snapshot().local.marks.join(','), snapshot().local === local);

class Reader {
  view() {
    return { local, size: local.marks.length };
  }
}
console.log('shorthand in a method', new Reader().view().size, new Reader().view().local === local);

function add(name) {
  state.marks.push(name);
  shared.marks.push(name + name);
  held.marks.push(name + '!');
}
add('b');
console.log('export list', state.marks.join(','));
console.log('renamed export', shared.marks.join(','));
console.log('default export', held.marks.join(','));
