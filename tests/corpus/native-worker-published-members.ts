import {
  Worker,
  getEnvironmentData,
  isMainThread,
  parentPort,
  setEnvironmentData,
  workerData,
} from "node:worker_threads";
import { publish, sharesPublishedGraphs } from "@scriptc/threads";

class Box {
  value = 7;
  read(): number {
    return this.value;
  }
}

// Native published graphs keep class members. Node clones their own data
// into plain objects; the capability flag makes both contracts explicit.
function inspect(value: any): string {
  return `${value.value} ${("read" in value) === sharesPublishedGraphs}`;
}

if (isMainThread) {
  const source = publish(new Box());
  console.log("sender", source.read());
  setEnvironmentData("box", publish(new Box()));
  const worker = new Worker(new URL(import.meta.url), { workerData: source });
  worker.on("message", (value: any) => {
    if (typeof value === "string") console.log(value);
    else console.log("reply", inspect(value));
  });
  worker.on("exit", (code: number) => console.log("exit", code));
  worker.postMessage(publish(new Box()));
} else {
  parentPort!.postMessage(`data ${inspect(workerData)}`);
  parentPort!.postMessage(`environment ${inspect(getEnvironmentData("box"))}`);
  parentPort!.once("message", (value: any) => {
    parentPort!.postMessage(`posted ${inspect(value)}`);
    const reply = publish(new Box());
    parentPort!.postMessage(reply);
    parentPort!.close();
  });
}
