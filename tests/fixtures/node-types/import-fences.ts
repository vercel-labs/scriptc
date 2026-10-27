/* An unsupported IMPORT no longer stops analysis at preflight: the module
 * fence joins the blockers, the imported bindings poison at their use
 * sites (grouping with the import line), and every other statement still
 * counts — the report shows a percentage. Builds still fail on the import
 * exactly as before. (net, dgram, then v8 graduated to supported modules,
 * so the out-of-scope "inspector" carries this test now.) */
import { open } from "inspector";
import { join } from "node:path";

const cmd = join("/usr", "bin", "afplay");
console.log(cmd);
open();
console.log("after");
