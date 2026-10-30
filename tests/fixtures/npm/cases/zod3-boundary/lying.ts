// A declaration that lies about a value: the boundary check throws a
// TypeError naming the path (native only; Node does not check). Run by
// tests/harness/decl-boundary.test.ts.
import { z } from "zod";

const Liar = z.custom<{ name: string; n: number }>(() => true);
try {
  const v = Liar.parse({ name: "x", n: "not a number" });
  console.log("liar", v.n + 1);
} catch (e) {
  console.log("liar threw", e instanceof TypeError, (e as Error).message);
}
const Frozen = z.custom<{ tags: string[] }>();
try {
  const f = Frozen.parse(Object.freeze(JSON.parse('{"tags":["a"]}')));
  console.log("frozen", f.tags.length);
} catch (e) {
  console.log("frozen threw", (e as Error).message);
}
