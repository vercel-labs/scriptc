// Function values assigned into slots whose signatures are structurally
// compatible but differently shaped: Promise-wrapped record results with
// extra, optional and nested members, record parameters, and a union of
// record results converted into one record slot.
interface Deployment {
  id: string;
  meta?: { region: string; tags?: string[] };
}
interface BuildOrder {
  authToken: string;
  deployment: Deployment;
  attempt?: number;
}
interface Provider {
  name: string;
  pollBuild(): Promise<BuildOrder | undefined>;
  getContext(order: { authToken: string }): Promise<string>;
  summarize(): { id: string; done?: boolean };
}
let polls = 0;
async function pollQueue() {
  await null;
  polls++;
  if (polls > 2) return undefined;
  return {
    authToken: "tok" + polls,
    deployment: { id: "dpl_" + polls, meta: { region: "iad1", tags: ["a"], extra: true }, url: "x" },
    attempt: polls,
    receivedAt: 123,
  };
}
async function contextFor(order: { authToken: string; scope?: string }) {
  await null;
  return order.authToken + (order.scope ?? "");
}
function summary() {
  return { id: "s1", done: true, size: 4 };
}
const provider: Provider = { name: "queue", pollBuild: pollQueue, getContext: contextFor, summarize: summary };
async function main(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const order = await Promise.race([provider.pollBuild(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 50))]);
    if (!order) {
      console.log("no order");
      continue;
    }
    console.log(order.authToken, order.deployment.id, order.deployment.meta?.region, order.deployment.meta?.tags?.length, order.attempt);
    console.log(await provider.getContext(order));
  }
  const s = provider.summarize();
  console.log(s.id, s.done);
  const poll: () => Promise<BuildOrder | undefined> = pollQueue;
  polls = 0;
  const first = await poll();
  console.log(first?.deployment.id, first?.deployment.meta?.region);
}
async function failing() {
  await null;
  if (polls >= 0) throw new Error("queue closed");
  return { authToken: "never", deployment: { id: "none" }, extra: 1 };
}
async function timing(): Promise<void> {
  polls = 0;
  const order: string[] = [];
  const pending = provider.pollBuild().then((o) => order.push("poll " + o?.authToken));
  Promise.resolve()
    .then(() => order.push("tick1"))
    .then(() => order.push("tick2"))
    .then(() => order.push("tick3"))
    .then(() => order.push("tick4"));
  await pending;
  await new Promise((r) => setTimeout(r, 5));
  console.log(order.join(","));
  const closing: Provider = { ...provider, pollBuild: failing };
  try {
    await closing.pollBuild();
  } catch (e) {
    console.log("rejected", e instanceof Error ? e.message : String(e));
  }
}
interface Probe {
  ok: boolean;
  size?: number;
}
function probe(flag: boolean) {
  return flag ? { ok: true, size: 3 } : { ok: false };
}
function probes(): void {
  const check: (flag: boolean) => Probe = probe;
  console.log(JSON.stringify(check(true)), JSON.stringify(check(false)));
}
main().then(timing).then(probes);
