// Case C by its origins, but the program observes the values as whole objects.
interface Task { id: number; run(): string }
class Fast implements Task { id: number; tag = "f"; constructor(id: number) { this.id = id; } run(): string { return `fast${this.id}`; } }
class Slow implements Task { id: number; wait = 3; constructor(id: number) { this.id = id; } run(): string { return `slow${this.id}`; } }
const tasks: Task[] = [new Fast(1), new Slow(2), new Fast(3)];
console.log(JSON.stringify(tasks[0]), JSON.stringify(tasks), Object.keys(tasks[1]!).join("|"));
console.log(tasks[1]);
console.log("wait" in tasks[1]!, "wait" in tasks[0]!, Object.entries(tasks[2]!).length);
for (const key in tasks[0]!) console.log(key);
const copy = { ...tasks[1]! };
console.log(Object.keys(copy).join(","), tasks.map((t) => t.run()).join(","), tasks[0] instanceof Fast);
