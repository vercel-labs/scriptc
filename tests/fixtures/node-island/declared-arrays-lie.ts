// `lie()` declares `string[]` and hands back numbers: the crossing copies
// the island's array and the checked conversion throws on an element that
// contradicts the declaration, so no number ever reaches a native string[].
import { lie } from "array-pkg";

function first(values: string[]): string {
  return values[0] ?? "";
}

console.log("before");
console.log(first(lie()));
