// Functional collection pipelines: map/filter/reduce/flatMap chains,
// closures capturing configuration, and small intermediate objects.
interface Event {
  user: number;
  kind: string;
  value: number;
  time: number;
}
interface Point {
  x: number;
  y: number;
}
interface Scored {
  user: number;
  score: number;
}

let seed = 4242;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
const kinds = ["view", "click", "purchase", "share"];
function makeEvents(count: number): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ user: Math.floor(random() * 5000), kind: kinds[Math.floor(random() * kinds.length)]!, value: Math.floor(random() * 1000), time: i });
  }
  return events;
}

function makeScorer(weight: number, bonus: number): (e: Event) => number {
  return (e) => (e.kind === "purchase" ? e.value * weight + bonus : e.kind === "click" ? weight : 0);
}

const scale = Number(process.argv[2] ?? "1");
const events = makeEvents(Math.floor(200000 * scale));
let total = 0;
for (let round = 0; round < 5; round++) {
  const scorer = makeScorer(round + 1, round * 10);
  const scored: Scored[] = events
    .filter((e) => e.time % 5 !== round)
    .map((e) => ({ user: e.user, score: scorer(e) }))
    .filter((s) => s.score > 0);
  total += scored.reduce((sum, s) => sum + s.score, 0);
  const pairs = events.slice(0, 20000).flatMap((e) => (e.kind === "share" ? [e.user, e.value] : []));
  total += pairs.length;
  const points: Point[] = events.slice(0, 50000).map((e) => ({ x: e.value / 10, y: e.user / 100 }));
  const centroid = points.reduce((acc: Point, p: Point): Point => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  total += Math.round(centroid.x + centroid.y);
  const some = events.some((e) => e.value === 999 - round);
  const every = events.every((e) => e.value >= 0);
  const found = events.findIndex((e) => e.user === 4999 - round);
  total += (some ? 1 : 0) + (every ? 1 : 0) + found;
}
console.log("total", total);
