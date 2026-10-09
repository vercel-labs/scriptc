// A non-null assertion has no runtime effect. A class value asserted with
// `!` and passed along (directly, or through a binding) still holds
// undefined when the assertion was wrong: a callee that tests other
// arguments first, compares it, or forwards it observes undefined, and only
// a member read throws Node's TypeError.

class Task {
  priority: number;
  parent: Task | undefined = undefined;
  constructor(priority: number) {
    this.priority = priority;
  }
  describe(): string {
    return `task(${this.priority})`;
  }
}

class Scheduler {
  urgentChild(task: Task, parent: Task): boolean {
    return task.priority > 5 && parent.priority < task.priority;
  }
}

class StrictScheduler extends Scheduler {
  urgentChild(task: Task, parent: Task): boolean {
    return task.priority < 3 && parent !== undefined;
  }
}

function isUrgentChild(task: Task, parent: Task): boolean {
  return task.priority > 5 && parent.priority < task.priority;
}

function sameTask(a: Task, b: Task): boolean {
  return a === b;
}

function relay(a: Task, b: Task): boolean {
  return sameTask(a, b);
}

function priorityOf(task: Task): number {
  return task.priority;
}

const low = new Task(1);
const parent = low.parent!;
console.log(isUrgentChild(low, parent));
console.log(isUrgentChild(low, low.parent!));
console.log(new Scheduler().urgentChild(low, low.parent!));
const schedulers: Scheduler[] = [new Scheduler(), new StrictScheduler()];
for (const s of schedulers) console.log(s.urgentChild(low, parent), s.urgentChild(new Task(2), parent));
console.log(sameTask(low, low.parent!), sameTask(low, low));
console.log(relay(low, parent));

// Comparing, reassigning and optional or defaulted parameters see the
// stored undefined too.
console.log(parent === undefined, parent !== undefined, parent == null);
console.log(low.parent! === undefined, low.parent! === low);
let cursor: Task = low;
cursor = low.parent!;
console.log(cursor === undefined);
function withFallback(task: Task, fallback: Task = low): number {
  return task.priority + fallback.priority;
}
function hasParent(task: Task, parentTask?: Task): boolean {
  return parentTask !== undefined;
}
console.log(withFallback(low, low.parent!), hasParent(low, low.parent!));
const pending: Task[] = [];
const head = pending[0];
console.log(head === undefined, head == null);

// A present value flows unchanged.
const high = new Task(9);
high.parent = low;
console.log(isUrgentChild(high, high.parent!));
console.log(priorityOf(high.parent!), sameTask(high.parent!, low));

const registry = new Map<string, Task>();
registry.set("high", high);
console.log(isUrgentChild(low, registry.get("missing")!));
console.log(priorityOf(registry.get("high")!));

// Dereferencing the asserted value is where JavaScript throws.
try {
  console.log(priorityOf(registry.get("missing")!));
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
try {
  console.log(parent.describe());
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
