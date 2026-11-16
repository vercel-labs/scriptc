// A class value's static fields read the same through reflection and through
// the class's own code, whichever side wrote them last.
class Counter {
  static count = 1;
  static label = "a";
  static bump(): void {
    Counter.count++;
  }
}
class Shadow extends Counter {
  static override count = 7;
}

function read(C: any, key: string): unknown {
  return C[key];
}
function readCount(C: any): unknown {
  return C.count;
}
function write(C: any, key: string, value: unknown): void {
  C[key] = value;
}

// Native writes show through every reflective read.
Counter.count = 5;
Counter.bump();
Counter.label = "b";
console.log(
  read(Counter, "count"),
  readCount(Counter),
  Reflect.get(Counter, "count"),
  Object.getOwnPropertyDescriptor(Counter, "count")?.value,
  read(Counter, "label"),
);

// A computed-key write reaches the class's own reads.
write(Counter, "count", 40);
console.log(Counter.count, readCount(Counter), read(Counter, "count"));
console.log(Reflect.set(Counter, "count", 41), Counter.count, read(Counter, "count"));

// A slot typed with the base class holds the subclass: reads and writes
// follow the class it holds, not the type it was stored as.
const held: typeof Counter = Shadow;
console.log(readCount(held), readCount(Counter), readCount(Shadow));
write(held, "count", 70);
console.log(Counter.count, Shadow.count, readCount(held), read(Shadow, "count"));
console.log(Object.getOwnPropertyDescriptor(Shadow, "count")?.value);

// With a table installed, Object.assign still skips null and undefined
// sources, onto an ordinary object and onto a class value alike.
const none: any = null;
const absent: any = undefined;
const copy: any = Object.assign({}, none, { a: 1 }, absent);
const counterValue: any = Counter;
Object.assign(counterValue, none, { extra: 2 }, absent);
console.log(JSON.stringify(copy), counterValue.extra, Counter.count);
