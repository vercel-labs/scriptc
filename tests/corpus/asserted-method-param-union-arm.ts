// A reader written for two kinds of holder, listed as a reader of every kind
// through an assertion to the declared type. The assertion adds nothing the
// list's type does not say, so the entry converts as the unasserted one does:
// a holder whose `compat` was built as the third kind's record is read as the
// arm that declares the properties it has.
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
interface CompatMap {
  ka: CompatA;
  kb: CompatB;
  kc: CompatC;
}
type Kind = keyof CompatMap;
interface Holder<K extends Kind> {
  id: string;
  compat?: CompatMap[K];
}
interface Reader<K extends Kind = Kind> {
  id: string;
  read(holder: Holder<K>): string;
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

function reader(): Reader<"ka" | "kb"> {
  return { id: "r", read: (holder) => `${holder.id} ${describeCompat(holder.compat)}` };
}

function third(id: string, compat?: CompatC): Holder<Kind> {
  return { id, compat };
}

function holders(): Holder<Kind>[] {
  const first: CompatA = { a: true, shared: "s1", first: "f" };
  const second: CompatB = { b: "x", both: 1 };
  return [
    { id: "h1", compat: first },
    { id: "h2", compat: second },
    third("h3", {}),
    third("h4", { c: 3 }),
    third("h5", { c: 4, a: false }),
    third("h6", { shared: "s6", both: 7 }),
    third("h7"),
  ];
}

const readers: Reader[] = [reader() as Reader];
for (const holder of holders()) {
  console.log("listed", readers[0]!.read(holder));
}
