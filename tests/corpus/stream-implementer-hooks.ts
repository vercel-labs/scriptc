// The stream implementer hooks on typed subclasses: Writable's
// _construct/_write/_writev/_final/_destroy, Readable's
// _read/_construct/_destroy, Duplex's allowHalfOpen, and Transform's
// _transform/_flush and inherited destroy([error]). Each hook logs the
// arguments Node hands it — chunk shape, encoding spelling, the writev
// batch records — and the error paths that reach the hooks or come back
// from them.
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";

const describe = (error: unknown): string =>
  error === null || error === undefined
    ? "none"
    : `${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? "-"} ${(error as Error).message}`;

// ── Writable: the write, writev, final and destroy hooks ──────────────
{
  class Sink extends Writable {
    _construct(callback: (error?: Error | null) => void): void {
      console.log("sink construct", this.writableLength);
      callback();
    }
    _write(chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void {
      console.log("sink write", chunk.toString(), encoding, Buffer.isBuffer(chunk));
      callback();
    }
    _writev(
      chunks: { chunk: Buffer; encoding: string }[],
      callback: (error?: Error | null) => void,
    ): void {
      console.log(
        "sink writev",
        chunks.map((e) => `${e.chunk.toString()}/${e.encoding}`).join(","),
      );
      callback();
    }
    _final(callback: (error?: Error | null) => void): void {
      console.log("sink final", this.writableEnded, this.writableFinished);
      callback();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      console.log("sink destroy", describe(error), this.destroyed);
      callback();
    }
  }
  const sink = new Sink();
  sink.on("finish", () => console.log("sink finish", sink.writableFinished));
  sink.on("close", () => console.log("sink close", sink.destroyed));
  sink.write("ab");
  sink.write(Buffer.from("cd"));
  sink.cork();
  sink.write("ef");
  sink.write("gh");
  sink.uncork();
  sink.end("ij", () => console.log("sink end callback", sink.writableEnded));
  console.log("sink after end", sink.writableEnded, sink.writableFinished);
}

// A subclass whose hooks fail, in the order Node runs them.
{
  class Failing extends Writable {
    _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      callback(new Error("write " + chunk.toString()));
    }
    _final(callback: (error?: Error | null) => void): void {
      callback(new Error("final failed"));
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      console.log("failing destroy", describe(error));
      callback();
    }
  }
  const failing = new Failing();
  failing.on("error", (error: Error) => console.log("failing error", describe(error)));
  failing.on("close", () => console.log("failing close", describe(failing.errored)));
  failing.write("x");
  failing.end();
}

// _construct's error stops the stream before any write hook.
{
  class Unbuilt extends Writable {
    _construct(callback: (error?: Error | null) => void): void {
      callback(new Error("construct failed"));
    }
    _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      console.log("unbuilt write");
      callback();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      console.log("unbuilt destroy", describe(error));
      callback();
    }
  }
  const unbuilt = new Unbuilt();
  unbuilt.on("error", (error: Error) => console.log("unbuilt error", describe(error)));
  unbuilt.on("close", () => console.log("unbuilt close", unbuilt.writableFinished));
  unbuilt.write("never");
}

// A second callback from _write and from _final.
{
  class Twice extends Writable {
    _construct(callback: (error?: Error | null) => void): void {
      callback();
      callback();
    }
    _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      callback();
      callback();
    }
    _final(callback: (error?: Error | null) => void): void {
      callback();
      callback();
    }
  }
  const twice = new Twice();
  twice.on("error", (error: Error) => console.log("twice error", describe(error)));
  twice.on("close", () => console.log("twice close"));
  twice.write("x");
  twice.end();
}

// destroy(error) reaches _destroy; a different error from _destroy is the
// one that is emitted, and a quiet destroy has none.
{
  class Replace extends Writable {
    _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      callback();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      console.log("replace destroy", describe(error));
      callback(new Error("replacement"));
    }
  }
  const replace = new Replace();
  replace.on("error", (error: Error) => console.log("replace error", describe(error)));
  replace.on("close", () => console.log("replace close", describe(replace.errored)));
  replace.destroy(new Error("original"));

  const quiet = new Replace();
  quiet.on("error", () => console.log("quiet error"));
  quiet.on("close", () => console.log("quiet close", describe(quiet.errored)));
  quiet.destroy();
}

