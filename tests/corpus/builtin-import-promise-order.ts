// A builtin import promise widened to Promise<unknown> settles when the
// import does: the mapper awaits it before answering the namespace.
async function main(): Promise<void> {
  const log: string[] = [];
  const p: Promise<unknown> = import("node:fs");
  void p.then(() => log.push("mapped"));
  log.push("sync");
  void Promise.resolve().then(() => log.push("tick"));
  await p;
  log.push("awaited");
  setTimeout(() => console.log(log.join(",")), 20);
}

void main();
