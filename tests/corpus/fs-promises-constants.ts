// fs/promises re-exports the fs.constants object itself (Node's rule): the
// two spellings and fs.promises.constants are one object, its access-mode
// and copy bits are the libc's values, and its members are Node's set.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { constants as promisesConstants } from "node:fs/promises";

console.log("identity", fs.promises.constants === fs.constants, fsp.constants === fs.constants);
console.log(
  "values",
  fsp.constants.F_OK,
  fsp.constants.R_OK,
  fsp.constants.W_OK,
  fsp.constants.X_OK,
  fsp.constants.COPYFILE_EXCL,
  fsp.constants.O_RDWR,
  fsp.constants.S_IFMT,
);
console.log("keys", Object.keys(fsp.constants).sort().join(","));
console.log("read", fs.constants.F_OK, fsp.constants.F_OK);
// The named import binds the same object (Node exports it by name).
console.log(
  "named",
  promisesConstants === fs.constants,
  promisesConstants.O_RDWR > 0,
  promisesConstants.S_IFMT > 0,
);
