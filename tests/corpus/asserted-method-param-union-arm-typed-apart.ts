// A provider written for two kinds of model, listed as a provider of every
// kind through an assertion. Its two `compat` records give the shared member
// `f` different types, so which properties a model has cannot say which
// record it is: the member's value does. The asserted entry is checked value
// by value when a method is called, and each model is read as the record its
// `f` fits.
interface CompatA {
  f?: number;
  a?: boolean;
}
interface CompatB {
  f?: string;
  b?: string;
}
interface CompatC {
  f?: number | string;
  c?: boolean;
}
interface CompatMap {
  ka: CompatA;
  kb: CompatB;
  kc: CompatC;
}
type Kind = keyof CompatMap;
interface Model<K extends Kind> {
  id: string;
  kind: K;
  compat?: CompatMap[K];
}
interface Provider<K extends Kind = Kind> {
  id: string;
  describe(model: Model<K>): string;
}

function twoKinds(): Provider<"ka" | "kb"> {
  return {
    id: "two",
    describe: (model) =>
      `${model.id} ${model.compat === undefined ? "none" : `${typeof model.compat.f} ${JSON.stringify(model.compat)}`}`,
  };
}

function third(id: string, compat?: CompatC): Model<Kind> {
  return { id, kind: "kc", compat };
}

const providers: Provider[] = [twoKinds() as Provider];
const first: CompatA = { f: 7, a: true };
const second: CompatB = { f: "s", b: "t" };
const models: Model<Kind>[] = [
  { id: "m1", kind: "ka", compat: first },
  { id: "m2", kind: "kb", compat: second },
  third("m3", { f: 1 }),
  third("m4", { f: "x" }),
  third("m5", {}),
  third("m6", { c: true }),
  third("m7"),
];
for (const model of models) console.log(providers[0]!.describe(model));
