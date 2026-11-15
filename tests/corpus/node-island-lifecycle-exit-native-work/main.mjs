// @exit: 4
// @requires-libnode
// process.exit from an island timer while the native side has an interval,
// fs reads, a server with an open connection, a child process and pending
// promise chains.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs";
import { connect, createServer } from "node:net";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
setInterval(() => {}, 1);
readFile(import.meta.filename, () => {});
for (let i = 0; i < 50; i++) stat(import.meta.filename, () => {});
const srv = createServer(() => {}).listen(0, "127.0.0.1", () => {
  const c = connect(srv.address().port, "127.0.0.1");
  c.on("error", () => {});
});
spawn("sleep", ["5"], { stdio: "ignore" }).on("error", () => {});
(async () => {
  for (;;) await new Promise((r) => setTimeout(r, 1));
})();
process.on("exit", (code) => console.log(`exit ${code}`));
lib.exitLater(30, 4);
