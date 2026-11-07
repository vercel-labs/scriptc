// Case C at the edges: unknown, JSON, errors, sorting, async.
interface Task { id: number; run(): string; cost(): number }
class Fast implements Task { id: number; constructor(id: number) { this.id = id; } run(): string { return `fast${this.id}`; } cost(): number { return 1; } }
class Slow implements Task { id: number; constructor(id: number) { this.id = id; } run(): string { return `slow${this.id}`; } cost(): number { return 9; } }
function make(i: number): Task { return i % 2 === 0 ? new Fast(i) : new Slow(i); }
const tasks: Task[] = [];
for (let i = 0; i < 6; i++) tasks.push(make(i));
tasks.sort((x, y) => y.cost() - x.cost() || x.id - y.id);
console.log(tasks.map((t) => t.run()).join(","));
// to unknown and back to the class
const box: unknown = tasks[0];
console.log(box instanceof Slow, box === tasks[0], typeof box);
if (box instanceof Slow) console.log(box.run());
console.log(tasks[0] !== tasks[1], tasks[0]!.id, tasks[1]!.cost());
// async and promises
async function later(t: Task): Promise<Task> { return t; }
async function main(): Promise<void> {
  const t = await later(tasks[4]!);
  console.log(t === tasks[4], t.run());
  const all = await Promise.all(tasks.slice(0, 2).map((x) => later(x)));
  console.log(all.map((x) => x.id).join(","));
}
// thrown and caught
function fail(t: Task): never { throw new Error(`no ${t.run()}`); }
try { fail(tasks[5]!); } catch (e) { console.log((e as Error).message); }
// a method called on an absent value throws as in Node
function first(list: Task[]): Task | undefined { return list[10]; }
try { console.log(first(tasks)!.run()); } catch (e) { console.log(e instanceof TypeError); }
// records holding the interface
interface Job { task: Task; label: string }
const jobs: Job[] = tasks.map((task, i) => ({ task, label: `j${i}` }));
console.log(jobs.map((j) => `${j.label}=${j.task.cost()}`).join(" "), jobs[0]!.task === tasks[0]);
const byId: Record<string, Task> = {};
for (const t of tasks) byId[String(t.id)] = t;
console.log(Object.keys(byId).join(","), byId["3"]!.run(), byId["3"] === tasks.find((t) => t.id === 3));
await main();
