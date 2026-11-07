// A native I/O handle (a ChildProcess, a server, a socket) has no island
// export: its checked-dynamic box is a runtime handle the export table does
// not take, and the runtime refuses it when it crosses. A statically typed
// one is SC8010 where it crosses, alone, as an arm of a union, as a member
// of a literal or refined by an intersection, instead of a TypeError when the
// program runs.
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import { take, line } from "take-pkg";

const child = spawn("true");
const server = createServer();
function pass(either: ChildProcess | string): string {
  return take(either);
}

console.log(take(child));
console.log(take(server));
console.log(pass(child));
console.log(line({ name: "job", child }));
function respond(res: ServerResponse & { req: IncomingMessage }): string {
  return take(res);
}
void respond;
server.close();
