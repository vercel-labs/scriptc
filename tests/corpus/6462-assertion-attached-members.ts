// `route as Route & { order: number; internal: boolean }` followed by
// writes through the asserted view adds the members to the object the
// original binding names: they appear wherever the route is observed
// later, in the order the writes created them.
type HandleRoute = { handle: string; src?: string; dest?: string; status?: number };
type SourceRoute = { src: string; dest?: string; path?: string; status?: number };
type Route = HandleRoute | SourceRoute;

function markInternal(input: Route[], out: Route[], order: number): void {
  for (const route of input) {
    const marked = route as Route & { internal: boolean; order: number };
    marked.internal = true;
    marked.order = order;
    out.unshift(route);
  }
}

const out: Route[] = [{ handle: "filesystem" }, { src: "/plain", dest: "/x" }];
markInternal([{ src: "/a" }, { handle: "miss" }, { src: "/b", status: 404 }], out, 3);
console.log(JSON.stringify(out));
console.log(out);
console.log(out.map((r) => ("internal" in (r as Route & { internal?: boolean }) ? "marked" : "plain")));
console.log(out.map((r) => ({ ...r })));

// Values the assertion never reached keep no trace of the members.
const fresh: Route = { src: "/new" };
console.log(JSON.stringify(fresh), Object.keys(fresh));

// A single record shape works the same way, and the asserted view reads
// back what it wrote.
type Job = { id: string; retries?: number };
const job: Job = { id: "j1" };
const tracked = job as Job & { startedAt: number };
tracked.startedAt = 42;
console.log(tracked.startedAt + 1, JSON.stringify(job), Object.keys(job));

// An annotated binding of the asserted type keeps the object as well:
// the members appear on it once written, not before.
function stamp(job: Job): Job & { finishedAt: number } {
  const done: Job & { finishedAt: number } = job as Job & { finishedAt: number };
  done.finishedAt = 7;
  return done;
}
const second: Job = { id: "j2", retries: 1 };
console.log(stamp(second).finishedAt, JSON.stringify(second), Object.keys(second));

const third: Job = { id: "j3" };
const queued: Job & { queuedAt: number } = third as Job & { queuedAt: number };
queued.queuedAt = 9;
console.log(queued.queuedAt, JSON.stringify(third), Object.keys(third));

function markAnnotated(route: Route): void {
  const marked: Route & { internal: boolean } = route as Route & { internal: boolean };
  marked.internal = false;
}
const annotatedRoute: Route = { handle: "hit" };
markAnnotated(annotatedRoute);
console.log(JSON.stringify(annotatedRoute));
