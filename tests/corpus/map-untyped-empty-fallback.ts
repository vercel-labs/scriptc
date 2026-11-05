// An untyped `new Map()` in a `??` fallback literal: the fallback builds
// as the left operand's record, so the empty map takes its key and value
// types. `new Map(result.errors)` then copies a typed map, and writes to
// the copy (directly and from a callback) keep that layout.

interface RefreshResult {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}

async function refresh(fail: boolean): Promise<RefreshResult | undefined> {
  if (fail) return undefined;
  const errors = new Map<string, Error>();
  errors.set("openai", new Error("boom"));
  return { aborted: false, errors };
}

async function run(fail: boolean, providers: string[]): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
  const result = (await refresh(fail)) ?? { aborted: fail, errors: new Map() };
  const errors = new Map(result.errors);
  errors.set("local", new Error("extra"));
  await Promise.all(
    providers.map(async (provider) => {
      if (provider.startsWith("bad")) errors.set(provider, new Error(`${provider} failed`));
    }),
  );
  return { aborted: result.aborted, errors };
}

async function main(): Promise<void> {
  for (const fail of [false, true]) {
    const r = await run(fail, ["ok", "bad-a", "bad-b"]);
    const names = [...r.errors.keys()].sort().join(",");
    console.log(r.aborted, names, r.errors.get("local")?.message, r.errors.get("bad-b")?.message);
  }
  const source = new Map<string, number>([["a", 1]]);
  const copy = new Map(source);
  copy.set("b", 2);
  console.log(source.size, copy.size, copy !== source);
}
void main();
