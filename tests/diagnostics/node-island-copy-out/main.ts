// An island object converted into a program record type is SC8010: the
// conversion is a deep copy, so identity and every later write the island
// makes are lost (K1). The copy is stated with structuredClone (SPEC 1b = B).
import { ident, same } from "copy-pkg";

interface Rec {
  n: number;
}
const r = ident<Rec>({ n: 1 });
console.log(same(r));
console.log(r.n);
