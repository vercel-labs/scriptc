// `Array.prototype.map` whose callback answers a CLOSURE: the result is an
// array of functions (`Array<() => Promise<T>>`, the runWithConcurrency
// task-list shape), each element one ScrClosure stored by reference.
interface Entry {
  source: string;
  scope: "user" | "project";
}

function tasksFor(entries: Entry[]): Array<() => Promise<string>> {
  return entries.map((entry) => async () => `${entry.scope}:${entry.source}`);
}

function same(entries: Entry[]): Array<() => string> {
  return entries.map((entry) => () => entry.source);
}

async function main(): Promise<void> {
  const entries: Entry[] = [
    { source: "a", scope: "user" },
    { source: "b", scope: "project" },
  ];
  const tasks = tasksFor(entries);
  for (const task of tasks) console.log("task", await task());

  const readers = same(entries);
  // A function value is one closure for its whole life: identity through
  // indexOf/includes holds.
  const first = readers[0];
  console.log("identity", readers.indexOf(first!), readers.includes(first!));
  if (first) console.log("called", first());

  const inline = entries.map((entry) => () => entry.source.length);
  console.log("inline", inline.map((read) => read()).join(","));

  const results = await Promise.all(tasks.map((task) => task()));
  console.log("all", results.join(","));
}
void main();
