// @requires-libnode
// Cross-heap cycles through native subclasses of an island class (scope-B
// NI-8): the instance is an island object; its native constructor registers
// a native listener that captures the instance. The pairs nothing holds are
// freed; those native code or island code holds keep working.
import { adopt, broadcast, Channel, churn } from "channel-pkg";

class CountingChannel extends Channel {
  count = 0;
  constructor(name: string) {
    super(name);
    this.onMessage((text: string) => {
      this.count += text.length;
    });
  }
  summary(): string {
    return `${this.name}:${this.count}`;
  }
}

const nativeHeld: CountingChannel[] = [];
let total = 0;
for (let i = 0; i < 3000; i++) {
  const c = new CountingChannel(`c${i}`);
  total += c.deliver("ping");
  total += c.count;
  if (i % 600 === 0) nativeHeld.push(c);
  if (i % 700 === 0) adopt(c);
  churn(4);
}
console.log("total", total);
for (const c of nativeHeld) c.deliver("again");
console.log("native held", nativeHeld.map((c) => c.summary()).join(","));
console.log("island delivered", broadcast("hi"));
console.log("native held", nativeHeld.map((c) => c.summary()).join(","));
