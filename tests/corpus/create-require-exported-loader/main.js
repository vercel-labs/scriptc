// An exported createRequire loader is link-time plumbing: importing modules
// resolve the same binding, so their calls anchor at the declaring chunk's
// file, and the loader's value form is a require function.
import { __require, loaderType, readKey } from "./chunk.js";

console.log("type:", loaderType(), typeof __require);
console.log("json:", __require("./data.json").key);
console.log("fn:", readKey());

// Stored in an object: the value round-trips as the same function.
const holder = { load: __require };
console.log("stored:", typeof holder.load);
