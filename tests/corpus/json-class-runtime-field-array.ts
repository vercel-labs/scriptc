// An eligible class whose field is written by the runtime walk: the field's
// record holds an unknown index signature, and a getter installed there
// empties the array of instances while JSON.stringify walks it. The class is
// not callback-free, so the array is held and each index is read again after
// the getter runs: the answer matches Node instead of reading freed slots.
interface Payload {
  id: number;
  [key: string]: unknown;
}

class Outer {
  p: Payload;
  constructor(p: Payload) {
    this.p = p;
  }
}

// A stringified instance at the root admits the class to the layout writer;
// the array below then serializes through the same class writer.
console.log(JSON.stringify(new Outer({ id: 0 })));

const items: Outer[] = [];
const trapped: Payload = { id: 1 };
trapped["trap"] = {
  get value() {
    items.length = 0;
    return 7;
  },
};
items.push(new Outer(trapped), new Outer({ id: 2 }), new Outer({ id: 3 }));
console.log(JSON.stringify(items));

// The same walk with the array reached as a member of a record.
const second: Outer[] = [];
const trappedSecond: Payload = { id: 4 };
trappedSecond["trap"] = {
  get value() {
    second.length = 0;
    return 8;
  },
};
second.push(new Outer(trappedSecond), new Outer({ id: 5 }));
console.log(JSON.stringify({ list: second }));
