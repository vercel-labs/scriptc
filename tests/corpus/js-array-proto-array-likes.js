// Array.prototype's methods are generic: they run over any object with a
// length, reading and writing ordinary properties. A call on such an
// object used to answer "not supported yet" for every method other than
// at/slice/indexOf/includes and the callback methods.
const resolved = [];
const report = (label, value) => resolved.push(label + '=' + value);

const box = { length: 3, 0: 'a', 1: 'b', 2: 'c' };
report('join', Array.prototype.join.call(box, '-'));
report('push', Array.prototype.push.call(box, 'd'));
report('after-push', Array.prototype.join.call(box, ''));
report('pop', Array.prototype.pop.call(box));
report('length', box.length);
report('shift', Array.prototype.shift.call(box));
report('unshift', Array.prototype.unshift.call(box, 'x', 'y'));
report('after-unshift', Array.prototype.join.call(box, ','));
report('reverse', Array.prototype.join.call(Array.prototype.reverse.call(box), '/'));
report('concat', Array.prototype.concat.call(box, ['z']).join('+'));
report('slice', Array.prototype.slice.call(box).join('|'));

const filler = { length: 4, 0: 1, 1: 2, 2: 3, 3: 4 };
report('fill', Array.prototype.join.call(Array.prototype.fill.call(filler, 0, 1, 3), ''));
report('copyWithin', Array.prototype.join.call(Array.prototype.copyWithin.call(filler, 0, 2), ''));

const spliced = { length: 4, 0: 'a', 1: 'b', 2: 'c', 3: 'd' };
report('splice', Array.prototype.splice.call(spliced, 1, 2, 'X').join(''));
report('after-splice', Array.prototype.join.call(spliced, ''));
report('splice-none', Array.prototype.splice.call(spliced).length);

const ordered = { length: 3, 0: 3, 1: 1, 2: 2 };
report('toSorted', Array.prototype.toSorted.call(ordered).join(''));
report('toReversed', Array.prototype.toReversed.call(ordered).join(''));
report('toSpliced', Array.prototype.toSpliced.call(ordered, 1, 1).join(''));
report('with', Array.prototype.with.call(ordered, 0, 9).join(''));
report('with-negative', Array.prototype.with.call(ordered, -1, 9).join(''));
report('unsorted', Array.prototype.join.call(ordered, ''));

const nested = { length: 3, 0: [1, 2], 1: 3, 2: [4, [5]] };
report('flat', Array.prototype.flat.call(nested, 1).join(''));
report('flat-deep', Array.prototype.flat.call(nested, 2).join(''));
report('flatMap', Array.prototype.flatMap.call(nested, (value) => [value, value]).length);

// toReversed defines every index on its result, so a hole becomes undefined.
const sparse = { length: 3, 0: 'a', 2: 'c' };
const copied = Array.prototype.toReversed.call(sparse);
report('holes', '1' in copied ? 'present' : 'absent');
report('holes-join', copied.join(''));

// Writes beyond the receiver's length extend it, as the length assignment
// at the end of push/splice does.
const extended = { length: 1, 0: 'only' };
Array.prototype.push.call(extended, 'next');
report('extended', JSON.stringify(extended));

// Every one of the algorithms starts with `? ToObject(this value)`, so a
// nullish receiver is a TypeError before any length is read.
const attempt = (label, run) => {
  try {
    report(label, 'no-throw ' + JSON.stringify(run()));
  } catch (error) {
    report(label, error.constructor.name + ': ' + error.message);
  }
};
attempt('null-join', () => Array.prototype.join.call(null));
attempt('undefined-push', () => Array.prototype.push.call(undefined, 1));
attempt('null-copyWithin', () => Array.prototype.copyWithin.call(null, 0, 0));
attempt('undefined-fill', () => Array.prototype.fill.call(undefined, 0));
attempt('null-toReversed', () => Array.prototype.toReversed.call(null));
attempt('undefined-with', () => Array.prototype.with.call(undefined, 0, 1));
attempt('null-splice', () => Array.prototype.splice.call(null, 0, 1));

// A proxy over `target` that logs its string-keyed reads and its has checks.
const traced = (target) => {
  const log = [];
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string') log.push('get:' + key);
      return Reflect.get(object, key, receiver);
    },
    has(object, key) {
      log.push('has:' + String(key));
      return key in object;
    },
  });
  return { proxy, log };
};
// concat appends a receiver that is not spreadable as one value, without
// reading its length.
const unread = traced({ length: 2, 0: 'a', 1: 'b' });
const joined = Array.prototype.concat.call(unread.proxy, [1]);
report('concat-length', joined.length);
report('concat-reads', unread.log.join(','));

// flatMap calls the callback with thisArg as `this`.
const tagged = { length: 2, 0: 'a', 1: 'b' };
report('flatMap-this', Array.prototype.flatMap.call(tagged, function (value) {
  return [value, this.tag];
}, { tag: 't' }).join(''));

