// requireModule() of Node's built-in modules, named with and without the
// node: prefix.
import { requireModule } from "@scriptc/node";

const path = requireModule("path");
const os = requireModule("node:os");
console.log(path.join("a", "b"), typeof os.platform());
