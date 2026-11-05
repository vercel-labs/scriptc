// atob and btoa from node:buffer are the global functions, and both run
// WebIDL ToString on their argument: units render ("null"), an object
// converts through Symbol.toPrimitive, toString or valueOf, and a symbol
// throws the TypeError. Malformed input throws the DOMException
// InvalidCharacterError, and a missing argument Node's TypeError.
import * as buffer from "node:buffer";
import { atob as importedAtob, btoa as importedBtoa } from "node:buffer";

function show(label, fn) {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e.name, e.code);
  }
}

console.log(globalThis.atob === buffer.atob, globalThis.btoa === buffer.btoa);
show("module atob", () => buffer.atob("aGk="));
show("module btoa", () => buffer.btoa("hi"));
show("imported", () => importedAtob(importedBtoa("abc")));
show("no argument", () => buffer.atob());
show("no argument btoa", () => buffer.btoa());
show("whitespace", () => atob("  Y\fW\tJ\njZ A=\r= "));
show("null", () => atob(null));
show("NaN", () => atob(NaN));
show("true", () => atob(true));
show("1234", () => atob(1234));
show("empty array", () => atob([]));
show("toString", () => atob({ toString: () => "aGk=" }));
show("valueOf", () => atob({ toString: undefined, valueOf: () => "aGk=" }));
show("toPrimitive", () => atob({ [Symbol.toPrimitive]: () => "aGk=" }));
show("symbol", () => atob(Symbol()));
show("btoa symbol", () => btoa(Symbol()));
show("btoa object", () => btoa({ toString: () => "hi" }));
for (const value of [undefined, false, {}, [1], 0, 1n, -Infinity, "a", "a\n\n\n", "\ta\r \n\f"]) {
  show(`invalid ${typeof value}`, () => atob(value));
}
show("btoa outside latin1", () => btoa("Ā"));
