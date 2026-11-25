// @requires-libnode
// The first island module the program loads throws while evaluating: the
// load throws the module's own error natively, a retry evaluates it again,
// and Node stays usable for the next module. A module with a syntax error
// and a missing module fail by name.
import { requireModule } from "@scriptc/node";

const log = (s) => console.log(s);

log("start");
for (let i = 0; i < 2; i++) {
  try {
    requireModule("./bad.cjs");
    log("NOT REACHED");
  } catch (e) {
    log(`caught ${e.name}: ${e.message} ${e instanceof TypeError}`);
  }
}
const good = requireModule("./good.cjs");
log(`runs ${good.runs()}`);
try {
  requireModule("./syntax.cjs");
} catch (e) {
  log(`caught ${e.name} ${e instanceof SyntaxError}`);
}
log("end");
