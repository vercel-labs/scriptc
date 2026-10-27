// Localized failure, stage L2: fields, parameters and returns whose
// declared type has no static lowering become checked dynamic slots, so
// their class or function still compiles.
interface ToolDefinition {
  name: string;
  execute(id: string, params: any): string;
}
type Progress = (done: number, total: number) => void;
type ProgressOrSignal = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;

class Session {
  // A field: the class registers, the field holds the array by reference.
  private tools: ToolDefinition[] = [];
  state: any = { count: 0 };
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  add(tool: ToolDefinition): void {
    this.tools.push(tool);
  }
  run(id: string, params: unknown): string[] {
    const out: string[] = [];
    for (const tool of this.tools) out.push(tool.execute(id, params));
    this.state.count = this.state.count + 1;
    return out;
  }
  count(): number {
    return this.tools.length;
  }
  // A return slot.
  first(): ToolDefinition | ProgressOrSignal | undefined {
    return this.tools[0];
  }
}

// A parameter: the function registers and is called from typed code.
function listAll(dir: string, onProgress?: ProgressOrSignal): number {
  if (typeof onProgress === "function") onProgress(1, dir.length);
  else if (onProgress instanceof Set) return onProgress.size;
  return dir.length;
}

// A base class with a dynamic parameter, and an override.
class Base {
  notify(target: ProgressOrSignal | undefined): string {
    return target === undefined ? "base:none" : "base:" + typeof target;
  }
}
class Derived extends Base {
  override notify(target: ProgressOrSignal | undefined): string {
    return "derived/" + super.notify(target);
  }
}

const echo: ToolDefinition = { name: "echo", execute: (id, params) => `${id}:${JSON.stringify(params)}` };
const s = new Session("main");
s.add(echo);
s.add({ name: "len", execute: (id) => String(id.length) });
console.log(s.label, s.count(), s.run("abc", { k: 1 }).join(" | "), s.state.count);
console.log("same tool", s.first() === echo);
console.log(listAll("hello"), listAll("hello", (d, t) => console.log("progress", d, t)), listAll("x", new Set([1, 2])));
const objs: Base[] = [new Base(), new Derived()];
for (const o of objs) console.log(o.notify(undefined), o.notify((a, b) => a + b));
