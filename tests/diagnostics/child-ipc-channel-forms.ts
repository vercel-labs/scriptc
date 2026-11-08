// fork() with an execPath and spawn() with a fourth stdio entry "ipc" open
// Node's JSON IPC channel to another executable. The forms the channel does
// not carry are refused by name where they are written: V8's "advanced"
// serialization, an "ipc" entry outside the fourth slot, the channel beside
// a detached child, and a script path known only at run time with no
// executable named to run it.
import { fork, spawn } from "node:child_process";

const script: string = process.argv[2] ?? "relay.mjs";

fork(script, [], { execPath: "/usr/bin/node", serialization: "advanced" });
spawn("/usr/bin/node", [script], { stdio: ["ignore", "inherit", "ipc"] });
spawn("/usr/bin/node", [script], { stdio: ["ignore", "inherit", "inherit", "ipc"], detached: true });
fork(script);
