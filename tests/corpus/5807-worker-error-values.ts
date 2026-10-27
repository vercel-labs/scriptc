import { Worker, isMainThread, workerData } from "node:worker_threads";

// A worker's uncaught exception reaches the 'error' listener as Node's
// error serializer sends it: an Error keeps the nearest built-in
// constructor, its name (own or inherited), message, cause and other data
// properties with their enumerability; other values clone as messages do.
class ConfigError extends RangeError {
  setting: string;
  constructor(message: string, setting: string) {
    super(message);
    this.name = "ConfigError";
    this.setting = setting;
  }
}

const cases = ["props", "subclass", "aggregate", "cause", "string", "null", "number", "object", "runtime"];

if (isMainThread) {
  let next = 0;
  const run = (): void => {
    const name = cases[next++];
    if (name === undefined) return;
    const worker = new Worker(new URL(import.meta.url), { workerData: name });
    worker.on("error", (e: any) => {
      if (typeof e !== "object" || e === null) {
        console.log(name, typeof e, e);
        return;
      }
      console.log(name, e instanceof Error, e instanceof RangeError, e instanceof TypeError, e.name, e.message);
      console.log(" ", JSON.stringify(e), e.code, e.setting, e.errors?.length, e.cause?.message, e.cause?.detail);
    });
    worker.on("exit", (code: number) => {
      console.log(" ", "exit", code);
      run();
    });
  };
  run();
} else {
  switch (workerData) {
    case "props": {
      const e: any = new Error("with props");
      e.code = "E_PROPS";
      e.extra = { y: 2 };
      throw e;
    }
    case "subclass":
      throw new ConfigError("bad setting", "port");
    case "aggregate":
      throw new AggregateError([new Error("a"), new TypeError("b")], "several");
    case "cause": {
      const inner: any = new Error("inner");
      inner.detail = 7;
      throw new Error("outer", { cause: inner });
    }
    case "string":
      throw "plain string";
    case "null":
      throw null;
    case "number":
      throw 42;
    case "object":
      throw { a: 1, b: "x" };
    case "runtime": {
      const value: any = JSON.parse("null");
      console.log(value.missing);
    }
  }
}
