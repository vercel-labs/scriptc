// A recursive JSON value type as an argument and a result of a Node island
// call (tests/harness/node-island.test.ts).
import { callSync } from "@scriptc/node";

type Json = number | string | boolean | null | Json[] | { [key: string]: Json };

const input: Json = { list: [1, "two", [true, null]] };
const output = callSync<Json>("./helper.cjs", "echo", input);
console.log(JSON.stringify(output));
