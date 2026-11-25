// A program record type that receives island values is a live view, read
// member by member. A member declared as an array, tuple, Map, Set or
// library object can never hold what the island put there (an island array
// is not a native array), so the crossing is SC8010 and names the member,
// however deep the record that declares it is nested. The view's other
// members (records, primitives, functions, bytes, promises) are fine.
import { make } from "view-pkg";

interface Inner {
  n: number;
}
interface Listed {
  inner: Inner;
  list: Inner[];
}
interface Counted {
  counts: number[];
}
interface Paired {
  pair: [number, string];
}
interface Tabled {
  table?: Map<string, number>;
}
interface Dated {
  deep: { stamp: { when: Date } };
}
interface Queued {
  jobs: Promise<Inner[]>;
}
interface Fine {
  inner: Inner;
  n: number;
  run: () => void;
}

const listed = make<Listed>();
const counted = make<Counted>();
const paired = make<Paired>();
const tabled = make<Tabled>();
const dated = make<Dated>();
const queued = make<Queued>();
const fine = make<Fine>();
console.log(listed.inner.n, counted, paired, tabled, dated, queued, fine.n);
