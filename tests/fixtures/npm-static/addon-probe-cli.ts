import { probe, resolveHelper } from "addon-probe";
import { join } from "node:path";

console.log(join("a", "b"), [probe("clipboard"), probe("keys"), resolveHelper("addon-probe-helper")].join(","));
console.log(resolveHelper("other", (id) => `custom:${id}`));
