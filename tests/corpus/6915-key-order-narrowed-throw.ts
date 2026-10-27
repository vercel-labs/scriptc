// A record whose reads narrow a possibly-undefined binding (the narrowing
// ternary's throw arm stands in for a value of the record's type) still
// takes its literal's key order: a module-level accumulator typed by an
// interface declared in another order, as an event batcher builds it.
interface Entry {
  id: string;
  at: number;
  text?: string;
  stream: "out" | "err";
}
interface Batch {
  team: string;
  project: string;
  job: string;
  origin: "task" | "worker";
  host: string;
  entries: Entry[];
  sizes?: number[];
  stage?: "live" | "staging";
  branch?: string;
  run?: string;
  entry?: string;
  path?: string;
}
interface Job {
  id: string;
  run?: string;
  project: string;
  team: string;
  host: string;
  stage: string | null;
}
let acc: Batch | undefined;

function append(j: Job, text: string): void {
  if (!acc) {
    acc = {
      run: j.run,
      job: j.id,
      stage: j.stage === null ? "staging" : "live",
      project: j.project,
      team: j.team,
      origin: "task",
      host: j.host,
      entry: ".",
      entries: [],
    };
  }
  acc.entries.push({ id: String(acc.entries.length), at: 1, text, stream: "out" });
  setTimeout(() => {
    const batch = acc;
    if (!batch) return;
    acc = undefined;
    for (const line of split(batch)) console.log(line);
  }, 1);
}

function split(batch: Batch): string[] {
  const json = JSON.stringify(batch);
  if (json.length < 200 || batch.entries.length < 2) return [json];
  const index = Math.floor(batch.entries.length / 2);
  const first = { ...batch, entries: batch.entries.slice(0, index) };
  const second = { ...batch, entries: batch.entries.slice(index) };
  return [...split(first), ...split(second)];
}

const j: Job = { id: "job", run: "r1", project: "prj", team: "core", host: "h", stage: "live" };
append(j, "one");
append(j, "two");
setTimeout(() => {
  for (let i = 0; i < 6; i++) append(j, "line " + i);
}, 5);
