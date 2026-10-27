// fs.constants as a value and every member: the target platform's flags,
// file-type bits and permission bits, in Node's order, on a null-prototype
// object whose members are read-only. The access-mode bits keep their
// baked literals.
import * as fs from "node:fs";
import { constants } from "node:fs";

// libuv's Windows-only open flags (0 elsewhere) joined the object in later
// Node 24 releases; the rest is the same in every one.
const windowsOnly = ["UV_FS_O_TEMPORARY", "UV_FS_O_SHORT_LIVED", "UV_FS_O_SEQUENTIAL", "UV_FS_O_RANDOM"];
console.log(JSON.stringify(Object.entries(fs.constants).filter(([k]) => !windowsOnly.includes(k))));
console.log(fs.constants.O_RDONLY, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, constants.S_IFMT, constants.S_IFDIR);
console.log(constants.W_OK, fs.constants.F_OK, constants.COPYFILE_EXCL, fs.constants.UV_FS_O_FILEMAP);
const c: unknown = fs.constants;
console.log(typeof c, c === (fs.constants as unknown), Object.getPrototypeOf(c as object) === null, Object.keys(fs.constants).length > 40);
const mode = fs.statSync(".").mode;
console.log((mode & constants.S_IFMT) === constants.S_IFDIR, (mode & fs.constants.S_IRUSR) !== 0);
const descriptor = Object.getOwnPropertyDescriptor(c as object, "O_RDONLY");
console.log(JSON.stringify(descriptor));
