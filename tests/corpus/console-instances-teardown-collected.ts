// Consoles with detached loggers are linked into the exit cleanup list, and
// the collector can free some of them before the process ends: an
// event-loop turn lets it collect the consoles this program drops (they
// unlink themselves), and the teardown then walks what is left while each
// release can run the collector again. Several consoles stay on the list so
// the walk crosses more than one borrowed link.

import { Console } from "node:console";
import { Writable } from "node:stream";

interface Sink {
  stream: Writable;
  text: () => string;
}

function sink(): Sink {
  let out = "";
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      out += String(chunk);
      cb();
    },
  });
  return { stream, text: () => out };
}

interface Held {
  log: (message: string) => void;
  text: () => string;
}

const held: Held[] = [];
for (let i = 0; i < 7; i++) {
  const target = sink();
  const instance = new Console({
    stdout: target.stream,
    stderr: target.stream,
    inspectOptions: { depth: 0 },
  });
  const log = instance.log;
  log(`round ${i}`);
  if (i % 2 === 0) held.push({ log, text: target.text });
}
// The odd consoles and their bound functions are unreachable now; the turn
// gives the collector an idle point to free them.
await new Promise<void>((resolve) => setTimeout(resolve, 0));
for (const entry of held) entry.log("kept");
console.log("kept", held.length, "lines", held.filter((entry) => entry.text().includes("kept")).length);
