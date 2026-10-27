// pipeline() with an async function or async generator destination: a
// typed callback whose error parameter admits undefined receives
// undefined when the pipeline succeeds, as in Node, and the error when it
// fails.
import { pipeline, Readable } from "node:stream";

function source(): Readable {
  return Readable.from(["a", "b", "c"]);
}

async function join(src: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const c of src) s += c;
  return s;
}

function optional(): Promise<void> {
  return new Promise((resolve) => {
    pipeline(source(), join, (err?: Error | null, value?: string) => {
      console.log("optional", err, err === undefined, value);
      resolve();
    });
  });
}

function declared(): Promise<void> {
  return new Promise((resolve) => {
    pipeline(
      source(),
      async function (src: AsyncIterable<string>) {
        let n = 0;
        for await (const c of src) n += c.length;
        return n;
      },
      (err: Error | null | undefined, value?: number) => {
        console.log("declared", err, typeof err, value);
        resolve();
      },
    );
  });
}

function unknownParam(): Promise<void> {
  return new Promise((resolve) => {
    pipeline(source(), join, (err: unknown, value: unknown) => {
      console.log("unknown", err, value);
      resolve();
    });
  });
}

function rest(): Promise<void> {
  return new Promise((resolve) => {
    pipeline(
      source(),
      async function* (src: AsyncIterable<string>) {
        for await (const c of src) yield c.toUpperCase();
      },
      async function (src: AsyncIterable<string>) {
        for await (const c of src) void c;
      },
      (...args: unknown[]) => {
        console.log("rest", args.length, args);
        resolve();
      },
    );
  });
}

function generatorDestination(): Promise<void> {
  return new Promise((resolve) => {
    pipeline(
      source(),
      async function* (src: AsyncIterable<string>) {
        for await (const c of src) yield c;
      },
      (err: Error | null | undefined, value: unknown) => {
        console.log("generator", err, value);
        resolve();
      },
    );
  });
}

function named(): Promise<void> {
  return new Promise((resolve) => {
    function done(err: Error | null | undefined, value: string | undefined): void {
      console.log("named", err, value);
      resolve();
    }
    pipeline(source(), join, done);
  });
}

function failing(): Promise<void> {
  return new Promise((resolve) => {
    pipeline(
      source(),
      async function (src: AsyncIterable<string>) {
        for await (const c of src) if (c === "b") throw new Error("boom at " + c);
        return "never";
      },
      (err?: Error | null, value?: string) => {
        console.log("failing", err?.message, value);
        resolve();
      },
    );
  });
}

async function main(): Promise<void> {
  await optional();
  await declared();
  await unknownParam();
  await rest();
  await generatorDestination();
  await named();
  await failing();
}
void main();
