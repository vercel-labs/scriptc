// Localized failure, stage L2: pi-shaped declarations.
interface Token {
  text: string;
}
interface AgentMessage {
  role: "user" | "assistant";
  content: string[];
}
type CreateRuntime = (cwd: string) => Promise<{ session: Session; extra: Map<string, (x: number) => string> | AbortSignal }>;

class Session {
  messages: AgentMessage[] = [];
  // A field whose union mentions a stdlib type with no lowering: the class
  // registers; constructing a WeakRef would still be refused.
  cachedTokens?: WeakRef<{ source: string; tokens: Token[] }> | undefined;
  rendererState: any = {};
  effectState: Record<string, unknown> = {};
  private readonly createRuntime: CreateRuntime | undefined;
  constructor(createRuntime: CreateRuntime | undefined) {
    this.createRuntime = createRuntime;
  }
  hasRuntime(): boolean {
    return this.createRuntime !== undefined;
  }
  clear(): AgentMessage[] {
    // An inferred return over a spread clone.
    return this.messages.map((message) => ({ ...message, content: [] }));
  }
}

const s = new Session(undefined);
const withRuntime = new Session(async (cwd) => ({ session: s, extra: new Map() }));
s.messages.push({ role: "user", content: ["hi"] }, { role: "assistant", content: ["yo", "!"] });
s.rendererState.mode = "fast";
s.effectState["k"] = 3;
console.log(s.hasRuntime(), s.cachedTokens === undefined, s.rendererState.mode, s.effectState["k"]);
console.log(JSON.stringify(s.clear()), s.messages[1]!.content.length, withRuntime.hasRuntime());
