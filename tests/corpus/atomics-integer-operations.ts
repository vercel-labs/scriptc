function exercise<T extends Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array>(values: T): void {
  console.log(Atomics.store(values, 0, 257.9), Atomics.load(values, 0));
  console.log(Atomics.exchange(values, 0, -3), Atomics.load(values, 0));
  console.log(Atomics.compareExchange(values, 0, -3, 65535), Atomics.load(values, 0));
  console.log(Atomics.compareExchange(values, 0, 7, 99), Atomics.load(values, 0));
  console.log(Atomics.add(values, 0, 2), Atomics.sub(values, 0, 3), Atomics.load(values, 0));
  console.log(Atomics.and(values, 0, 15), Atomics.or(values, 0, 16), Atomics.xor(values, 0, 3), Atomics.load(values, 0));
  console.log(Atomics.store(values, NaN, NaN), Atomics.store(values, -0.5, Infinity), Atomics.load(values, 0));
  console.log(Atomics.store(values, 0.9, -0), Object.is(Atomics.load(values, 0), -0));
  for (const index of [-1, 1, Infinity]) {
    try { Atomics.load(values, index); }
    catch (error) { console.log(error instanceof RangeError); }
  }
}

exercise(new Int8Array(new SharedArrayBuffer(1)));
exercise(new Uint8Array(new SharedArrayBuffer(1)));
exercise(new Int16Array(new SharedArrayBuffer(2)));
exercise(new Uint16Array(new SharedArrayBuffer(2)));
exercise(new Int32Array(new SharedArrayBuffer(4)));
exercise(new Uint32Array(new SharedArrayBuffer(4)));
const local = new Int32Array(1);
console.log("local", Atomics.add(local, 0, 2), local[0], Atomics.notify(local, 0));
try { Atomics.wait(local, 0, 2, 0); }
catch (error) { console.log("local wait", error instanceof TypeError); }
const shared = new Int32Array(new SharedArrayBuffer(4));
console.log("wait", Atomics.wait(shared, 0, 1, undefined), Atomics.wait(shared, 0, 0, -1));
console.log("notify", Atomics.notify(shared, 0, undefined), Atomics.notify(shared, 0, NaN));
