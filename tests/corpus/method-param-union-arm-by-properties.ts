// A provider written for two kinds of model is listed as a provider of every
// kind (TypeScript admits it through method parameter bivariance), so its
// methods receive models whose `compat` was built as the third kind's record.
// The records have only optional members: such a value is every arm at once,
// and the properties it has decide which arm the method reads it as.
interface CompatA {
  a?: boolean;
  shared?: string;
  first?: string;
}
interface CompatB {
  b?: string;
  shared?: string;
  both?: number;
}
interface CompatC {
  c?: number;
  shared?: string;
  a?: boolean;
  both?: number;
}
// Every member of the first kind's record, and one of the second's.
interface CompatD {
  a?: boolean;
  shared?: string;
  first?: string;
  both?: number;
}
interface CompatMap {
  ka: CompatA;
  kb: CompatB;
  kc: CompatC;
  kd: CompatD;
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
  check?(model: Model<K>, note: string): Promise<string>;
}

function describeCompat(compat: CompatA | CompatB | undefined): string {
  if (compat === undefined) return "none";
  const parts: string[] = [];
  if ("a" in compat) parts.push(`a=${compat.a}`);
  if ("b" in compat) parts.push(`b=${compat.b}`);
  if ("both" in compat) parts.push(`both=${compat.both}`);
  if ("first" in compat) parts.push(`first=${compat.first}`);
  if (compat.shared !== undefined) parts.push(`shared=${compat.shared}`);
  parts.push(JSON.stringify(compat), `[${Object.keys(compat).join("+")}]`);
  return parts.join(" ");
}

function twoKinds(): Provider<"ka" | "kb"> {
  return {
    id: "two",
    describe: (model) => `${model.id} ${model.kind} ${describeCompat(model.compat)}`,
    check: async (model, note) => `${note}: ${model.id} ${describeCompat(model.compat)}`,
  };
}

function oneKind(): Provider<"kb"> {
  return {
    id: "one",
    describe: (model) =>
      `${model.id} ${model.kind} ${model.compat === undefined ? "none" : `b=${model.compat.b} both=${model.compat.both} shared=${model.compat.shared} ${JSON.stringify(model.compat)}`}`,
  };
}

function providers(): Provider[] {
  return [twoKinds(), oneKind()];
}

function third(id: string, compat?: CompatC): Model<Kind> {
  return { id, kind: "kc", compat };
}

function fourth(id: string, compat?: CompatD): Model<Kind> {
  return { id, kind: "kd", compat };
}

function models(): Model<Kind>[] {
  const first: CompatA = { a: true, shared: "s1", first: "f" };
  const second: CompatB = { b: "x", both: 1 };
  return [
    { id: "m1", kind: "ka", compat: first },
    { id: "m2", kind: "kb", compat: second },
    third("m3", {}),
    third("m4", { c: 3 }),
    third("m5", { c: 4, shared: "s5" }),
    third("m6", { a: false }),
    third("m7", { shared: "s7", both: 7 }),
    third("m8", { a: undefined }),
    third("m9"),
    fourth("m10", { first: "f10" }),
    fourth("m11", { both: 11 }),
    fourth("m12", { shared: "s12", both: 12 }),
    fourth("m13", {}),
  ];
}

async function main(): Promise<void> {
  const all = providers();
  const two = all[0]!;
  for (const model of models()) {
    console.log(two.id, two.describe(model));
    if (two.check) console.log(await two.check(model, "checked"));
  }
  // A provider of one kind: every other arm has one home, whatever it holds
  // of the members that arm declares.
  const one = all[1]!;
  for (const model of models()) {
    if (model.kind === "ka") continue;
    console.log(one.id, one.describe(model), one.check === undefined);
  }
}
main();
