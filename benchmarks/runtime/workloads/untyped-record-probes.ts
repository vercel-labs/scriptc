// A parts catalogue printed as an outline by a walker that takes `unknown`.
// The catalogue is built from typed records and arrays; the walker finds out
// what each value is the way generic printers and serializers do: `typeof`,
// `Array.isArray`, a `describe` hook and a `hidden` flag that no part has,
// `"unit" in value`, a for-in over the attribute record guarded by
// `hasOwnProperty`, and keyed reads of the fields it prints. Most probes ask
// a record for a member it does not have.
type Attributes = { colour: string; grade: number; batch: string; tested: boolean };
type Part = { name: string; quantity: number; unit?: string; attributes: Attributes; parts: Part[] };

const scale = Number(process.argv[2] ?? "1");

const colours = ["red", "green", "blue", "grey"];
let seed = 20240;

function next(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed >>> 8;
}

function build(depth: number, label: string): Part {
  const parts: Part[] = [];
  if (depth > 0) {
    for (let i = 0; i < 3; i++) parts.push(build(depth - 1, label + "." + i));
  }
  const roll = next();
  const part: Part = {
    name: label,
    quantity: 1 + (roll % 9),
    attributes: { colour: colours[roll & 3]!, grade: (roll >>> 2) % 5, batch: "b<" + (roll % 97) + ">", tested: (roll & 16) !== 0 },
    parts,
  };
  if ((roll & 32) !== 0) part.unit = "kg";
  return part;
}

function escapeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    out += ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : ch;
  }
  return out;
}

function attributeText(attributes: any): string {
  let out = "";
  for (const key in attributes) {
    if (!Object.prototype.hasOwnProperty.call(attributes, key)) continue;
    const value = attributes[key];
    if (value === undefined || value === false) continue;
    out += " " + key + "=" + (typeof value === "string" ? escapeText(value) : String(value));
  }
  return out;
}

function hasHook(value: any): boolean {
  return typeof value === "object" && value !== null && typeof value.describe === "function";
}

function isDeferred(value: any): boolean {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}

function print(value: any, indent: string): string {
  if (typeof value === "string") return indent + escapeText(value) + "\n";
  if (typeof value === "number") return indent + String(value) + "\n";
  if (value === null || value === undefined) return "";
  if (hasHook(value) || isDeferred(value)) return indent + "?\n";
  if (Array.isArray(value)) {
    let out = "";
    for (let i = 0; i < value.length; i++) out += print(value[i], indent);
    return out;
  }
  if (typeof value !== "object" || value instanceof Error) return "";
  if (value.hidden === true) return "";
  let line = indent + String(value.name) + " x" + String(value.quantity);
  if ("unit" in value) line += String(value.unit);
  if (value.note !== undefined) line += " (" + String(value.note) + ")";
  line += attributeText(value.attributes);
  return line + "\n" + print(value.parts, indent + "  ");
}

const rounds = Math.floor(3000 * scale);
let bytes = 0;
let checksum = 0;
let last = "";
for (let round = 0; round < rounds; round++) {
  const catalogue: unknown = build(3, "p" + (round % 7));
  last = print(catalogue, "");
  bytes += last.length;
  checksum = (checksum + last.charCodeAt(round % last.length) * (round + 1)) % 1000000007;
}
console.log("rounds", rounds, "bytes", bytes, "checksum", checksum);
console.log(last.slice(0, 200));
