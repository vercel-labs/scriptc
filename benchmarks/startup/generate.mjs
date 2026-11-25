/* Writes the many-module program of the `startup-modules` workload into
 * modules/ beside this file: MODULES small typed modules in a dependency
 * graph and a main.ts that imports them all and prints one line.
 *
 *   node benchmarks/startup/generate.mjs           rewrite modules/
 *   node benchmarks/startup/generate.mjs --check   fail if modules/ differs
 *
 * The program does nothing after its modules have run, so its time to exit
 * is the cost of module initialization: the code every start pays before
 * the first line of the entry point. Each module's top level does one kind
 * of work that application modules do at load:
 *
 *   class      a class with a static member, and instances built at load
 *   registry   a Map filled at load, and handlers added to a shared registry
 *   table      an array of records with nested arrays
 *   text       strings built from imported constants, and regex literals
 *   names      a constant object and a Set, read at load
 *   closures   functions that capture module state, and a counter they bump
 *
 * and every sixteenth module also builds a regular expression from a string
 * at load, with a Unicode property class. The output is the same under
 * Node.js. Nothing here is random: the same generator writes the same
 * files. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODULES = 240;
const KINDS = ["class", "registry", "table", "text", "names", "closures"];
const out = join(import.meta.dirname, "modules");

/** The modules `i` imports: lower-numbered ones, so the graph has no cycle
 * and module 0 is a leaf everything reaches. */
function imports(i) {
  const deps = new Set();
  if (i > 0) deps.add(i - 1);
  if (i > 1) deps.add(i >> 1);
  if (i > 12) deps.add(i - 11);
  return [...deps].sort((a, b) => a - b);
}

const pad = (i) => String(i).padStart(3, "0");
const word = (i, j) => ["alpha", "bravo", "delta", "echo", "golf", "hotel", "india", "kilo"][(i * 3 + j * 5) % 8];

function body(i, kind) {
  const n = `M${pad(i)}`;
  switch (kind) {
    case "class":
      return `export class Shape${pad(i)} {
  static made = 0;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    Shape${pad(i)}.made++;
  }
  area(): number {
    return this.width * this.height;
  }
  scaled(factor: number): Shape${pad(i)} {
    return new Shape${pad(i)}(this.width * factor, this.height * factor);
  }
}
const unit = new Shape${pad(i)}(${1 + (i % 5)}, ${2 + (i % 3)});
const shapes: Shape${pad(i)}[] = [unit, unit.scaled(2), unit.scaled(3)];
let area = 0;
for (const shape of shapes) area += shape.area();
const own = area + Shape${pad(i)}.made;`;
    case "registry":
      return `const sizes = new Map<string, number>([
${Array.from({ length: 8 }, (_, j) => `  ["${word(i, j)}-${j}", ${(i * 7 + j * 13) % 97}],`).join("\n")}
]);
register("${n}.first", (x) => x + ${i % 9});
register("${n}.second", (x) => x * 2 + (sizes.get("${word(i, 3)}-3") ?? 0));
let total = 0;
for (const size of sizes.values()) total += size;
const own = total + sizes.size;`;
    case "table":
      return `interface Row${pad(i)} {
  id: number;
  name: string;
  weight: number;
  tags: string[];
}
const rows: Row${pad(i)}[] = [
${Array.from({ length: 12 }, (_, j) => `  { id: ${i * 100 + j}, name: "${word(i, j)}", weight: ${((i + 1) * (j + 3)) % 41}, tags: ["${word(j, i)}", "t${j % 4}"] },`).join("\n")}
];
let weight = 0;
for (const row of rows) weight += row.weight + row.tags.length + row.name.length;
const own = weight;`;
    case "text": {
      const pattern =
        i % 16 === 3
          ? `const marks = new RegExp(\`^[\${MARKS}]+\${"${word(i, 1)}".length}\`, "u");
const marked = marks.test("、!${word(i, 1).length}") ? 5 : 1;`
          : `const marked = 2;`;
      return `const title = PREFIX + "-" + "${word(i, 0)}" + "-" + String(${i});
const line = \`\${title}: \${"${word(i, 1)}".toUpperCase()} (\${title.length})\`;
const digits = /[0-9]+/;
const words = /^[a-z]+-[a-z]+-/;
${pattern}
const own = line.length + (digits.test(line) ? 3 : 0) + (words.test(title) ? 7 : 0) + marked;`;
    }
    case "names":
      return `const LEVELS = { ${Array.from({ length: 6 }, (_, j) => `${word(i, j)}${j}: ${(i + j * 11) % 53}`).join(", ")} } as const;
const known = new Set<string>(["${word(i, 0)}", "${word(i, 1)}", "${word(i, 2)}", "${word(i, 0)}"]);
let sum = 0;
for (const name of known) sum += name.length;
const own = sum + LEVELS.${word(i, 0)}0 + LEVELS.${word(i, 2)}2 + known.size;`;
    default:
      return `let calls = 0;
const step = ${1 + (i % 7)};
const bump = (by: number): number => {
  calls += by;
  return calls * step;
};
const twice = (f: (by: number) => number, by: number): number => f(by) + f(by);
const own = twice(bump, ${2 + (i % 4)}) + calls;`;
  }
}

