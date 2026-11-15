// `cwd-kit` is marked "lazy" and reads the working directory when it loads:
// it exports an object keyed by it and leaves it in a member of `console`.
// `cwd-echo` exports that member. Neither the build's working directory nor
// anything computed from it is written into the program; the run reads its
// own, as Node does.
import { byDir, label } from "cwd-kit";
import { DIR } from "cwd-echo";

console.log(label, Object.keys(byDir)[0] === process.cwd(), DIR === process.cwd());
