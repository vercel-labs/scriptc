// @exit: 1
// A builtin module's named imports are the enumerable own keys of its
// exports object. node:zlib owns the deprecated Z_* constants without
// enumerating them, so this import fails to link, and nothing runs: no
// module body, not even the modules the entry imports.
import "./side.mjs";
import { constants, Z_NO_FLUSH } from "node:zlib";

console.log("never runs", constants.Z_NO_FLUSH, Z_NO_FLUSH);