// ── Readable: _read(size), _construct and _destroy ────────────────────
{
  class Source extends Readable {
    calls = 0;
    _construct(callback: (error?: Error | null) => void): void {
      console.log("source construct");
      callback();
    }
    _read(size: number): void {
      this.calls += 1;
      console.log("source read", this.calls, size, this.readableLength);
      if (this.calls === 1) this.push("ab");
      else if (this.calls === 2) this.push(Buffer.from("cd"));
      else this.push(null);
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      console.log("source destroy", describe(error), this.readableEnded);
      callback();
    }
  }
  const source = new Source();
  console.log("source first", source.read()?.toString());
  source.on("data", (chunk: Buffer) => console.log("source data", chunk.toString()));
  source.on("end", () => console.log("source end", source.readableEnded, source.destroyed));
  source.on("close", () => console.log("source close", describe(source.errored)));

  const early = new Source();
  early.on("error", () => {});
  early.on("close", () => console.log("early close", early.destroyed, describe(early.errored)));
  early.destroy(new Error("stop"));
}

// An object-mode Readable's _read size and chunks.
{
  class Objects extends Readable {
    constructor() {
      super({ objectMode: true });
    }
    _read(size: number): void {
      console.log("objects read", size, this.readableObjectMode);
      this.push({ n: size });
      this.push(null);
    }
  }
  const objects = new Objects();
  objects.on("data", (value: { n: number }) => console.log("objects data", typeof value, value.n));
  objects.on("end", () => console.log("objects end"));
}

// A _read that pushes an Error fails the stream.
{
  class Broken extends Readable {
    _read(): void {
      this.push(new Error("read failed"));
    }
  }
  const broken = new Broken();
  broken.on("error", (error: Error) => console.log("broken error", describe(error)));
  broken.on("close", () => console.log("broken close", broken.destroyed));
  broken.resume();
}

// ── Duplex: allowHalfOpen on each constructor form ────────────────────
{
  class Half extends Duplex {
    constructor(open: boolean) {
      super({ allowHalfOpen: open });
    }
    _read(): void {}
    _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      callback();
    }
  }
  const open = new Half(true);
  open.on("finish", () => console.log("open finish", open.readableEnded, open.writableFinished));
  open.on("end", () => console.log("open end"));
  open.on("close", () => console.log("open close"));
  open.end();
  open.push(null);

  const closed = new Half(false);
  closed.on("finish", () => console.log("closed finish", closed.readableEnded));
  closed.on("end", () => console.log("closed end", closed.readableEnded));
  closed.on("close", () => console.log("closed close"));
  closed.end();

  console.log("defaults", new Duplex().allowHalfOpen, new PassThrough().allowHalfOpen);
}

// ── Transform: _transform, _flush and destroy([error]) ────────────────
{
  class Upper extends Transform {
    _transform(
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null, data?: Buffer | string) => void,
    ): void {
      console.log("transform", chunk.toString(), encoding, Buffer.isBuffer(chunk));
      callback(null, chunk.toString().toUpperCase());
    }
    _flush(callback: (error?: Error | null, data?: Buffer | string) => void): void {
      console.log("flush", this.writableEnded, this.readableEnded);
      callback(null, "!");
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      console.log("upper destroy", describe(error));
      callback();
    }
  }
  const upper = new Upper();
  upper.on("data", (chunk: Buffer) => console.log("upper data", chunk.toString()));
  upper.on("end", () => console.log("upper end"));
  upper.on("close", () => console.log("upper close", describe(upper.errored)));
  upper.write("ab");
  upper.write(Buffer.from("cd"));
  upper.end();

  const stopped = new Upper();
  stopped.on("error", (error: Error) => console.log("stopped error", describe(error)));
  stopped.on("close", () => console.log("stopped close", describe(stopped.errored)));
  stopped.write("x");
  stopped.destroy(new Error("halt"));

  const quiet = new Upper();
  quiet.on("error", () => console.log("quiet transform error"));
  quiet.on("close", () => console.log("quiet transform close", describe(quiet.errored)));
  quiet.end();
}

// A Transform whose _transform and _flush fail.
{
  class Fails extends Transform {
    _transform(
      chunk: Buffer,
      _encoding: string,
      callback: (error?: Error | null, data?: Buffer | string) => void,
    ): void {
      callback(new Error("transform " + chunk.toString()));
    }
    _flush(callback: (error?: Error | null, data?: Buffer | string) => void): void {
      callback(new Error("flush failed"));
    }
  }
  const fails = new Fails();
  fails.on("error", (error: Error) => console.log("fails error", describe(error)));
  fails.on("close", () => console.log("fails close", describe(fails.errored)));
  fails.write("y");
  fails.end();
}
