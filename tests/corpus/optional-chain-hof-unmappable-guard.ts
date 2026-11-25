// The optional-read analysis answers its chain-tail question for every file
// before any body lowers. A HOF call on a guarded chain whose receiver union
// has an arm the lowering cannot map (`T | undefined` here) used to reach the
// identifier arm of that question with no function context, which threw
// "lowerer bug: no active function context". The pre-pass must answer through
// the storage it can read (module globals) and leave the local binding to the
// body lowering that owns it.
interface Catalogue {
  models: string[];
}

function found<T extends Catalogue>(entry: T | undefined, want: string): boolean {
  return entry?.models.some((model) => model === want) ?? false;
}

function firstMatch<T extends Catalogue>(entry: T | undefined, want: string): string | undefined {
  return entry?.models.find((model) => model === want);
}

function only<T extends Catalogue>(entry: T | undefined, want: string): string[] {
  return entry?.models.filter((model) => model === want) ?? [];
}

const present: Catalogue = { models: ["alpha", "beta"] };
const empty: Catalogue = { models: [] };

console.log(found(present, "beta"), found(present, "gamma"), found(undefined, "alpha"));
console.log(firstMatch(present, "alpha"), firstMatch(present, "delta"));
console.log(firstMatch(undefined, "alpha"));
console.log(only(present, "beta").join(","), only(empty, "beta").length, only(undefined, "alpha").length);
