// Async generator completion against a microtask ticker: falling off the end
// and bare returns settle as the body completes, `return x` takes a turn to
// await x, return() at a yield awaits its value before finally blocks run,
// and for await loops end on the turn Node ends them. Node.js prints the
// same.
const log: string[] = [];
async function ticker(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    log.push("t" + i);
    await null;
  }
}
async function run(name: string, body: () => Promise<void>): Promise<void> {
  log.length = 0;
  const tick = ticker(14);
  await body();
  await tick;
  console.log(name + ": " + log.join(" "));
}
class Source {
  readonly items: number[];
  constructor(items: number[]) {
    this.items = items;
  }
  async *values(): AsyncGenerator<number> {
    for (const i of this.items) yield i;
  }
}
async function main(): Promise<void> {
  await run("fall off", async () => {
    async function* g(): AsyncGenerator<number> { yield 1; }
    const it = g();
    void it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    await it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`));
  });
  await run("return value", async () => {
    async function* g(): AsyncGenerator<number, number> { yield 1; return 5; }
    const it = g();
    void it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    await it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`));
  });
  await run("bare return", async () => {
    async function* g(): AsyncGenerator<number, void> { yield 1; return; }
    const it = g();
    void it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    await it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`));
  });
  await run("empty body", async () => {
    async function* g(): AsyncGenerator<number> {}
    await g().next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
  });
  await run("after done", async () => {
    async function* g(): AsyncGenerator<number> {}
    const it = g();
    await it.next();
    log.push("mark");
    await it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`));
  });
  await run("return() at yield", async () => {
    async function* g(): AsyncGenerator<number, number> { try { yield 1; } finally { log.push("finally"); } return 0; }
    const it = g();
    await it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    await it.return(7).then((r) => log.push(`r:${String(r.value)}/${r.done}`));
  });
  await run("return() before start", async () => {
    async function* g(): AsyncGenerator<number, number> { yield 1; return 0; }
    await g().return(3).then((r) => log.push(`r:${String(r.value)}/${r.done}`));
  });
  await run("throw at end", async () => {
    async function* g(): AsyncGenerator<number> { yield 1; throw new Error("x"); }
    const it = g();
    void it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    await it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`), () => log.push("rejected"));
  });
  await run("await before end", async () => {
    async function* g(): AsyncGenerator<number> { yield 1; await null; }
    const it = g();
    void it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    await it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`));
  });
  await run("for await", async () => {
    async function* g(): AsyncGenerator<number> { yield 1; yield 2; }
    for await (const v of g()) log.push("v" + v);
    log.push("loop done");
  });
  await run("for await break", async () => {
    async function* g(): AsyncGenerator<number> { try { yield 1; yield 2; } finally { log.push("cleanup"); } }
    for await (const v of g()) { log.push("v" + v); break; }
    log.push("loop done");
  });
  await run("queued", async () => {
    async function* g(): AsyncGenerator<number> { yield 1; }
    const it = g();
    void it.next().then((r) => log.push(`a:${String(r.value)}/${r.done}`));
    void it.next().then((r) => log.push(`b:${String(r.value)}/${r.done}`));
    await it.next().then((r) => log.push(`c:${String(r.value)}/${r.done}`));
  });

  await run("yield in finally", async () => {
    async function* g(): AsyncGenerator<number, number> { try { yield 1; } finally { yield 9; log.push("after"); } return 0; }
    const it = g();
    await it.next();
    void it.return(7).then((r) => log.push(`r:${r.value}/${r.done}`));
    await it.next().then((r) => log.push(`n:${r.value}/${r.done}`));
  });
  await run("await in finally", async () => {
    async function* g(): AsyncGenerator<number, number> { try { yield 1; } finally { await null; log.push("cleaned"); } return 0; }
    const it = g();
    await it.next();
    await it.return(4).then((r) => log.push(`r:${r.value}/${r.done}`));
  });
  await run("throw at yield", async () => {
    async function* g(): AsyncGenerator<number> { try { yield 1; } catch { log.push("caught"); } }
    const it = g();
    await it.next();
    await it.throw(new Error("x")).then((r) => log.push(`t:${r.value}/${r.done}`));
  });
  await run("return through finally", async () => {
    async function* g(): AsyncGenerator<number, number> { try { yield 1; return 5; } finally { log.push("fin"); } }
    const it = g();
    void it.next().then((r) => log.push(`a:${r.value}/${r.done}`));
    await it.next().then((r) => log.push(`b:${r.value}/${r.done}`));
  });
  await run("return promise", async () => {
    async function* g(): AsyncGenerator<number, number> { yield 1; return Promise.resolve(3); }
    const it = g();
    void it.next().then((r) => log.push(`a:${r.value}/${r.done}`));
    await it.next().then((r) => log.push(`b:${r.value}/${r.done}`));
  });
  await run("two returns", async () => {
    async function* g(): AsyncGenerator<number, number> { try { yield 1; } finally { log.push("fin"); } return 0; }
    const it = g();
    await it.next();
    void it.return(1).then((r) => log.push(`r1:${r.value}/${r.done}`));
    await it.return(2).then((r) => log.push(`r2:${r.value}/${r.done}`));
  });
  await run("return after done", async () => {
    async function* g(): AsyncGenerator<number, number> { return 1; }
    const it = g();
    await it.next();
    log.push("mark");
    await it.return(8).then((r) => log.push(`r:${r.value}/${r.done}`));
  });
  await run("nested loops break", async () => {
    async function* g(n: number): AsyncGenerator<number> { try { for (let i = 0; i < n; i++) yield i; } finally { log.push("close" + n); } }
    for await (const a of g(2)) {
      for await (const b of g(3)) { log.push(`${a}${b}`); if (b === 1) break; }
    }
    log.push("done");
  });
  await run("strings", async () => {
    async function* g(): AsyncGenerator<string> { yield "a"; yield "b"; }
    const parts: string[] = [];
    for await (const s of g()) parts.push(s);
    log.push(parts.join(""));
  });

  await run("finally return override", async () => {
    async function* g(): AsyncGenerator<number, number> { try { yield 1; } finally { log.push("fin"); return 42; } }
    const it = g();
    await it.next();
    await it.return(7).then((r) => log.push(`r:${r.value}/${r.done}`));
  });
  await run("class method", async () => {
    const parts: number[] = [];
    for await (const v of new Source([1, 2, 3]).values()) parts.push(v);
    log.push(parts.join(","));
  });
  await run("return while awaiting", async () => {
    async function* g(): AsyncGenerator<number, number> { try { await null; await null; yield 1; } finally { log.push("fin"); } return 0; }
    const it = g();
    void it.next().then((r) => log.push(`n:${r.value}/${r.done}`));
    await it.return(5).then((r) => log.push(`r:${r.value}/${r.done}`));
  });
  await run("throw after done", async () => {
    async function* g(): AsyncGenerator<number> {}
    const it = g();
    await it.next();
    await it.throw(new Error("late")).then(() => log.push("ok"), (e: unknown) => log.push("rejected " + (e as Error).message));
  });
  await run("rejection inside", async () => {
    async function* g(): AsyncGenerator<number> { yield 1; await Promise.reject(new Error("inner")); }
    const it = g();
    void it.next().then((r) => log.push(`a:${r.value}/${r.done}`));
    await it.next().then(() => log.push("ok"), (e: unknown) => log.push("rejected " + (e as Error).message));
  });
}
void main();
