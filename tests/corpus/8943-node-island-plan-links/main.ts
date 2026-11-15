// @requires-libnode
// Island packages in a linked layout (each package's directory is a
// symbolic link into a store, as pnpm lays them out): a relative require
// that passes through a link names the file by its real path, and modules
// reached by two routes are one module.
import { report } from "linkpkg";

console.log(report());
