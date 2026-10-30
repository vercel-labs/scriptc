// Regex replace and replaceAll with inline callbacks, written as they
// usually are, without parameter annotations: template placeholders looked
// up in a dictionary, snake_case to camelCase, date reordering, optional
// version parts, capitalization and a string search with its offset.
let seed = 7;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

const words = ["user", "order", "item", "cart", "price", "total", "status", "created", "updated", "id"];
const names = ["Ada", "Grace", "Linus", "Barbara", "Ken", "Margaret"];
const vars: Record<string, string> = {
  name: "world",
  city: "Lisbon",
  day: "Tuesday",
  plan: "pro",
  count: "12",
};
const keys = [...Object.keys(vars), "missing"];

const scale = Number(process.argv[2] ?? "1");
const count = Math.floor(20000 * scale);
const templates: string[] = [];
const identifiers: string[] = [];
const dates: string[] = [];
const versions: string[] = [];
const sentences: string[] = [];
for (let i = 0; i < count; i++) {
  templates.push(`Hello {${pick(keys)}}, your {${pick(keys)}} plan renews on {${pick(keys)}} in {${pick(keys)}}.`);
  identifiers.push(`${pick(words)}_${pick(words)}_${pick(words)}${random() < 0.5 ? "_" + pick(words) : ""}`);
  const year = 1990 + Math.floor(random() * 40);
  const month = String(1 + Math.floor(random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(random() * 28)).padStart(2, "0");
  dates.push(`from ${year}-${month}-${day} to ${year + 1}-${month}-${day} (${pick(names)})`);
  versions.push(`v${i % 9}.${i % 13}${random() < 0.5 ? "." + (i % 7) : ""} and v${i % 5}.${i % 3}`);
  sentences.push(`${pick(names)} said the ${pick(words)} and the ${pick(words)} were ready for ${pick(names)}`);
}

let length = 0;
let checksum = 0;
for (let round = 0; round < 4; round++) {
  for (let i = 0; i < count; i++) {
    const filled = templates[i]!.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? `<${key}>`);
    const camel = identifiers[i]!.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    const reordered = dates[i]!.replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, m, d) => `${d}/${m}/${y}`);
    const padded = versions[i]!.replace(/v(\d+)\.(\d+)(?:\.(\d+))?/g, (_m, major, minor, patch) => `v${major}.${minor}.${patch ?? "0"}`);
    const titled = sentences[i]!.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    const marked = sentences[i]!.replaceAll("the", (m, at) => (at % 2 === 0 ? m.toUpperCase() : m));
    length += filled.length + camel.length + reordered.length + padded.length + titled.length + marked.length;
    checksum = (checksum * 31 + camel.charCodeAt(camel.length - 1) + padded.charCodeAt(padded.length - 1)) >>> 0;
  }
}
console.log(templates[0]!.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? `<${key}>`));
console.log(identifiers[1]!.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()));
console.log(versions[2]!.replace(/v(\d+)\.(\d+)(?:\.(\d+))?/g, (_m, major, minor, patch) => `v${major}.${minor}.${patch ?? "0"}`));
console.log("length", length, "checksum", checksum);
