// Three declarations of the island package that do not hold: a session
// opened without a ttl has none, a quota has no `max`, and the sizes are
// strings. Node prints the values; compiled code throws at each
// conversion, and the error names the declaration and the type patch that
// would admit the value. `limits.Quota.max` is declared inside a
// namespace, which the patch selector has to name, an element read is the
// element of what `sizes()` declares, `sizes()[]`, and a member read with
// brackets is the member's.
import { open, quota, sizes } from "tc-island";

function show(label: string, read: () => number): void {
  try {
    console.log(label, read());
  } catch (e) {
    console.log(label, String((e as Error).message));
  }
}

show("ttl", () => open("x").ttl);
show("max", () => quota().max);
show("size", () => sizes()[0]!);
show("ttl by key", () => open("x")["ttl"]);
