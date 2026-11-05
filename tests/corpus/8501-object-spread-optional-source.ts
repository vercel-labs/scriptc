// A spread source the checker types `T | undefined` — the runtime-optional
// record ABI of callback parameters, an unchecked indexed read, and a for-of
// binding over a dense array. The source is present in every case here, so
// the required destination fields come from the record itself.
interface Rgb {
  r: number;
  g: number;
  b: number;
}
const BASIC: Rgb[] = [
  { r: 1, g: 2, b: 3 },
  { r: 4, g: 5, b: 6 },
  { r: 7, g: 8, b: 9 },
];
function basicColor(index: number): Rgb {
  if (index < 16) return { ...BASIC[index] };
  return { r: 0, g: 0, b: 0 };
}
for (const i of [0, 2]) {
  const color = basicColor(i);
  console.log("basic", i, color.r, color.g, color.b);
}

interface Entry {
  path: string;
  isDirectory: boolean;
}
const entries: Entry[] = [
  { path: "src", isDirectory: true },
  { path: "readme.md", isDirectory: false },
];
// Dense slice callbacks read through the runtime-optional record ABI.
const scored = entries.slice().map((entry) => ({ ...entry, score: entry.isDirectory ? 1 : 2 }));
for (const s of scored) console.log("scored", s.path, s.isDirectory, s.score);

type Source = { source: string; scope: "user" | "project" };
type Target = Source & { parsed: number };
const sources: Source[] = [
  { source: "a", scope: "user" },
  { source: "b", scope: "project" },
];
const parsed: Target[] = [];
for (const entry of sources) parsed.push({ ...entry, parsed: 1 });
for (const p of parsed) console.log("parsed", p.source, p.scope, p.parsed);

// A default first: the earlier contributor fills what the source can lack.
const defaults: Rgb = { r: 0, g: 0, b: 0 };
const merged = BASIC.slice().map((entry) => ({ ...defaults, ...entry }));
for (const m of merged) console.log("merged", m.r, m.g, m.b);
