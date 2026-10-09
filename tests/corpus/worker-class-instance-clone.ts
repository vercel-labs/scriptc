// A class instance posted to a worker (workerData or postMessage) arrives
// as a structured clone: a plain object with the instance's own enumerable
// data properties. Methods, accessors, private fields and the prototype
// chain are not transferred, so instanceof is false in the receiver, and
// repeated references inside one message stay one object. A frozen
// message arrives unfrozen.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

class Fixture {
  kind = "fixture";
  describe(): string {
    return `a ${this.kind}`;
  }
}

class Lamp extends Fixture {
  name: string;
  parts: string[];
  #serial = 7;
  constructor(name: string, parts: string[]) {
    super();
    this.name = name;
    this.parts = parts;
  }
  get label(): string {
    return this.name.toUpperCase();
  }
  serial(): number {
    return this.#serial;
  }
}

function inspect(value: unknown): string {
  const shape = value as { describe?: unknown; label?: unknown; serial?: unknown };
  return [
    JSON.stringify(value),
    value instanceof Lamp,
    value instanceof Fixture,
    typeof shape.describe,
    typeof shape.label,
    typeof shape.serial,
  ].join(" ");
}

if (isMainThread) {
  const lamp = new Lamp("desk", ["bulb", "shade"]);
  const worker = new Worker(new URL(import.meta.url), { workerData: lamp });
  worker.on("message", (message: unknown) => {
    if (typeof message === "string") console.log(message);
    else console.log("reply", inspect(message));
  });
  worker.on("exit", (code: number) => console.log("exit", code, lamp.describe(), lamp.label));
  worker.postMessage(Object.freeze([lamp, lamp]));
} else {
  const port = parentPort!;
  port.postMessage(`workerData ${inspect(workerData)} ${Object.isFrozen(workerData)}`);
  port.once("message", (message: unknown) => {
    const pair = message as unknown[];
    port.postMessage(
      `pair ${pair.length} ${pair[0] === pair[1]} ${Object.isFrozen(message)} ${inspect(pair[0])}`,
    );
    port.postMessage(new Lamp("floor", ["base"]));
    port.close();
  });
}
