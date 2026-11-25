// crypto.createMac with KMAC128/KMAC256: SP 800-185 vectors, the custom
// option set (customization, byte output length), the name aliases, chunked
// updates and Node's key/option errors.
import { createMac, createSecretKey } from "node:crypto";

const vectorKey = createSecretKey(Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i)));
const m1 = createMac("KMAC128", vectorKey);
m1.update(Buffer.from([0, 1, 2, 3]));
console.log("vector1", m1.final("hex"));

const m2 = createMac("KMAC128", vectorKey, { customization: Buffer.from("My Tagged Application") });
m2.update(Buffer.from([0, 1, 2, 3]));
console.log("vector2", m2.final("hex"));

const m3 = createMac("KMAC256", vectorKey, { customization: Buffer.from("My Tagged Application") });
m3.update(Buffer.from([0, 1, 2, 3]));
console.log("vector3", m3.final("hex"));

const key = createSecretKey(Buffer.alloc(16, 2));
const short = createMac("KMAC128", key, { outputLength: 4 });
short.update("abc");
console.log("outlen4", short.final("hex"));
const chunked = createMac("kmac-256", key, { outputLength: 64 });
chunked.update("ab");
chunked.update("c");
console.log("chunks", chunked.final("hex"));
console.log("alias", createMac("Kmac128", key).final("hex").length);
const zero = createMac("KMAC128", key, { outputLength: 0 });
zero.update("abc");
console.log("zero", JSON.stringify(zero.final("hex")));

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    const typed = error as Error & { code?: string };
    console.log(label, typed.name, typed.code, "|", typed.message);
  }
}

const longest = createMac("KMAC128", key, { customization: Buffer.alloc(512, 1), outputLength: 4 });
longest.update("abc");
console.log("custom512", longest.final("hex"));
attempt("custom513", () =>
  createMac("KMAC128", key, { customization: Buffer.alloc(513, 1) }),
);
attempt("short key", () => createMac("KMAC128", createSecretKey(Buffer.alloc(3))));
attempt("long key", () => createMac("KMAC128", createSecretKey(Buffer.alloc(513))));
attempt("digest option", () => createMac("KMAC128", key, { digest: "sha256" }));
attempt("huge output", () => createMac("KMAC-128", key, { outputLength: 2097152 }));
attempt("not a mac", () => createMac("nope", key));
const used = createMac("KMAC128", key);
used.final("hex");
attempt("final twice", () => used.final("hex"));
