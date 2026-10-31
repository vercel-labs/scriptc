// A function holds ONE implementation, and a declared type only constrains
// call sites. An overloaded member's implementation may declare more
// parameters than any single overload spells; every overload's arguments
// still reach it — and so do the arguments of a later WIDENED call, because
// the value read out of the member keeps the implementation's full arity
// (JavaScript has no arity check; a missing argument is just undefined).

class Writer {
  write(text: string): number;
  write(text: string, times: number): number;
  write(text: string, times?: number): number {
    return text.length * (times === undefined ? 1 : times);
  }
}

const writer = new Writer();
console.log(writer.write("abc"));
console.log(writer.write("abcd", 3));

// The member read as a value carries the same one implementation, so the
// two-argument call reaches its second parameter.
const writeValue = writer.write;
console.log(writeValue("abc"));
console.log(writeValue("abcd", 3));

// A value that entered through an untyped slot keeps the arity it was
// created with; widening it back delivers every argument.
const loose: any = (text: string, times: number) => text.length * times;
const widened = loose as (text: string, times: number) => number;
console.log(widened("abcd", 3));
console.log(widened("xy", 10));
