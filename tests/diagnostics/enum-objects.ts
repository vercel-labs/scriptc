// The enum OBJECT as a value is built for an enum whose every member is a
// compile-time constant (the enum-object corpus programs). Each enum here has no
// such object, and using it as a value is refused by name.

// A computed member: its value and its reverse entry exist only once the
// declaration has run. (The declaration and the member fence too.)
enum Computed {
  Ok = 1,
  Len = "abc".length,
}
console.log(Object.keys(Computed));
function take(table: typeof Computed): number {
  return table.Ok;
}
console.log(take(Computed));

// A namespace merged into the enum adds its exports to the same object.
enum WithHelpers {
  A,
  B,
}
namespace WithHelpers {
  export function parse(text: string): WithHelpers {
    return text === "a" ? WithHelpers.A : WithHelpers.B;
  }
}
console.log(Object.keys(WithHelpers), WithHelpers.parse("a"));

// `E["__proto__"] = 1` creates no own property, so the object lacks the
// member's name and keeps only its reverse entry.
enum Proto {
  __proto__ = 1,
  Other,
}
console.log(Object.values(Proto));

// An enum declared inside a function creates its object on every call.
function local(): string[] {
  enum Local {
    P,
    Q,
  }
  return Object.keys(Local);
}
console.log(local());

// Between the declarations of a merged enum the object holds only the
// members declared so far.
enum Twice {
  A = 1,
}
console.log(Object.keys(Twice));
enum Twice {
  B = 2,
}
console.log(Object.keys(Twice));

// A `declare enum` emits no object.
declare enum Ambient {
  A = 1,
}
console.log(Object.keys(Ambient));
