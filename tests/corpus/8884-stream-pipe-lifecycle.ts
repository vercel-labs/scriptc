// The pipe lifecycle events, in Node's order: pipe() listens on the
// destination and the source, so the destination hears 'unpipe' when it
// finishes, closes or errors and when a source piped with `end: false`
// ends, not only on an explicit unpipe(). The source pauses, with 'pause',
// once it pipes nowhere, and stays flowing while another destination
// remains.
import { PassThrough, Readable, Writable } from "node:stream";

function mkdst(tag: string, log: string[]): Writable {
  const w = new Writable({
    write(chunk, _enc, cb) {
      log.push(`${tag} write ${chunk.toString()}`);
      cb();
    },
  });
  w.on("finish", () => log.push(`${tag} finish`));
  w.on("close", () => log.push(`${tag} close`));
  w.on("pipe", (src) => log.push(`${tag} pipe ${src instanceof Readable}`));
  w.on("unpipe", (src) =>
    log.push(`${tag} unpipe ${src instanceof Readable} flowing=${(src as Readable).readableFlowing}`),
  );
  w.on("error", (e) => log.push(`${tag} error ${e.message}`));
  return w;
}
function mksrc(tag: string, log: string[], items: string[]): Readable {
  const r = new Readable({ read() {} });
  for (const it of items) r.push(it);
  r.on("end", () => log.push(`${tag} end`));
  r.on("close", () => log.push(`${tag} close`));
  r.on("pause", () => log.push(`${tag} pause`));
  r.on("resume", () => log.push(`${tag} resume`));
  r.on("error", (e) => log.push(`${tag} error ${e.message}`));
  return r;
}
function report(title: string, log: string[]): void {
  console.log(`== ${title}`);
  for (const l of log) console.log(l);
}
const wait = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // The source ends: pipe() ends the destination, whose 'finish' unpipes.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a", "b"]);
    const d = mkdst("d", log);
    const ret = s.pipe(d);
    log.push(`ret ${ret === d}`);
    s.push(null);
    await wait();
    report("source end", log);
  }
  // end: false: the source's 'end' unpipes and the destination stays open.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d, { end: false });
    s.push(null);
    await wait();
    log.push(`writable ${d.writable} ended ${d.writableEnded}`);
    d.end();
    await wait();
    report("end: false", log);
  }
  // unpipe(dest): 'pause', then 'unpipe'; later data stays in the source.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d);
    await wait();
    log.push(`before flowing=${s.readableFlowing}`);
    const r = s.unpipe(d);
    log.push(`ret ${r === s} flowing=${s.readableFlowing}`);
    s.push("late");
    await wait();
    s.unpipe(d); // no longer piped: nothing happens
    log.push("again");
    s.destroy();
    d.destroy();
    await wait();
    report("unpipe(dest)", log);
  }
  // Two destinations: unpiping one keeps the other flowing; unpipe()
  // clears both, pauses once, and each hears 'unpipe' in pipe order.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d1 = mkdst("d1", log);
    const d2 = mkdst("d2", log);
    s.pipe(d1);
    s.pipe(d2);
    await wait();
    s.unpipe(d1);
    log.push(`after one flowing=${s.readableFlowing}`);
    s.push("b");
    await wait();
    s.pipe(d1);
    await wait();
    s.unpipe();
    log.push(`after all flowing=${s.readableFlowing}`);
    s.push("c");
    await wait();
    s.unpipe(); // nothing left
    log.push("again");
    s.destroy();
    d1.destroy();
    d2.destroy();
    await wait();
    report("unpipe()", log);
  }
  // A destination error unpipes before the program's 'error' listener.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d);
    await wait();
    d.destroy(new Error("boom"));
    await wait();
    log.push(`src destroyed ${s.destroyed} flowing=${s.readableFlowing}`);
    s.destroy();
    await wait();
    report("destination error", log);
  }
  // A destination destroyed without an error unpipes at 'close'.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d);
    await wait();
    d.destroy();
    await wait();
    log.push(`flowing=${s.readableFlowing}`);
    s.destroy();
    await wait();
    report("destination close", log);
  }
  // A destination the program ends unpipes at 'finish'.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d);
    await wait();
    d.end();
    await wait();
    log.push(`flowing=${s.readableFlowing}`);
    s.destroy();
    await wait();
    report("destination end", log);
  }
  // A source error leaves the pipe in place until the destination closes.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d);
    await wait();
    s.destroy(new Error("src boom"));
    await wait();
    log.push(`dest destroyed ${d.destroyed} writable ${d.writable}`);
    d.destroy();
    await wait();
    report("source error", log);
  }
  // pipe()'s 'finish' listener sits where pipe() was called: after the
  // listeners registered before it and ahead of those registered later.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = new PassThrough();
    d.on("finish", () => log.push("finish listener before pipe()"));
    d.on("unpipe", () => log.push("unpipe"));
    s.pipe(d);
    d.on("finish", () => log.push("finish listener after pipe()"));
    d.on("end", () => log.push("d end"));
    d.resume();
    s.push(null);
    await wait();
    report("listener order", log);
  }
  // Readable.from into a PassThrough.
  {
    const log: string[] = [];
    const dst = new PassThrough();
    dst.on("pipe", () => log.push("pipe"));
    dst.on("unpipe", () => log.push("unpipe"));
    dst.on("data", (c) => log.push("data " + c.toString()));
    Readable.from(["x", "y"]).pipe(dst);
    await wait();
    report("Readable.from", log);
  }
  // once('unpipe'), and the listeners pipe() itself leaves on a destination.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    d.once("unpipe", (src) => log.push(`once unpipe ${src === s}`));
    s.pipe(d);
    log.push(`piped: unpipe=${d.listenerCount("unpipe")} finish=${d.listenerCount("finish")}`);
    log.push(`piped: close=${d.listenerCount("close")} error=${d.listenerCount("error")}`);
    s.unpipe(d);
    log.push(`unpiped: unpipe=${d.listenerCount("unpipe")} finish=${d.listenerCount("finish")}`);
    log.push(`unpiped: close=${d.listenerCount("close")} error=${d.listenerCount("error")}`);
    s.pipe(d);
    s.unpipe(d);
    s.destroy();
    d.destroy();
    await wait();
    report("once", log);
  }
  // The same source piped twice into one destination: each unpipe(dest)
  // removes one pipe.
  {
    const log: string[] = [];
    const s = mksrc("s", log, ["a"]);
    const d = mkdst("d", log);
    s.pipe(d);
    s.pipe(d);
    await wait();
    s.unpipe(d);
    log.push(`one left flowing=${s.readableFlowing} finish=${d.listenerCount("finish")}`);
    s.push("b");
    await wait();
    s.unpipe(d);
    log.push(`none left flowing=${s.readableFlowing} finish=${d.listenerCount("finish")}`);
    s.destroy();
    d.destroy();
    await wait();
    report("piped twice", log);
  }
  // An 'unpipe' listener that unpipes another stream: each emit has its own
  // claim, so the outer pipe() still removes its listeners afterwards. The
  // listener is registered before pipe(), so it runs ahead of pipe()'s own.
  {
    const log: string[] = [];
    const s1 = mksrc("s1", log, ["a"]);
    const s2 = mksrc("s2", log, ["b"]);
    const d1 = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const d2 = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const counts = (d: Writable): string =>
      `unpipe=${d.listenerCount("unpipe")} finish=${d.listenerCount("finish")} close=${d.listenerCount("close")} error=${d.listenerCount("error")}`;
    d1.on("unpipe", () => {
      log.push("d1 unpipe, unpiping s2");
      s2.unpipe(d2);
      log.push(`inside: d2 ${counts(d2)}`);
    });
    d2.on("unpipe", () => log.push("d2 unpipe"));
    s1.pipe(d1);
    s2.pipe(d2);
    log.push(`piped: d1 ${counts(d1)}`);
    log.push(`piped: d2 ${counts(d2)}`);
    s1.unpipe(d1);
    log.push(`after: d1 ${counts(d1)}`);
    log.push(`after: d2 ${counts(d2)}`);
    // Nothing of pipe()'s is left on d1: finishing it unpipes nothing.
    d1.end();
    await wait();
    log.push(`d1 ended: flowing s1=${s1.readableFlowing} s2=${s2.readableFlowing}`);
    s1.destroy();
    s2.destroy();
    d2.destroy();
    await wait();
    report("nested unpipe", log);
  }
  // The same, the other way round: the listener is added after pipe(), so
  // pipe()'s own listener has already cleaned up when it unpipes the other.
  {
    const log: string[] = [];
    const s1 = mksrc("s1", log, ["a"]);
    const s2 = mksrc("s2", log, ["b"]);
    const d1 = mkdst("d1", log);
    const d2 = mkdst("d2", log);
    s1.pipe(d1);
    s2.pipe(d2);
    d1.on("unpipe", () => {
      s2.unpipe(d2);
      log.push(`inside: d2 finish=${d2.listenerCount("finish")} d1 finish=${d1.listenerCount("finish")}`);
    });
    await wait();
    s1.unpipe(d1);
    log.push(`after: d1 finish=${d1.listenerCount("finish")} d2 finish=${d2.listenerCount("finish")}`);
    s1.destroy();
    s2.destroy();
    d1.destroy();
    d2.destroy();
    await wait();
    report("nested unpipe, late listener", log);
  }
  // A source that already ended when it is piped with end: false unpipes
  // on the next tick.
  {
    const log: string[] = [];
    const s = mksrc("s", log, []);
    s.push(null);
    s.resume();
    await wait();
    const d = mkdst("d", log);
    s.pipe(d, { end: false });
    log.push("piped after end");
    await wait();
    log.push(`writable ${d.writable}`);
    d.destroy();
    await wait();
    report("ended source", log);
  }
}
main();
