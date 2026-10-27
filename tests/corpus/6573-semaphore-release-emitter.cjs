// A token semaphore whose constructor builds its release channel from the
// events module, the way small npm semaphores do: once through a subclass
// declared beside the require, once through an untyped alias of the class.
// acquire() hands out free tokens and queues the rest; release() emits, and
// the listener wakes the oldest waiter or returns the token.
var EventEmitter = require("events"), Subclassed = class extends EventEmitter {}, Aliased;
Aliased = EventEmitter;

function defaultInit() {
  return "1";
}

class Semaphore {
  constructor(nr, { initFn = defaultInit, aliased = false } = {}) {
    this.nrTokens = nr;
    this.free = [];
    this.waiting = [];
    this.releaseEmitter = aliased ? new Aliased() : new Subclassed();
    this.noTokens = initFn === defaultInit;
    this.releaseEmitter.on("release", (token) => {
      const p = this.waiting.shift();
      if (p) p.resolve(token);
      else this.free.push(token);
    });
    for (let i = 0; i < nr; i++) this.free.push(initFn());
  }
  async acquire() {
    const token = this.free.pop();
    if (token !== undefined) return token;
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }
  release(token) {
    this.releaseEmitter.emit("release", this.noTokens ? "1" : token);
  }
  nrWaiting() {
    return this.waiting.length;
  }
}

async function run(label, sema) {
  const order = [];
  const tasks = [1, 2, 3, 4].map(async (n) => {
    const token = await sema.acquire();
    order.push(`${n}:${token}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    sema.release(token);
  });
  console.log(label, "waiting", sema.nrWaiting());
  await Promise.all(tasks);
  console.log(label, order.join(" "), "free", sema.free.length, "waiting", sema.nrWaiting());
}

(async () => {
  await run("plain", new Semaphore(2));
  let next = 0;
  await run("tokens", new Semaphore(2, { initFn: () => `t${next++}` }));
  await run("aliased", new Semaphore(1, { aliased: true }));
  const s = new Semaphore(1);
  console.log("channel", s.releaseEmitter instanceof EventEmitter, s.releaseEmitter instanceof Subclassed);
})();
