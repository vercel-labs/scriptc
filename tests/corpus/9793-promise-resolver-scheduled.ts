// The resolve function of a typed promise passed to a scheduler together with its argument, or
// called from a scheduled closure, where the argument is a promise or may be one.
let tick = 0;
function spin(i: number): void {
  if (i < 12) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}
const order: string[] = [];
function note(label: string, p: Promise<number>): void {
  p.then(
    (v) => {
      order.push(`${label} fulfilled ${v} tick ${tick}`);
    },
    (e) => {
      order.push(`${label} rejected ${(e as Error).message} tick ${tick}`);
    },
  );
}
function maybe(now: boolean): number | Promise<number> {
  return now ? 2 : Promise.resolve(3);
}
spin(0);
// process.nextTick runs before the first reaction, so the turns line up with a direct call.
note("nextTick promise", new Promise<number>((resolve) => { process.nextTick(resolve, Promise.resolve(1)); }));
note("nextTick union value", new Promise<number>((resolve) => { process.nextTick(resolve, maybe(true)); }));
note("nextTick union promise", new Promise<number>((resolve) => { process.nextTick(resolve, maybe(false)); }));
note("nextTick rejection", new Promise<number>((resolve) => { process.nextTick(resolve, Promise.reject<number>(new Error("tick"))); }));
note("nextTick value", new Promise<number>((resolve) => { process.nextTick(resolve, 4); }));
note("microtask closure", new Promise<number>((resolve) => { queueMicrotask(() => { resolve(Promise.resolve(5)); }); }));
note("microtask closure, twice", new Promise<number>((resolve) => {
  queueMicrotask(() => {
    resolve(maybe(false));
    resolve(6);
  });
}));
// Timers run after every reaction above: the order of the lines is what is pinned.
note("timeout promise", new Promise<number>((resolve) => { setTimeout(resolve, 0, Promise.resolve(7)); }));
note("timeout union value", new Promise<number>((resolve) => { setTimeout(resolve, 0, maybe(true)); }));
note("timeout union promise", new Promise<number>((resolve) => { setTimeout(resolve, 0, maybe(false)); }));
note("timeout value", new Promise<number>((resolve) => { setTimeout(resolve, 0, 8); }));
note("timeout closure", new Promise<number>((resolve) => { setTimeout(() => resolve(Promise.resolve(9)), 0); }));
note("timeout no argument", new Promise<number>((resolve) => { setTimeout(() => resolve(10), 1); }));
setTimeout(() => {
  for (const line of order) console.log(line);
}, 30);