function moduleSource(i) {
  const kind = KINDS[i % KINDS.length];
  const deps = imports(i);
  const lines = [`// Generated by benchmarks/startup/generate.mjs (${kind}). Do not edit.`];
  if (kind === "registry") lines.push(`import { register } from "./shared.ts";`);
  if (kind === "text") lines.push(`import { MARKS, PREFIX } from "./shared.ts";`);
  for (const d of deps) lines.push(`import { value${pad(d)} } from "./m${pad(d)}.ts";`);
  lines.push("", body(i, kind), "");
  const rest = deps.map((d) => ` + value${pad(d)}`).join("");
  lines.push(`export const value${pad(i)}: number = (own${rest}) % 1000003;`, "");
  return lines.join("\n");
}

const shared = `// Generated by benchmarks/startup/generate.mjs. Do not edit.
// What several modules share: a registry they add handlers to at load, and
// the parts of the strings and patterns they build.
export const handlers = new Map<string, (x: number) => number>();
export function register(name: string, handler: (x: number) => number): void {
  handlers.set(name, handler);
}
export const PREFIX = "unit";
export const MARKS =
  "\\\\s\\\\p{P}\\\\p{S}" +
  "${Array.from({ length: 16 }, (_, j) => `\\\\u${(0x3000 + j * 0x100).toString(16)}-\\\\u${(0x3000 + j * 0x100 + 0x7f).toString(16)}`).join("")}";
`;

const main = `// Generated by benchmarks/startup/generate.mjs. Do not edit.
// Every module runs before this file's first statement; the line it prints
// is one number folded from all of them.
import { handlers } from "./shared.ts";
${Array.from({ length: MODULES }, (_, i) => `import { value${pad(i)} } from "./m${pad(i)}.ts";`).join("\n")}

const values: number[] = [
${Array.from({ length: MODULES / 8 }, (_, r) => "  " + Array.from({ length: 8 }, (_, c) => `value${pad(r * 8 + c)},`).join(" ")).join("\n")}
];
let folded = 0;
for (const value of values) folded = (folded * 31 + value) % 1000003;
let handled = 0;
for (const handler of handlers.values()) handled = (handled + handler(3)) % 1000003;
console.log(\`modules \${values.length} handlers \${handlers.size} folded \${folded} handled \${handled}\`);
`;

const files = new Map([
  ["shared.ts", shared],
  ["main.ts", main],
]);
for (let i = 0; i < MODULES; i++) files.set(`m${pad(i)}.ts`, moduleSource(i));

if (process.argv.includes("--check")) {
  const present = existsSync(out) ? readdirSync(out).sort() : [];
  const wanted = [...files.keys()].sort();
  const stale = wanted.filter((f) => !present.includes(f) || readFileSync(join(out, f), "utf8") !== files.get(f));
  const extra = present.filter((f) => !files.has(f));
  if (stale.length > 0 || extra.length > 0) {
    console.error(`benchmarks/startup/modules is stale (${stale.length} differ, ${extra.length} extra); run node benchmarks/startup/generate.mjs`);
    process.exit(1);
  }
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(out, name), text);
  console.log(`wrote ${files.size} files to ${out}`);
}
