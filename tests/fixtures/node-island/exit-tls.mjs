// Exit while Node has OpenSSL work in flight (node-island-exit.test.ts):
// Node must stop its threads before the process's exit handlers tear
// OpenSSL down. argv[2]: "early" (exit right after Node starts, while it
// loads the system root certificates on a thread of its own with
// NODE_USE_SYSTEM_CA=1), "load" (node:tls loaded, extra certificates
// loading off-thread), "exit" (process.exit with pool work in flight),
// "keys", or "return" (fall off the end). A "-return" suffix ends the
// program by returning instead of process.exit (C exit and its handlers).
import { requireModule } from "@scriptc/node";

const arg = process.argv[2] ?? "exit";
const returns = arg.endsWith("-return") || arg === "return";
const mode = arg.replace(/-return$/, "");
if (mode === "early") {
  console.log("roots", requireModule("./helper.cjs") !== null);
} else {
  const lib = requireModule("./exit-tls.cjs");
  console.log("roots", lib.warm(mode));
}
if (!returns) process.exit(0);
