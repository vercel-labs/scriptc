// A provider written for two kinds of model, listed as a provider of every
// kind. A model built as the third kind converts when its properties say
// which of the provider's two `compat` records it is. Here they cannot: one
// record requires `level` and the other declares it optional, so the copy
// into the first is a checked extraction that throws for a model without
// `level`, which the second record holds. Records that keep a property at
// different types are not told apart by which properties a value has, and the
// list entry stays refused.
interface CompatA {
  level: number;
  first?: string;
}
interface CompatB {
  level?: number;
  second?: string;
}
interface CompatC {
  level?: number;
  first?: string;
  second?: string;
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

function describeCompat(compat: CompatA | CompatB | undefined): string {
  if (compat === undefined) return "none";
  const parts: string[] = [`level=${compat.level}`];
  if ("first" in compat) parts.push(`first=${compat.first}`);
  if ("second" in compat) parts.push(`second=${compat.second}`);
  parts.push(JSON.stringify(compat), `[${Object.keys(compat).join("+")}]`);
  return parts.join(" ");
}

function twoKinds(): Provider<"ka" | "kb"> {
  return {
    id: "two",
    describe: (model) => `${model.id} ${model.kind} ${describeCompat(model.compat)}`,
  };
}

function third(id: string, compat?: CompatC): Model<Kind> {
  return { id, kind: "kc", compat };
}

function models(): Model<Kind>[] {
  const first: CompatA = { level: 1, first: "f1" };
  const second: CompatB = { second: "s2" };
  return [
    { id: "m1", kind: "ka", compat: first },
    { id: "m2", kind: "kb", compat: second },
    third("m3", {}),
    third("m4", { level: 4 }),
    third("m5", { level: 5, first: "f5" }),
    third("m6", { level: 6, second: "s6" }),
    third("m7", { second: "s7" }),
    third("m8", { c: true }),
    third("m9", { level: undefined }),
    third("m10"),
  ];
}

const providers: Provider[] = [twoKinds()];
for (const model of models()) console.log(providers[0]!.describe(model));
