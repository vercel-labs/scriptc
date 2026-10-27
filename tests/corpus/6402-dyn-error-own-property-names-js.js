// In JavaScript sources, the own property names of errors match
// Node's: Object.getOwnPropertyNames, Reflect.ownKeys and
// Object.getOwnPropertyDescriptors list `stack`, `message` and the
// properties the error has, in order, and nothing else.

class PlainSubclass extends Error {}

function dyn(value) {
  return value;
}

function names(label, error) {
  console.log(
    label,
    "|",
    Object.getOwnPropertyNames(error).join(","),
    "|",
    Reflect.ownKeys(error).map(String).join(","),
    "|",
    Object.keys(Object.getOwnPropertyDescriptors(error)).join(","),
  );
}

names("error", dyn(new Error("plain")));
names("type error", dyn(new TypeError("bad thing")));
names("no message", dyn(new RangeError()));
names("cause", dyn(new Error("outer", { cause: new Error("inner") })));
names("subclass", dyn(new PlainSubclass("sub")));

const unknownError = new SyntaxError("unexpected");
names("unknown", unknownError);

const coded = dyn(new Error("with code"));
coded.code = "E_CODE";
coded.detail = 1;
names("own properties", coded);

try {
  throw new URIError("thrown");
} catch (error) {
  names("caught", error);
}

console.log("marker", Object.getOwnPropertyNames(dyn(new Error("x"))).some((name) => name.startsWith("%")));
