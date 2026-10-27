// Each evaluation of a function-local class creates its own private names.
// A method taken from one evaluation and called with an instance of another
// (through call, a prototype read, or a checked receiver) finds no brand:
// field reads and writes throw Node's TypeErrors and `#x in this` answers
// false. Calls within one evaluation share the instance's fields.
'use strict';

function make(label) {
  class Counter {
    #count = 0;
    #label = label;
    #format = (n) => `${label}#${n}`;

    bump() {
      this.#count = this.#count + 1;
      return `${this.#label}:${this.#count}`;
    }

    add(n) {
      this.#count += n;
      return this.#count;
    }

    increment() {
      this.#count++;
      return this.#count;
    }

    reset() {
      [this.#count] = [0];
      return this.#count;
    }

    assign() {
      return (this.#count = 7);
    }

    order(note) {
      this.#count = note();
      return this.#count;
    }

    has() {
      return #count in this;
    }

    later() {
      return () => this.#label;
    }

    describe() {
      return this.#format(this.#count);
    }

    get count() {
      return this.#count;
    }

    set count(value) {
      this.#count = value;
    }
  }

  class Tagged extends Counter {
    tag() {
      return `tagged ${this.bump()}`;
    }
  }

  return { counter: () => new Counter(), tagged: () => new Tagged() };
}

function attempt(label, fn) {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, e instanceof TypeError, e.message);
  }
}

const one = make('one');
const two = make('two');
const a = one.counter();
const b = two.counter();
const a2 = one.counter();

console.log(a.bump(), a.bump(), b.bump(), a2.bump());
console.log(a.add(5), a.increment(), a.has(), a.later()());

// Borrowed within one evaluation: the fields are the instance's own.
const bump = a.bump;
console.log(bump.call(a2), a2.bump(), bump.call(a));
console.log(Object.getPrototypeOf(a).bump.call(a2));

// Borrowed across evaluations.
attempt('call read', () => a.bump.call(b));
attempt('compound', () => a.add.call(b, 1));
attempt('update', () => a.increment.call(b));
attempt('destructure', () => a.reset.call(b));
attempt('assign value', () => a.assign.call(b));
attempt('value first', () =>
  a.order.call(b, () => {
    console.log('value evaluated');
    return 1;
  }),
);
attempt('proto read', () => Object.getPrototypeOf(a).bump.call(b));
attempt('has other', () => a.has.call(b));
attempt('has own', () => a.has.call(a2));
attempt('arrow', () => a.later.call(b)());
attempt('field call', () => a.describe.call(b));
attempt('field call own', () => a.describe.call(a2));
attempt('apply', () => a.bump.apply(b));
attempt('bind', () => a.bump.bind(b)());
attempt('Reflect.apply', () => Reflect.apply(a.bump, b, []));
const proto = Object.getPrototypeOf(a);
const bumpDescriptor = /** @type {any} */ (Object.getOwnPropertyDescriptor(proto, 'bump'));
const countDescriptor = /** @type {any} */ (Object.getOwnPropertyDescriptor(proto, 'count'));
attempt('descriptor value', () => bumpDescriptor.value.call(b));
attempt('getter', () => countDescriptor.get.call(b));
attempt('setter', () => countDescriptor.set.call(b, 5));
attempt('Reflect.get', () => Reflect.get(a, 'count', b));
attempt('Reflect.set', () => Reflect.set(a, 'count', 3, b));
attempt('own getter', () => [countDescriptor.get.call(a2), Reflect.get(a, 'count', a2)].join(' '));
console.log(b.bump(), b.count, (b.count = 10), b.bump());

// Receivers that are not instances.
for (const recv of [{}, [], undefined, null, 1, 'x']) {
  attempt(`read ${String(recv)}`, () => a.bump.call(recv));
  attempt(`write ${String(recv)}`, () => a.reset.call(recv));
  attempt(`has ${String(recv)}`, () => a.has.call(recv));
}

// A subclass declared after the class in the same function carries the
// brand of its own evaluation.
const t1 = one.tagged();
const t2 = two.tagged();
console.log(t1.tag(), t2.tag(), t1.has(), a.has.call(t1), a.has.call(t2));
attempt('subclass across', () => a.bump.call(t2));
attempt('subclass own', () => b.bump.call(t2));

// undici's iterator guard: the error comes from the method itself.
function createIterator(name) {
  class FastIterableIterator {
    #target;
    #index = 0;

    constructor(target) {
      this.#target = target;
    }

    next() {
      if (typeof this !== 'object' || this === null || !(#target in this)) {
        throw new TypeError(`'next' called on an object that does not implement interface ${name} Iterator.`);
      }
      const index = this.#index;
      if (index >= this.#target.length) return { value: undefined, done: true };
      this.#index = index + 1;
      return { value: this.#target[index], done: false };
    }
  }
  return (target) => new FastIterableIterator(target);
}

const headers = createIterator('Headers');
const params = createIterator('Params');
const it = headers(['a', 'b']);
const next = it.next;
console.log(JSON.stringify(next.call(it)), JSON.stringify(it.next()), JSON.stringify(next.call(it)));
for (const recv of [headers(['c']), params(['d']), {}, null]) {
  attempt('next', () => JSON.stringify(next.call(recv)));
}
