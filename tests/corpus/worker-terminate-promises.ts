import { Worker, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);

// terminate() answers a fresh promise per call, and each resolves with the
// worker's exit code. Several calls made before the exit settle in call order,
// as Node's exit listeners run in the order they were added, so a race between
// them answers the first call's promise. (After the exit event Node answers
// undefined there; scriptc answers the exit code, which Promise<number> can
// spell. The corpus therefore checks only that a late call answers a promise.)
if (isMainThread) {
  const first = new Worker(self);
  first.on("online", async () => {
    const a = first.terminate();
    const b = first.terminate();
    console.log("distinct promises", a !== b);
    const codes = [await a, await b];
    console.log("codes", codes.join(","));
  });
  first.on("exit", (code) => {
    console.log("exit", code);
    const late = first.terminate();
    console.log("late is a promise", late instanceof Promise);
    late.catch(() => {});

    const second = new Worker(self);
    second.on("online", () => {
      const order: number[] = [];
      const one = second.terminate().then(() => "one");
      const two = second.terminate().then(() => "two");
      const three = second.terminate().then(() => "three");
      Promise.race([one, two]).then((value) => console.log("race", value));
      Promise.all([one, two, three]).then((values) => console.log("all", values.join(",")));
      one.then(() => order.push(1));
      two.then(() => order.push(2));
      three.then(() => order.push(3));
      second.on("exit", (c) => setTimeout(() => console.log("call order", order.join(","), "exit", c), 0));
    });
  });
} else {
  setInterval(() => {}, 1000);
}
