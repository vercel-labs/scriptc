// A class declared inside a function with private fields used only on
// `this` (undici's webidl createIterator): each evaluation's instances meet
// only their own methods, so one compiled layout serves every evaluation.
'use strict';

function createIterator(name, entries) {
  class FastIterableIterator {
    #target;
    #kind;
    #index;

    constructor(target, kind) {
      this.#target = target;
      this.#kind = kind;
      this.#index = 0;
    }

    next() {
      if (typeof this !== 'object' || this === null || !(#target in this)) {
        throw new TypeError(`'next' called on an object that does not implement interface ${name} Iterator.`);
      }
      const values = entries(this.#target);
      if (this.#index >= values.length) return { value: undefined, done: true };
      const pair = values[this.#index];
      this.#index = this.#index + 1;
      if (this.#kind === 'key') return { value: pair[0], done: false };
      if (this.#kind === 'value') return { value: pair[1], done: false };
      return { value: pair[0] + '=' + pair[1], done: false };
    }
  }
  return function (target, kind) {
    return new FastIterableIterator(target, kind);
  };
}

const headers = createIterator('Headers', (t) => t.pairs);
const params = createIterator('Params', (t) => t.list);

function drain(it) {
  const out = [];
  for (let step = it.next(); !step.done; step = it.next()) out.push(step.value);
  return out.join(',');
}

const target = { pairs: [['a', '1'], ['b', '2']] };
console.log(drain(headers(target, 'key')));
console.log(drain(headers(target, 'value')));
console.log(drain(params({ list: [['x', 'y']] }, 'key+value')));
