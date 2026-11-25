// @transform-types
// `satisfies` leaves no trace at run time, so `require(...) satisfies T` is
// the module binding `require(...) as T` is, and a fork target written
// `path satisfies string` is the module `path as string` names.
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const viaAs = require("node:path") as typeof import("node:path");
const viaSatisfies = require("node:path") satisfies typeof import("node:path");
const viaAngle = <typeof import("node:path")>require("node:path");
const viaBoth = (require("node:os") satisfies unknown) as typeof import("node:os");
const { basename } = require("node:path") satisfies typeof import("node:path");

console.log(
  viaAs.basename("/a/b.txt"),
  viaSatisfies.basename("/a/c.txt"),
  viaAngle.basename("/a/d.txt"),
);
console.log(typeof viaBoth.platform(), basename("/x/y.z"));
console.log((require("node:path") satisfies typeof import("node:path")).extname("q.ts"));

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const child = fork(
  fileURLToPath(new URL(`./child.${extension}`, import.meta.url)) satisfies string,
  ["from-parent"] satisfies string[],
);
child.on("message", (message: { argument: string }) => console.log("message", message.argument));
child.on("exit", (code) => console.log("exit", code));
