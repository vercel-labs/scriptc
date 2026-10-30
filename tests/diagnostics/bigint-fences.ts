// BigInt itself is static; these adjacent representation boundaries remain
// explicit refusals until their own coherent families land.
const typed = new BigInt64Array(4);
const dynamicValue: unknown = 1n;
// BigInt keys now compile beside the remaining representation fences.
const keyed = new Map<bigint, string>();
keyed.set(1n, "one");
console.log(JSON.stringify(1n));

import { statSync } from "node:fs";
const stats = statSync(".", { bigint: true });
// A BigIntStats member is a call, not a value: reading one as a value still
// has no lowering.
const read = stats.isFile;
console.log(stats.size);

void typed;
void dynamicValue;
