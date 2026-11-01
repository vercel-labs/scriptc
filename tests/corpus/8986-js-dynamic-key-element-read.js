// A JavaScript element read whose index the checker does not type as a number
// (`arr[true]`, `arr[undefined]`, `list[keyObject]`) is a dynamic property
// read: Node stringifies the key and reads the property of the receiver,
// which is undefined for an absent key. The key must ride the checked-dynamic
// tree there — lowering it as the boolean (or object) the checker typed made
// the class member dispatch helper reject it ("arg 1: expected string, got
// bool") instead of compiling.
//
// Every receiver kind that dispatches through the dynamic key path is
// covered: an array, a record, a class instance (the field and getter reads
// dispatch through the class member table), a typed array, and the optional
// chain form.

const arr = [39, 42];

const rec = {
  true: 44,
  false: 45,
  undefined: 40,
  null: 42,
  NaN: 41,
  x: 43,
};

console.log(arr[true], arr[false], arr[undefined], arr[null]);
console.log(arr[1], arr[0]);
console.log(rec[true], rec[false], rec[undefined], rec[null], rec[NaN]);
console.log(arr?.[true], rec?.[true], arr?.[0, 1], rec?.[true, 'x']);

class Holder {
  x = 7;
  get y() {
    return 8;
  }
  peek() {
    return this[true];
  }
}

const holder = new Holder();
console.log(holder[true], holder[false], holder['x'], holder['y']);
console.log(holder.x, holder.y, holder?.[true], holder.peek());

const bytes = new Uint8Array([5, 6]);
console.log(bytes[true], bytes[1], bytes?.['length']);

const keyObject = {
  toString() {
    return '1';
  },
};
const list = [10, 20, 30];
console.log(list[keyObject], list[undefined], list[null]);
console.log(String(arr[true]), typeof rec[false]);