// A string's ToObject wrapper has read-only indexes below its length and a
// read-only length, so the mutating methods throw on them.
attempt('string-push', () => Array.prototype.push.call('ab', 'c'));
attempt('string-pop', () => Array.prototype.pop.call('ab'));
attempt('string-pop-empty', () => Array.prototype.pop.call(''));
attempt('string-shift', () => Array.prototype.shift.call('ab'));
attempt('string-unshift', () => Array.prototype.unshift.call('ab', 'x'));
attempt('string-unshift-none', () => Array.prototype.unshift.call('ab'));
attempt('string-reverse', () => Array.prototype.reverse.call('ab'));
attempt('string-fill', () => Array.prototype.fill.call('ab', 'x'));
attempt('string-copyWithin', () => Array.prototype.copyWithin.call('abc', 0, 1));
attempt('string-splice', () => Array.prototype.splice.call('abc', 1, 1));
attempt('string-splice-insert', () => Array.prototype.splice.call('', 0, 0, 'x'));
attempt('string-splice-none', () => Array.prototype.splice.call('abc'));
// Other primitives' wrappers carry no indexes and a writable length.
attempt('number-push', () => Array.prototype.push.call(5, 'x'));
attempt('boolean-pop', () => Array.prototype.pop.call(true));

// toReversed reads with Get alone, from the last index down.
const backwards = traced({ length: 3, 0: 'a', 2: 'c' });
report('toReversed', JSON.stringify(Array.prototype.toReversed.call(backwards.proxy)));
report('toReversed-reads', backwards.log.join(','));

// with never reads the replaced index, and reads every other one with Get.
const replaced = traced({ length: 3, 0: 'a', 2: 'c' });
report('with', JSON.stringify(Array.prototype.with.call(replaced.proxy, 0, 'z')));
report('with-reads', replaced.log.join(','));

// toSorted reads every index with Get, holes included.
const sorted = traced({ length: 3, 0: 'b', 2: 'a' });
report('toSorted', JSON.stringify(Array.prototype.toSorted.call(sorted.proxy)));
report('toSorted-reads', sorted.log.join(','));

// toSpliced without arguments copies the receiver; a missing index becomes
// an own undefined, read with Get alone.
const copiedOut = traced({ length: 3, 0: 'a', 2: 'c' });
const copy = Array.prototype.toSpliced.call(copiedOut.proxy);
report('toSpliced-none', JSON.stringify(copy) + ' ' + ('1' in copy));
report('toSpliced-none-reads', copiedOut.log.join(','));
const skipped = traced({ length: 4, 0: 'a', 3: 'd' });
report('toSpliced-holes', JSON.stringify(Array.prototype.toSpliced.call(skipped.proxy, 1, 1, 'X')));
report('toSpliced-reads', skipped.log.join(','));

// An array receiver held as an untyped value runs the array methods.
const either = (useArray) => (useArray ? ['p', 'q'] : { length: 0 });
const list = either(resolved.length > 0);
report('array-push', Array.prototype.push.call(list, 'r'));
report('array-reverse', Array.prototype.join.call(Array.prototype.reverse.call(list), ''));
report('array-concat', Array.prototype.concat.call(list, ['s'], 't').join(''));
report('array-toSpliced', Array.prototype.toSpliced.call(list, 0, 1).join(''));
report('array-with', Array.prototype.with.call(list, 0, 'z').join(''));

// join reads every index with Get alone; a has trap never runs.
const joinedLog = traced({ length: 3, 0: 'a', 2: 'c' });
report('join', Array.prototype.join.call(joinedLog.proxy, '-'));
report('join-reads', joinedLog.log.join(','));
const hidden = new Proxy({ length: 2, 0: 'x', 1: 'y' }, { has() { throw new Error('has trap'); } });
report('join-has-trap', Array.prototype.join.call(hidden, ''));

// flat converts its depth before it reads any index.
const order = [];
const depthSource = { length: 2, get 0() { order.push('read 0'); return [1, [2]]; }, 1: 3 };
const depth = { valueOf() { order.push('depth'); return 2; } };
report('flat-depth', JSON.stringify(Array.prototype.flat.call(depthSource, depth)));
report('flat-order', order.join(','));
const failing = { length: 1, get 0() { order.push('never'); return 1; } };
try {
  Array.prototype.flat.call(failing, { valueOf() { throw new Error('depth failed'); } });
} catch (error) {
  report('flat-depth-throws', error.message + ' ' + order.includes('never'));
}

// flatMap flattens each callback's result before the next callback runs.
const shared = [1, 2];
const mapped = Array.prototype.flatMap.call({ length: 2, 0: 'a', 1: 'b' }, (value) => {
  if (value === 'a') return shared;
  shared[0] = 9;
  return [];
});
report('flatMap-order', JSON.stringify(mapped));
// flat also flattens a nested array when its index is read.
const nestedArray = [1, 2];
const nestedSource = { length: 2, 0: nestedArray, get 1() { nestedArray[0] = 9; return 3; } };
report('flat-nested-order', JSON.stringify(Array.prototype.flat.call(nestedSource)));
report('flat-negative', JSON.stringify(Array.prototype.flat.call({ length: 1, 0: [1, [2]] }, -1)));
report('flat-infinity', JSON.stringify(Array.prototype.flat.call({ length: 1, 0: [1, [2, [3]]] }, Infinity)));

console.log(resolved.join('\n'));
