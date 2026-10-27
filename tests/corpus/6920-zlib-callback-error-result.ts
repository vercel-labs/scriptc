// zlib callbacks receive undefined as the result when they fail, as in
// Node: the result reads as undefined in logs, templates, typeof and
// comparisons, member reads throw Node's TypeError, and the same callbacks
// read the Buffer as before when the operation succeeds. This holds for
// callback literals and for function values.
import * as zlib from "node:zlib";

const good = zlib.deflateSync("hello callbacks");
const bad = Buffer.from("not deflate data");

function report(label: string, run: () => void): void {
  try {
    run();
  } catch (e) {
    console.log(label, "threw", (e as Error).name, (e as Error).message);
  }
}

function check(label: string, input: Buffer, next: () => void): void {
  zlib.inflate(input, (err, out) => {
    console.log(label, "error", err?.code ?? null);
    console.log(label, "value", out);
    console.log(label, "template", `${out}`, String(out), out + "");
    console.log(label, "typeof", typeof out, out === undefined, out !== undefined);
    console.log(label, "optional", out?.length, out?.toString());
    console.log(label, "isBuffer", Buffer.isBuffer(out));
    console.log(label, out ? "truthy" : "falsy");
    report(label + " length", () => console.log(label, "length", out.length));
    report(label + " toString", () => console.log(label, "text", out.toString()));
    report(label + " inflateSync", () => console.log(label, "again", zlib.inflateSync(out).length));
    setTimeout(() => {
      console.log(label, "later", typeof out, out?.byteLength);
      next();
    });
  });
}

function guarded(next: () => void): void {
  // A callback that checks the error first reads the Buffer only on success.
  zlib.gunzip(bad, (err, out) => {
    if (err) {
      console.log("guarded error", err.code, err.errno);
      zlib.gzip("guarded text", (err2, packed) => {
        if (err2) throw err2;
        zlib.gunzip(packed, (err3, plain) => {
          console.log("guarded round trip", err3, plain.toString());
          next();
        });
      });
      return;
    }
    console.log("guarded value", out.toString());
  });
}

function expressions(): void {
  // Expression bodies.
  zlib.unzip(bad, (err, out) =>
    zlib.deflateRaw("raw", (err2, raw) => console.log("expression", err?.code, out, err2, raw.length > 0)),
  );
}

