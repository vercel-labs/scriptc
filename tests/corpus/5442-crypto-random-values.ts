// randomFillSync and randomFill over every view kind with Node's offset
// and size rules, randomInt's callback form and its timing, and
// randomUUID / randomUUIDv7 options. Random bytes are checked by where
// they land, not by value.
import { randomFill, randomFillSync, randomInt, randomUUID, randomUUIDv7 } from "node:crypto";

function errorText(err: Error | null): string {
  return err === null ? "null" : err.message;
}

function show(label: string, fn: () => string): void {
  try {
    console.log(label, fn());
  } catch (e) {
    const error = e as Error & { code?: string };
    console.log(label, "throws", error.name, error.code, error.message);
  }
}

/** Which 4-byte groups of a view's memory changed from zero: "." unchanged,
 * "x" changed. */
function touched(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    let changed = false;
    for (let j = i; j < i + 4 && j < bytes.length; j++) if (bytes[j] !== 0) changed = true;
    out += changed ? "x" : ".";
  }
  return out;
}

show("u16 whole", () => {
  const view = randomFillSync(new Uint16Array(16));
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("u16 offset 4 size 8", () => {
  const view = randomFillSync(new Uint16Array(32), 4, 8);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("f64 offset 2", () => {
  const view = randomFillSync(new Float64Array(8), 2);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("i32 size 0", () => {
  const view = randomFillSync(new Int32Array(8), 3, 0);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("DataView offset 8", () => {
  const view = randomFillSync(new DataView(new ArrayBuffer(48), 8), 8, 16);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("Buffer offset 16", () => {
  const view = randomFillSync(Buffer.alloc(64), 16);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
// The fractional offset fills bytes 17 to 32, so the last group holds a
// single random byte, which is zero 1 time in 256: the groups OR over
// eight fills.
show("u16 fractional offset", () => {
  const seen = new Uint8Array(64);
  for (let run = 0; run < 8; run++) {
    const view = randomFillSync(new Uint16Array(32), 8.5, 8);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < bytes.length; i++) seen[i] |= bytes[i]!;
  }
  return touched(seen);
});
const same = new Uint32Array(8);
show("identity", () => String(randomFillSync(same) === same));
show("u16 offset past end", () => {
  const view = randomFillSync(new Uint16Array(4), 5);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("u16 size past end", () => {
  const view = randomFillSync(new Uint16Array(4), 1, 4);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("u16 negative offset", () => {
  const view = randomFillSync(new Uint16Array(4), -1);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("size too large", () => {
  const view = randomFillSync(new Uint8Array(4), 0, 2 ** 31);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});
show("offset NaN", () => {
  const view = randomFillSync(new Uint8Array(4), NaN);
  return touched(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
});

show("randomInt range", () => {
  for (let i = 0; i < 2000; i++) {
    const a = randomInt(5), b = randomInt(-3, 3), c = randomInt(2 ** 47, 2 ** 47 + 2);
    if (a < 0 || a >= 5 || b < -3 || b >= 3 || c < 2 ** 47 || c >= 2 ** 47 + 2 || !Number.isInteger(b)) return "out of range";
  }
  return "in range";
});
show("randomInt max 0", () => String(randomInt(0)));
show("randomInt equal", () => String(randomInt(3, 3)));
show("randomInt fraction", () => String(randomInt(1.5)));
show("randomInt unsafe", () => String(randomInt(2 ** 53)));
show("randomInt unsafe min", () => String(randomInt(-(2 ** 53), 0)));
show("randomInt span", () => String(randomInt(0, 2 ** 48)));
show("randomInt max span", () => String(randomInt(2 ** 48 + 2)));
show("randomInt span limit", () => String(randomInt(0, 2 ** 48 - 1) >= 0));

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
show("uuid", () => String(v4.test(randomUUID()) && v4.test(randomUUID({ disableEntropyCache: true }))));
show("uuid empty options", () => String(v4.test(randomUUID({}))));
show("uuid distinct", () => String(new Set(Array.from({ length: 300 }, () => randomUUID())).size));
show("v7", () => String(v7.test(randomUUIDv7()) && v7.test(randomUUIDv7({ disableEntropyCache: false }))));
show("v7 time", () => {
  const before = Date.now();
  const id = randomUUIDv7();
  const after = Date.now();
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return String(ms >= before && ms <= after);
});

// Callback order: randomFill and randomInt against nextTick and promises.
// A fill of zero bytes calls back synchronously. Node runs fills on its
// thread pool and answers int calls from its own byte cache, so each start
// sits in the previous one's callback and the whole order prints from the
// last callback — a wall-clock wait would print a partial order on a busy
// machine.
const order: string[] = [];
const target = new Float32Array(16);

function warmInt(): void {
  randomInt(100, (err, n) => {
    order.push(`int warm ${err ? "error" : "no error"} ${n < 100}`);
    process.nextTick(() => {
      order.push("tick after warm int");
      console.log(order.join("\n"));
    });
  });
}

function nestedInt(): void {
  randomInt(5, 7, (err, m) => {
    order.push(`int nested ${err ? "error" : "no error"} ${m === 5 || m === 6}`);
    process.nextTick(() => {
      order.push("tick after nested int");
      warmInt();
    });
  });
}

randomFill(new Uint8Array(8), 2, 0, (err, buf) => {
  order.push(`fill empty ${errorText(err)} ${touched(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))}`);
});
order.push("after empty fill");
show("fill bad offset", () => {
  randomFill(new Uint8Array(2), 3, () => {});
  return "no error";
});
show("int callback bad range", () => {
  randomInt(3, 3, () => {});
  return "no error";
});
process.nextTick(() => order.push("tick"));
Promise.resolve().then(() => order.push("promise"));
randomFill(new Uint16Array(8), (err, buf) => {
  order.push(`fill ${errorText(err)} ${buf.length} ${touched(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))}`);
  randomFill(target, 4, (err2, buf2) => {
    order.push(`fill offset ${errorText(err2)} ${buf2 === target} ${touched(new Uint8Array(buf2.buffer, buf2.byteOffset, buf2.byteLength))}`);
    randomFill(new DataView(new ArrayBuffer(32)), 8, 16, (err3, buf3) => {
      order.push(`fill dataview ${errorText(err3)} ${buf3.byteLength} ${touched(new Uint8Array(buf3.buffer, buf3.byteOffset, buf3.byteLength))}`);
      randomInt(10, (err4, n) => {
        order.push(`int ${err4 ? "error" : "no error"} ${n >= 0 && n < 10}`);
        nestedInt();
      });
    });
  });
});
