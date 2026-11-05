// Lowering erases flow narrowing, so a checker-NARROWED receiver still
// stores its wider union. A member read dispatches on the arm the value
// actually holds: an arm that declares the member answers its slot, an arm
// that does not answers undefined (Node's get), and an arm the narrowing
// ruled out traps in the checked conversion.
interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}
interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}
type Credential = ApiKeyCredential | OAuthCredential;

function pick(stored: Credential | undefined): string | undefined {
  if (stored?.type === "oauth") return stored.access;
  const credential = stored?.type === "api_key" ? stored : undefined;
  return credential?.key;
}
console.log("key", pick({ type: "api_key", key: "k1" }));
console.log("key absent", pick({ type: "api_key" }));
console.log("oauth", pick({ type: "oauth", access: "a1", refresh: "r1", expires: 1 }));
console.log("none", pick(undefined));

// An assertion narrows the checker's view of arms that carry different
// payloads; every arm declares the asserted member here.
interface Message {
  role: string;
  content: string;
}
interface ToolResult {
  role: string;
  output: string[];
}
type AgentMessage = Message | ToolResult;
function roleOf(message: AgentMessage): string {
  return (message as { role: string }).role;
}
console.log("role", roleOf({ role: "user", content: "hi" }));
console.log("role", roleOf({ role: "tool", output: ["x"] }));

// One arm lacks the member the assertion names: Node's read answers
// undefined for that arm.
interface Stamped {
  timestamp?: number;
  text: string;
}
interface Unstamped {
  text: string;
}
function stamp(entry: Stamped | Unstamped): number | undefined {
  return (entry as { timestamp?: number }).timestamp;
}
console.log("stamp", stamp({ timestamp: 5, text: "a" }));
console.log("stamp", stamp({ text: "b" }));

// A discriminant read re-narrows the union it came from.
interface BashOperations {
  exec(command: string): string;
}
interface BashResult {
  exitCode: number;
}
type BashEventResult =
  | { operations: BashOperations; result?: undefined }
  | { operations?: undefined; result: BashResult };
function describe(result: BashEventResult | undefined): string {
  if (result?.result) return `exit ${result.result.exitCode}`;
  return `operations ${typeof result?.operations}`;
}
console.log("event", describe({ result: { exitCode: 3 } }));
console.log("event", describe({ operations: { exec: (command) => command } }));
console.log("event", describe(undefined));

// A narrowed array whose stored union still owns an absent arm.
function firstLength(models: string[] | undefined): number {
  if (models) return models.length;
  return -1;
}
console.log("first", firstLength(["a", "b"]), firstLength(undefined));
