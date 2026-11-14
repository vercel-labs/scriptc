// subprocess.send's argument overloads and the 'message' listener's second
// parameter: a nullish sendHandle with an optional options record and
// callback, and the handle the listener reads (undefined, because nothing is
// transferred). process.send in the child takes the same shapes.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

function closed(child: ReturnType<typeof fork>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

// Node evaluates every argument, in order, even the sendHandle and options
// slots it does not transfer a value from.
function payload(echo: string): { echo: string } {
  console.log("evaluated", echo);
  return { echo };
}
function handled(label: string): null {
  console.log("evaluated", label);
  return null;
}
function keepOpen(label: string): boolean {
  console.log("evaluated", label);
  return true;
}

const child = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
let callbacks = 0;
function callback(error: Error | null): void {
  if (error === null) callbacks++;
}
child.on("message", (message: { echo: string; handle: boolean }) => {
  console.log("message", message.echo, message.handle);
});
console.log("plain", child.send({ echo: "plain" }));
console.log("callback", child.send({ echo: "callback" }, callback));
console.log("null handle", child.send({ echo: "null handle" }, null, callback));
console.log("keepOpen", child.send({ echo: "keepOpen" }, null, { keepOpen: true }, callback));
console.log("options only", child.send({ echo: "options only" }, null, { keepOpen: false }));
console.log(
  "side effects",
  child.send(
    payload("side effects"),
    handled("sendHandle"),
    { keepOpen: keepOpen("keepOpen") },
    callback,
  ),
);
console.log(
  "void handle",
  child.send(payload("void handle"), void handled("void sendHandle"), callback),
);
console.log("last", child.send({ echo: "last" }));
console.log("close", await closed(child), "callbacks", callbacks);
