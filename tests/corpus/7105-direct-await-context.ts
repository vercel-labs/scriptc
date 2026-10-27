// AsyncLocalStorage across a stackless body's awaits of stackless callees:
// each callee inherits its caller's store at the call, a store a callee
// enters after its first await stays inside it, and run() scopes survive
// the awaits.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const log: string[] = [];

async function read(tag: string): Promise<string> {
  await null;
  return `${tag}=${store.getStore() ?? "none"}`;
}
async function enters(tag: string): Promise<string> {
  await null;
  store.enterWith(`inner-${tag}`);
  await null;
  return `${tag}=${store.getStore() ?? "none"}`;
}
async function body(name: string): Promise<void> {
  log.push(await read(`${name}.first`));
  log.push(await enters(`${name}.enters`));
  log.push(await read(`${name}.after`));
}

async function main(): Promise<void> {
  await Promise.all([
    store.run("a", () => body("a")),
    store.run("b", () => body("b")),
    body("none"),
  ]);
  for (const line of log) console.log(line);
}
void main();
