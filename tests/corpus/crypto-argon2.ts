// crypto.argon2Sync and crypto.argon2: the three variants over fixed
// inputs, the secret and associated-data inputs, several memory, pass,
// parallelism and tag-length combinations (including a memory size that
// rounds down), the callback's later macrotask, and Node's argument and
// range errors.
import { argon2, argon2Sync } from "node:crypto";

const base = {
  message: "password",
  nonce: Buffer.alloc(16, 1),
  parallelism: 1,
  tagLength: 32,
  memory: 1024,
  passes: 2,
};

for (const algorithm of ["argon2d", "argon2i", "argon2id"]) {
  console.log(algorithm, argon2Sync(algorithm, base).toString("hex"));
}
console.log("secret", argon2Sync("argon2id", { ...base, secret: Buffer.alloc(8, 3) }).toString("hex"));
console.log("associated", argon2Sync("argon2id", { ...base, associatedData: Buffer.alloc(8, 4) }).toString("hex"));
console.log("bytes input", argon2Sync("argon2id", { ...base, message: Buffer.from("password") }).toString("hex"));
console.log("tag 4", argon2Sync("argon2id", { ...base, tagLength: 4 }).toString("hex"));
console.log("tag 64", argon2Sync("argon2id", { ...base, tagLength: 64 }).toString("hex"));
console.log("passes 3", argon2Sync("argon2id", { ...base, passes: 3 }).toString("hex"));
console.log("rounded memory", argon2Sync("argon2id", { ...base, memory: 1023 }).toString("hex"));
console.log(
  "parallel 4",
  argon2Sync("argon2id", { ...base, parallelism: 4, memory: 4096 }).toString("hex"),
);

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "resolved");
  } catch (error) {
    const typed = error as Error & { code?: string };
    console.log(label, typed.name, typed.code, "|", typed.message);
  }
}

attempt("missing message", () => argon2Sync("argon2id", { ...base, message: undefined } as unknown as Parameters<typeof argon2Sync>[1]));
attempt("short nonce", () => argon2Sync("argon2id", { ...base, nonce: Buffer.alloc(4) }));
attempt("bad algorithm", () => argon2Sync("argon3", base));
attempt("parallelism 0", () => argon2Sync("argon2id", { ...base, parallelism: 0 }));
attempt("memory 4", () => argon2Sync("argon2id", { ...base, memory: 4 }));
attempt("memory under parallelism", () =>
  argon2Sync("argon2id", { ...base, parallelism: 2, memory: 8 }),
);
attempt("tag 0", () => argon2Sync("argon2id", { ...base, tagLength: 0 }));
attempt("passes 0", () => argon2Sync("argon2id", { ...base, passes: 0 }));
attempt("callback not a function", () => argon2("argon2id", base, 5 as never));
attempt("invalid secret", () =>
  argon2(
    "argon2id",
    { ...base, secret: 5 } as unknown as Parameters<typeof argon2Sync>[1],
    () => console.log("secret callback ran"),
  ),
);
attempt("invalid associated data", () =>
  argon2(
    "argon2id",
    { ...base, associatedData: 5 } as unknown as Parameters<typeof argon2Sync>[1],
    () => console.log("associated callback ran"),
  ),
);

const expected = argon2Sync("argon2id", base).toString("hex");
let returned = false;
argon2("argon2id", base, (error, result) => {
  console.log("callback", returned, error, result?.toString("hex") === expected);
});
returned = true;
process.nextTick(() => console.log("tick"));
console.log("returned");
