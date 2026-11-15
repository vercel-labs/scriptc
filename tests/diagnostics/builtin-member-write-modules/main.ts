// The write and the native use may be in different modules: the refusal is
// reported at the write, in patch.ts, and names the use in use.ts.
import "./patch.ts";
import { total } from "./use.ts";

console.log(total([3, 4]));
