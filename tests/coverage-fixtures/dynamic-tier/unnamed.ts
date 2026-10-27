// Dynamic loops that SC6101 does not name. `readEntries` loops over
// `unknown` values: the type name `Record` in its cast is not an untyped
// value. `readAll` catches into `Error` while a subclass of `Error` crosses
// into an `any` value, so its catch clause calls a generated check helper,
// which is not a source function.
function parse(text: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(text);
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readEntries(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const entries = parse(text)?.["entries"];
  if (entries === null || typeof entries !== "object") return out;
  for (const [name, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") continue;
    const e = raw as { dir?: unknown; label?: unknown };
    if (typeof e.dir !== "string") continue;
    out.set(name, typeof e.label === "string" ? `${e.dir}:${e.label}` : e.dir);
  }
  return out;
}

class ReadError extends Error {}

function readAll(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    try {
      if (text === "") throw new ReadError("empty");
      out.push(text);
    } catch (e) {
      out.push(`cannot read: ${(e as Error).message}`);
    }
  }
  return out;
}

const box: any = { error: new ReadError("boxed") };
console.log(readEntries('{"entries": {"a": {"dir": "x", "label": "y"}}}').size);
console.log(readAll(["one", ""]).join(", "), box.error.message);
