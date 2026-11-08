// @requires-libnode
// Byte views crossing a Node island boundary and being dropped, twenty
// thousand of each kind, while both collectors run: every round trip
// answers the same object, nothing a side still holds is freed under it,
// and what both sides dropped is released.
import { keep, fresh, sum, gc, put, sameAs, kept } from "churn-pkg";

function t(label: string, f: () => unknown): void {
  try {
    console.log(label + ":", f());
  } catch (e) {
    console.log(label + ": threw", String(e));
  }
}

function part1(): void {
  // Cross and drop many views while both collectors run.
  let total = 0;
  const held: Uint8Array[] = [];
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < 500; i++) {
      const v = new Uint8Array(64 + (i & 63));
      v[0] = i & 255;
      total += sum(v);                       // program view, dropped at once
      const sub = v.subarray(1, 9);
      total += sum(sub);                     // a view of it
      const back = keep(v);                  // round trip, the island keeps the last
      if (back !== v) throw new Error("identity lost at " + round + "/" + i);
      const isl = fresh(32 + (i & 31));      // island view, dropped at once
      total += isl[0] + isl.length;
      if (i % 97 === 0) held.push(isl, sub);
      if (i % 131 === 0) { put("p", v); if (!sameAs("p", v)) throw new Error("second crossing differs"); }
    }
    gc();
    if (held.length > 40) held.splice(0, 20);
  }
  const last = kept<Uint8Array>();
  console.log("total", total, "held", held.length, "kept", last.length, gc());
  let check = 0;
  for (const h of held) check += h.length + h[0];
  console.log("check", check);
}
part1();
