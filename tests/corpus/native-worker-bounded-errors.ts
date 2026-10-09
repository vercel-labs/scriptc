import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

class Gauge {
  level: number;
  constructor(level: number) {
    if (level < 0) throw new RangeError(`negative level ${level}`);
    this.level = level;
  }
  read(limit: number): number {
    return checked(this.level, limit);
  }
}

function checked(value: number, limit: number): number {
  if (value > limit) throw new RangeError(`value ${value} over ${limit}`);
  return value;
}

function total(values: number[], limit: number): number {
  let sum = 0;
  for (const value of values) sum += checked(value, limit);
  return sum;
}

function probe(label: string, run: () => number): string {
  try {
    return `${label} ok ${run()}`;
  } catch (error) {
    return `${label} caught ${(error as Error).name}: ${(error as Error).message}`;
  } finally {
    order.push(label);
  }
}

const order: string[] = [];

function report(): string[] {
  return [
    probe("direct", () => checked(3, 5)),
    probe("over", () => checked(9, 5)),
    probe("loop", () => total([1, 2, 7], 5)),
    probe("construct", () => new Gauge(-1).level),
    probe("method", () => new Gauge(8).read(5)),
    probe("after", () => new Gauge(4).read(5) + total([1, 1], 5)),
    order.join(","),
  ];
}

if (isMainThread) {
  console.log(report().join("\n"));
  for (const mode of ["report", "direct", "method"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: mode });
      worker.on("message", (lines: string[]) => console.log(`${mode} worker\n${lines.join("\n")}`));
      worker.on("error", (error: Error) =>
        console.log(mode, "error", error.name, error.message, error instanceof RangeError),
      );
      worker.on("exit", (code: number) => {
        console.log(mode, "exit", code);
        resolve();
      });
    });
  }
} else if (workerData === "report") {
  parentPort!.postMessage(report());
} else if (workerData === "direct") {
  checked(10, 1);
  console.log("unreachable");
} else {
  console.log("level", new Gauge(2).read(3));
  new Gauge(6).read(3);
  console.log("unreachable");
}
