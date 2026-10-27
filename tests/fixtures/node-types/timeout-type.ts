// NodeJS.Timeout as a declared type under @types/node: fields, clearTimeout,
// ref/unref/hasRef, refresh.
class Poller {
  private timer: NodeJS.Timeout | undefined;
  private count = 0;
  start(): void {
    this.timer = setInterval(() => {
      this.count++;
      console.log("poll", this.count);
      if (this.count === 3) this.stop();
    }, 5);
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log("stopped");
    }
  }
}
new Poller().start();
const t: NodeJS.Timeout = setTimeout(() => console.log("never"), 1000);
console.log(t.hasRef());
t.unref();
console.log(t.hasRef());
t.ref();
console.log(t.hasRef());
clearTimeout(t);
const timers: NodeJS.Timeout[] = [setTimeout(() => console.log("a"), 30), setTimeout(() => console.log("b"), 31)];
console.log(timers.length);
