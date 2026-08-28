// 2713 catch binding full: any/unknown bindings read .message/.name/.stack/.type without narrowing
try {
  throw new TypeError("type fail");
} catch (err: any) {
  console.log(err.message);
  console.log(err.name);
  console.log(err.stack ? "has-stack" : "no-stack");
  console.log(err?.type ?? "no-type");
}

try {
  throw new RangeError("range fail");
} catch (err: unknown) {
  console.log((err as Error).message);
  console.log((err as Error).name);
  const e = err as Error;
  console.log(e.stack ? "has-stack" : "no-stack");
  console.log((err as { type?: unknown })?.type ?? "no-type-any");
}

try {
  throw new Error("plain");
} catch (err: any) {
  console.log(typeof err.message);
  console.log(typeof err.name);
  console.log(err.stack ? "has-stack" : "no-stack");
  console.log(err?.type);
}

try {
  throw "bare string";
} catch (err: any) {
  console.log(String(err));
  console.log(err?.message ?? String(err));
}

try {
  throw 42;
} catch (err: unknown) {
  console.log(String(err));
  console.log(err instanceof Error ? err.message : String(err));
}