function everyFunction(next: () => void): void {
  // Each callback function, with and without options. maxOutputLength makes
  // the compressors fail; a non-matching format makes the decompressors fail.
  const text = "every function ".repeat(20);
  const opts = { maxOutputLength: 8 };
  zlib.deflate(text, opts, (err, out) => {
    console.log("deflate", err?.code, typeof out, out?.length);
    zlib.deflateRaw(text, opts, (err, out) => {
      console.log("deflateRaw", err?.code, typeof out, out?.length);
      zlib.gzip(text, opts, (err, out) => {
        console.log("gzip", err?.code, typeof out, out?.length);
        zlib.inflateRaw(bad, (err, out) => {
          console.log("inflateRaw", err?.code, typeof out, out?.length);
          zlib.inflate(zlib.deflateSync(text), opts, (err, out) => {
            console.log("inflate options", err?.code, typeof out, out?.length);
            zlib.gunzip(zlib.gzipSync(text), opts, (err, out) => {
              console.log("gunzip options", err?.code, typeof out, out?.length);
              zlib.unzip(bad, {}, (err, out) => {
                console.log("unzip options", err?.code, typeof out, out?.length);
                zlib.inflateRaw(zlib.deflateRawSync(text), {}, (err, out) => {
                  console.log("inflateRaw options", err, out.toString() === text);
                  zlib.deflate(text, {}, (err, out) => {
                    console.log("deflate options", err, zlib.inflateSync(out).toString() === text);
                    next();
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

function folded(input: Buffer, next: () => void): void {
  // Conditions on the error parameter.
  zlib.inflateRaw(input, (err, out) => {
    if (err !== null) console.log("folded error", err.code, typeof out);
    else console.log("folded value", out.length);
    if (!err) console.log("folded ok", out.toString());
    console.log("folded both", err == null ? out.length : typeof out, err && err.code);
    if (err) return;
    console.log("folded after", out.byteLength);
  });
  setTimeout(next, 10);
}

// Function values: declarations, const arrows and forwarded parameters
// receive undefined too, and a direct call still passes its arguments.
const steps: (() => void)[] = [];
function step(): void {
  const run = steps.shift();
  if (run) run();
}
function named(err: Error | null, out: Buffer): void {
  if (err) console.log("named error", (err as NodeJS.ErrnoException).code, typeof out, out === undefined);
  else console.log("named value", out.toString());
  console.log("named both", err !== null, typeof out, `${out}`, out?.length);
  step();
}
const arrow = (err: Error | null, out: Buffer): void => {
  console.log("arrow", err?.message ?? null, typeof out, String(out));
  report("arrow length", () => console.log("arrow length", out.length));
  step();
};
function captures(err: Error | null, out: Buffer): void {
  setTimeout(() => {
    console.log("captured", err !== null, typeof out, out?.length);
    step();
  });
}
function forward(input: Buffer, cb: (err: Error | null, out: Buffer) => void): void {
  zlib.inflate(input, cb);
}
function forwardGzip(text: string, cb: (err: Error | null, out: Buffer) => void): void {
  zlib.gzip(text, { maxOutputLength: 4 }, cb);
}

function forwardLiteral(input: Buffer, cb: (err: Error | null, out: Buffer) => void): void {
  // The literal passes its result on to a typed callback.
  zlib.inflate(input, (err, out) => cb(err, out));
}
function inflated(input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) =>
    zlib.inflate(input, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

function sink(err: Error | null, out: Buffer): void {
  console.log("sink", err, typeof out, out?.length);
  step();
}
function nestedForward(): void {
  // On the outer error path, the nested callback forwards its own result.
  zlib.inflate(bad, (err, out) => {
    console.log("outer", err?.code, typeof out);
    zlib.inflate(good, (err2, out2) => sink(err2, out2));
  });
}
let attempts = 0;
function namedRetry(): void {
  // A named callback that calls itself with an error and a Buffer.
  zlib.inflate(bad, function retry(err, out) {
    attempts++;
    if (err) {
      if (attempts < 3) return retry(new Error("again"), Buffer.from("x"));
      console.log("gave up", attempts, err.message, out.length);
      step();
      return;
    }
    console.log("retry value", out.length);
    step();
  });
}

function shown(label: string, out: Buffer): void {
  console.log(label, typeof out, out.toString());
}
function fallbackResult(): void {
  // The body assigns a fallback Buffer to its result, then passes the
  // result on to typed functions.
  zlib.inflate(bad, (err, out) => {
    if (!out) out = Buffer.from("fallback");
    console.log("fallback", err?.code, typeof out, out.toString());
    shown("fallback passed", out);
    zlib.inflate(good, (err2, out2) => {
      if (err2) out2 = Buffer.alloc(0);
      console.log("fallback nested", err2, out2.length);
      shown("fallback nested passed", out2);
      zlib.inflate(bad, (err3, out3) => {
        if (err3) out3 = Buffer.from("inner fallback");
        sink(null, out3);
      });
    });
  });
}

function functionValues(next: () => void): void {
  steps.push(
    () => zlib.inflate(good, named),
    () => zlib.inflate(bad, named),
    () => zlib.inflate(good, arrow),
    () => zlib.inflate(bad, arrow),
    () => forward(bad, named),
    () => forwardLiteral(bad, named),
    () => forwardLiteral(good, arrow),
    () =>
      inflated(bad).then(
        (out) => console.log("promise value", out.length),
        (e) => {
          console.log("promise rejected", (e as NodeJS.ErrnoException).code);
          step();
        },
      ),
    () =>
      void inflated(good).then((out) => {
        console.log("promise value", out.toString());
        step();
      }),
    () => forwardGzip("text that does not fit", arrow),
    () => zlib.inflate(bad, captures),
    () => zlib.inflate(good, captures),
    nestedForward,
    namedRetry,
    fallbackResult,
    () => {
      named(new Error("direct"), Buffer.from("both"));
    },
    next,
  );
  step();
}

check("good", good, () =>
  check("bad", bad, () =>
    guarded(() =>
      everyFunction(() =>
        folded(zlib.deflateRawSync("folded text"), () =>
          folded(bad, () => functionValues(expressions)),
        ),
      ),
    ),
  ),
);
