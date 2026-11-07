// @requires-libnode
// structuredClone is the explicit, exact copy of an island object into a
// program record type: a fresh object, detached from the one the island
// keeps (SPEC 1b = B). Without it the conversion is SC8010.
import { ident, mutateKept, same } from "union-pkg";

interface Rec {
  n: number;
}
const copy = structuredClone(ident<Rec>({ n: 1 }));
console.log(same(copy));
mutateKept();
console.log(copy.n);

const own: Rec = { n: 5 };
const back = structuredClone(ident<Rec>(own));
console.log(back === own, same(own));
