// @requires-libnode
// Signal listeners that island code adds and removes join the program's own
// signal registry at their registration position: every listener of both
// sides runs in registration order, a once listener runs once, and removing
// an island listener leaves the program's handler for the same signal in
// place (libuv never owns the signal, so the removal does not reset it to
// its default disposition and the next signal does not kill the process).
// JavaScript, for the signal names the typed declarations do not cover.
import { callSync } from "@scriptc/node";

function island(name, signal, label) {
  callSync("./process.cjs", name, signal, label);
}

function later(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const native = (name) => console.log(`native ${name}`);
  process.on("SIGUSR2", native);
  island("listen", "SIGUSR2", "b");
  island("listenOnce", "SIGUSR2", "once");
  const second = () => console.log("native second");
  process.on("SIGUSR2", second);

  process.kill(process.pid, "SIGUSR2");
  await later(50);
  console.log("-- island removes b");
  island("unlisten", "SIGUSR2", "b");
  process.kill(process.pid, "SIGUSR2");
  await later(50);

  console.log("-- island adds and removes a SIGHUP listener");
  const hup = () => console.log("native SIGHUP");
  process.on("SIGHUP", hup);
  island("listen", "SIGHUP", "hup");
  island("unlisten", "SIGHUP", "hup");
  process.kill(process.pid, "SIGHUP");
  await later(50);

  console.log("-- island listens to a signal the program does not");
  island("listen", "SIGUSR1", "usr1");
  process.kill(process.pid, "SIGUSR1");
  await later(50);
  island("unlisten", "SIGUSR1", "usr1");

  process.removeListener("SIGUSR2", native);
  process.removeListener("SIGUSR2", second);
  process.removeListener("SIGHUP", hup);
  console.log("done");
}

void main();
