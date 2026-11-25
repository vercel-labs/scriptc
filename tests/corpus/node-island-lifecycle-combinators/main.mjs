// @requires-libnode
// Native Promise.allSettled and Promise.any over island promises.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const settled = await Promise.allSettled([lib.ok(2, "a"), lib.fail(1, "b")]);
console.log(settled.map((s) => `${s.status}:${s.status === "fulfilled" ? s.value : s.reason.message}`).join(" "));
console.log(await Promise.any([lib.fail(1, "c"), lib.ok(3, "d")]));
try {
  await Promise.any([lib.fail(1, "e"), lib.fail(2, "f")]);
} catch (e) {
  console.log(e.name, e.errors.map((x) => x.message).join(","));
}
