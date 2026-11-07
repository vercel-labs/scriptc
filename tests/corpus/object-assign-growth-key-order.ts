// Object.assign is one write per source key, in the source's own key order,
// whether the target declares the key or gains it. A frozen target therefore
// throws for the source's FIRST key: the read-only TypeError when the target
// declares that key, the not-extensible one when it does not.
interface Box {
  a: number;
  m: number;
}
function grow(target: Box, src: { z: number; m: number; b: number; a: number }): void {
  Object.assign(target, src);
}
function growDeclaredFirst(target: Box, src: { a: number; z: number; m: number }): void {
  Object.assign(target, src);
}
function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, (e as Error).name + ": " + (e as Error).message);
  }
}

const kept: Box = JSON.parse('{"a":1,"m":2}') as Box;
const alias = kept;
grow(kept, { z: 9, m: 8, b: 7, a: 6 });
console.log(JSON.stringify(alias), Object.keys(alias).join(","), alias === kept);

// The source's first key is one the target gains.
const frozenAdded: Box = Object.freeze(JSON.parse('{"a":1,"m":2}') as Box);
attempt("added first", () => grow(frozenAdded, { z: 9, m: 8, b: 7, a: 6 }));
console.log(JSON.stringify(frozenAdded));

// The source's first key is one the target declares.
const frozenDeclared: Box = Object.freeze(JSON.parse('{"a":1,"m":2}') as Box);
attempt("declared first", () => growDeclaredFirst(frozenDeclared, { a: 5, z: 9, m: 8 }));
console.log(JSON.stringify(frozenDeclared));
