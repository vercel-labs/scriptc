// Catch bindings typed any, multi-statement guards over catch bindings,
// and writes into a caught error.
interface SafeFetchError extends Error {
  kind: "safe-fetch";
  host: string;
}
function isSafeFetchError(e: unknown): e is SafeFetchError {
  if (!(e instanceof Error)) return false;
  return "kind" in e && e.kind === "safe-fetch";
}
function blocked(host: string): Error {
  return Object.assign(new Error(`blocked ${host}`), { kind: "safe-fetch", host });
}
function run(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (err) {
    if (isSafeFetchError(err)) return `guarded ${err.host} ${err.message}`;
    return `other ${err instanceof Error ? err.message : String(err)}`;
  }
}
console.log(run(() => {}));
console.log(run(() => {
  throw blocked("example.com");
}));
console.log(run(() => {
  throw new Error("plain");
}));
console.log(run(() => {
  throw "text";
}));

function annotate(fn: () => void): void {
  try {
    fn();
  } catch (e: any) {
    e.message = `config: ${e.message}`;
    if (e.code === "ENOPE") e.hint = "check the file";
    throw e;
  }
}
for (const code of ["ENOPE", "EOTHER"]) {
  try {
    annotate(() => {
      throw Object.assign(new Error("missing"), { code });
    });
  } catch (e) {
    const err = e as Error & { code?: string; hint?: string };
    console.log(err.message, err.code, err.hint, err instanceof Error);
  }
}

// An assertion on a catch binding typed any.
function codeOf(fn: () => void): string {
  try {
    fn();
    return "none";
  } catch (e: any) {
    const err = e as Error & { code?: string };
    return `${err.message}:${err.code ?? "-"}`;
  }
}
console.log(
  codeOf(() => {
    throw Object.assign(new Error("coded"), { code: "E1" });
  }),
  codeOf(() => {}),
);
