// @requires-libnode
// Island packages whose load reads what belongs to one run or one machine:
// the home, temporary and working directories, the process id, a random
// number, and a member of `process` the build's load recorder has no rule
// for. None of them may come from the build. The home and temporary
// directories are boot guards on their variables; the others have no guard,
// and their loads evaluate where they are imported. That holds for a random
// number too: the build once deferred such a load without constants, and a
// package loaded after it could still export, as a constant, what the first
// had left in a global from the build's own draw.
const os = require("os");
const seed = require("seed-kit");
const echo = require("echo-kit");
// Taken before anything else is asked of an island package.
const echoed = echo.seed;
const place = require("place-kit");
const ident = require("ident-kit");
const odd = require("odd-kit");
const plain = require("plain-kit");

console.log("home:", place.home === os.homedir(), "temporary:", place.temporary === os.tmpdir());
console.log("directory:", place.directory === process.cwd());
console.log("process:", ident.id === process.pid, ident.parent === process.ppid);
console.log("seed:", typeof echoed, echoed === seed.seed);
console.log("report:", odd.report, odd.header);
console.log("plain:", plain.name, plain.size);
