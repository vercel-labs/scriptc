// JSON.stringify of a value that may itself be a function answers
// undefined for the function and text otherwise: refused by name.
function pick(flag: boolean): string | (() => string) {
  return flag ? "text" : () => "lazy";
}
const rootUnion = JSON.stringify(pick(true));

// A narrowed copy keeps its source object's properties. When the source
// type has a member no JSON writer handles, the call names both types.
interface Wide {
  id: number;
  index: Map<string, number>;
}
interface Narrow {
  id: number;
}
function narrow(wide: Wide): Narrow {
  return wide;
}
const linked = JSON.stringify(narrow({ id: 1, index: new Map() }));

// Every source a narrowed copy can be linked to has to be serializable:
// one that holds a class instance the runtime JSON traversal cannot write
// is refused even when another source of the same type is fine.
class Pattern {
  source = /x/;
}
interface WithCallback {
  key: number;
  visit?: () => void;
}
interface WithPattern {
  key: number;
  pattern: Pattern;
}
interface Slim {
  key: number;
}
function fromCallback(wide: WithCallback): Slim {
  return wide;
}
function fromPattern(wide: WithPattern): Slim {
  return wide;
}
const mixed = JSON.stringify([fromCallback({ key: 1 }), fromPattern({ key: 2, pattern: new Pattern() })]);

// The same holds for a later member: the first member's copies can take
// the runtime traversal, the second member's cannot.
interface Trim {
  tag: number;
}
interface Lean {
  code: number;
}
interface LeanPattern {
  code: number;
  pattern: Pattern;
}
interface Pair {
  first: Trim;
  second: Lean;
}
function trim(wide: { tag: number; later?: () => void }): Trim {
  return wide;
}
function lean(wide: LeanPattern): Lean {
  return wide;
}
const pair: Pair = { first: trim({ tag: 1 }), second: lean({ code: 2, pattern: new Pattern() }) };
const later = JSON.stringify(pair);
