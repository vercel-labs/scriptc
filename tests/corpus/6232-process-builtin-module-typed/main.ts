// process.getBuiltinModule and process.features under @types/node: a
// literal id types as the module namespace, so the result is the same
// object `import * as os` binds (pi's user-agent probe casts process and
// calls the member optionally), and process.features is an object a
// feature probe can test with `in` (pi's single-executable check).
import * as os from "node:os";
import type * as NodeOs from "node:os";

const direct = process.getBuiltinModule("node:os");
console.log("direct", direct.platform() === os.platform(), direct.EOL === os.EOL);
console.log("bare id", process.getBuiltinModule("os").arch() === os.arch());

type ProcessWithOsBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};
function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}
const nodeOs = loadNodeOs();
const agent = nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : "pi (browser)";
console.log("agent", agent === `pi (${os.platform()} ${os.release()}; ${os.arch()})`);
console.log("present", nodeOs !== null, nodeOs ? typeof nodeOs.homedir() : "none");

const isNodeSeaBinary = "sea" in process.features && process.features.sea === true;
console.log("sea", isNodeSeaBinary, "sea" in process.features);
