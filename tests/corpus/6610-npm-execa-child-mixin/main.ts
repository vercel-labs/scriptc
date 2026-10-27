// execa 5's child-process mixin on real `node -e` children. The dependency's
// lib/promise.js and lib/kill.js are execa 5.0.0's files, unchanged (MIT,
// lib/LICENSE); signal-exit is a stand-in. then/catch/finally arrive through
// Reflect.defineProperty, kill/cancel through plain assignment, and awaiting
// the child adopts it as a thenable.
import { run } from 'run-node';

for (const line of await run()) console.log(line);
