// Map/Set-heavy text and graph processing: word frequencies, bigrams,
// and breadth-first search over a string-keyed adjacency map.
let seed = 555;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
const syllables = ["ka", "lo", "mi", "ne", "ru", "sa", "to", "vi", "ze", "po", "qu", "ex"];
function word(): string {
  const n = 1 + Math.floor(random() * 3);
  let w = "";
  for (let i = 0; i < n; i++) w += syllables[Math.floor(random() * syllables.length)]!;
  return w;
}

const scale = Number(process.argv[2] ?? "1");
const text: string[] = [];
for (let i = 0; i < Math.floor(300000 * scale); i++) text.push(word());

const freq = new Map<string, number>();
for (const w of text) freq.set(w, (freq.get(w) ?? 0) + 1);
const bigrams = new Map<string, number>();
for (let i = 1; i < text.length; i++) {
  const key = text[i - 1]! + " " + text[i]!;
  bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
}
const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
console.log("words", freq.size, "bigrams", bigrams.size, "top", top.map((e) => e[0] + ":" + e[1]).join(","));

const graph = new Map<string, string[]>();
for (let i = 1; i < text.length; i += 3) {
  const from = text[i - 1]!;
  const to = text[i]!;
  const edges = graph.get(from);
  if (edges === undefined) graph.set(from, [to]);
  else if (edges.length < 8) edges.push(to);
}
let reachable = 0;
let depthSum = 0;
const starts = [...graph.keys()].sort().slice(0, 60);
for (const start of starts) {
  const seen = new Set<string>([start]);
  let frontier = [start];
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of graph.get(node) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    depth++;
  }
  reachable += seen.size;
  depthSum += depth;
}
console.log("reachable", reachable, "depth", depthSum);
