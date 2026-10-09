import { Worker, isMainThread, parentPort } from "node:worker_threads";

class Fault extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`fault ${code}`);
    this.name = "Fault";
    this.code = code;
  }
}

function fail(code: number): never {
  throw new Fault(code);
}

function label(code: number): string {
  const parts = ["item", String(code)];
  if (code % 3 === 0) fail(code);
  return parts.join("-");
}

function nested(log: string[]): string {
  try {
    try {
      return label(3);
    } finally {
      log.push("inner finally");
    }
  } catch (error) {
    log.push(`rethrow ${(error as Fault).code}`);
    throw error;
  } finally {
    log.push("outer finally");
  }
}

function replaced(log: string[]): string {
  try {
    return label(6);
  } finally {
    log.push("replacing");
    label(9);
  }
}

function* steps(log: string[]): Generator<string> {
  try {
    yield label(1);
    yield label(2);
  } finally {
    log.push("generator finally");
  }
}

async function later(code: number): Promise<string> {
  await null;
  return label(code);
}

async function scenarios(): Promise<string[]> {
  const log: string[] = [];
  const attempt = (name: string, run: () => string): void => {
    try {
      log.push(`${name} ${run()}`);
    } catch (error) {
      log.push(`${name} caught ${(error as Error).message}`);
    }
  };
  attempt("plain", () => label(4));
  attempt("nested", () => nested(log));
  attempt("replaced", () => replaced(log));
  attempt("catch throw", () => {
    try {
      return label(12);
    } catch {
      return label(15);
    }
  });
  const generator = steps(log);
  log.push(`step ${generator.next().value}`);
  log.push(`return ${String(generator.return("done").value)}`);
  try {
    log.push(await later(5));
    log.push(await later(18));
  } catch (error) {
    log.push(`async caught ${(error as Error).message}`);
  }
  attempt("after", () => label(7) + label(8));
  return log;
}

if (isMainThread) {
  console.log((await scenarios()).join("\n"));
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (lines: string[]) => console.log(`worker\n${lines.join("\n")}`));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.postMessage(await scenarios());
}
