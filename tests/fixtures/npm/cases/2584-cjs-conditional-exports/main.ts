// An environment-dependent export object (readable-stream 2.x's
// READABLE_STREAM=disable switch): module.exports is replaced inside an
// if/else, so the module's exports depend on which branch ran. scriptc
// names the construct; Node picks the branch at load.
import rs from "gtcondexports";

console.log(rs.Readable.name);
