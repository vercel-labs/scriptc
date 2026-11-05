// Declared-arity narrowing: a function value stored under a type that names
// FEWER parameters than the value's own signature. Node's function object
// still carries every parameter, so a later widened call would pass all of
// its arguments (the surplus must not be dropped); a compiled function value
// is one concrete native ABI, so the narrowing store is refused at every
// observable use instead.
const impl = (text: string, times: number) => text.length * times;

// (1) Narrowing at a binding, then calling through the narrow type.
const narrowed = impl as unknown as (text: string) => number;
console.log(narrowed("abc"));

// (2) The same narrowing in an object literal's member slot, with the member
// read back and widened to the implementation's arity.
interface Sink {
  write(text: string): number;
}

function makeWriter(): Sink {
  return { write: impl as unknown as (text: string) => number };
}

const sink = makeWriter();
const widened = sink.write as (text: string, times: number) => number;
console.log(widened("abcd", 3));
