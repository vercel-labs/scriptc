// The functions a narrower slot can hold, and what the wider call that
// follows must still give them: literals and object methods with an
// optional parameter, async functions, a callback position, a rest
// parameter (every argument), and defaults (applied only where the final
// call passes undefined).
type One = (prefix: string) => string;
type Two = (prefix: string, options: { upper: boolean }) => string;
function widen(f: One): Two {
  return f;
}
const up = { upper: true };

// A literal with an optional parameter, written into the narrow slot.
const arrow: One = (prefix: string, options?: { upper: boolean }) =>
  options?.upper ? prefix.toUpperCase() : prefix;
const wideArrow: Two = arrow;
console.log("literal", wideArrow("abc", up), arrow("abc"));
console.log(
  "literal",
  widen((prefix: string, options?: { upper: boolean }) => (options?.upper ? prefix.toUpperCase() : prefix))("abc", up),
  widen(function (prefix: string, options?: { upper: boolean }) {
    return options?.upper ? prefix.toUpperCase() : prefix;
  })("abc", up),
);

// An object-literal method and a static method read as values.
const obj = {
  make(prefix: string, options?: { upper: boolean }): string {
    return options?.upper ? prefix.toUpperCase() : prefix;
  },
};
class Maker {
  static build(prefix: string, options?: { upper: boolean }): string {
    return options?.upper ? prefix.toUpperCase() + "#" : prefix + "#";
  }
}
const fromObj: One = obj.make;
const fromStatic: One = Maker.build;
console.log("method", widen(fromObj)("abc", up), widen(fromStatic)("abc", up), fromStatic("abc"));

// An async function.
async function labelLater(prefix: string, options?: { upper: boolean }): Promise<string> {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
function narrowAsync(f: (prefix: string) => Promise<string>): (prefix: string) => Promise<string> {
  return f;
}
const wideAsync: (prefix: string, options: { upper: boolean }) => Promise<string> = narrowAsync(labelLater);
console.log("async", await wideAsync("abc", up), await narrowAsync(labelLater)("abc"));

// A callback position: the callee calls its callback with more than the
// type it was handed over as declares.
function label(prefix: string, options?: { upper: boolean }): string {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
const registry: ((cb: One) => string)[] = [];
registry.push((cb) => (cb as Two)("abc", up));
registry.push((cb) => widen(cb)("xyz", up));
console.log("callback", registry[0]!(label), registry[1]!(label), registry[0]!((p) => p + "."));

// A rest parameter sees every argument of the final call.
function count(...xs: number[]): number {
  return xs.length;
}
function head(a: number, ...rest: number[]): string {
  return a + "+" + rest.join(",");
}
function n1<R>(f: (a: number) => R): (a: number) => R {
  return f;
}
function w3<R>(f: (a: number) => R): (a: number, b: number, c: number) => R {
  return f;
}
console.log("rest", n1(count)(1), w3(n1(count))(1, 2, 3), w3(count)(1, 2, 3), count(1, 2));
console.log("rest", n1(head)(1), w3(n1(head))(1, 2, 3), w3(head)(1, 2, 3));

// Defaults apply by what the final call passes: a value is used, an
// undefined argument or a missing one takes the default.
function tag(a: string, b: string = "dflt", c: string = b + "2"): string {
  return `${a}/${b}/${c}`;
}
function t1(f: (a: string) => string): (a: string) => string {
  return f;
}
function t3(f: (a: string) => string): (a: string, b: string | undefined, c: string | undefined) => string {
  return f;
}
const tagged = t3(t1(tag));
console.log("defaults", t1(tag)("x"), tagged("x", "y", "z"), tagged("x", undefined, "z"), tagged("x", "y", undefined));
console.log("defaults", tagged("x", undefined, undefined), tag("x"));
