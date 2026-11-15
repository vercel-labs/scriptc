// @requires-libnode
// The same alternation from inside a timer and an immediate (a tick queue
// and a microtask queue drained between macrotasks), and tick/microtask
// chains whose links alternate between native and island code.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function nativeAll(tag) {
  setImmediate(() => log(`${tag} immediate`));
  process.nextTick(() => log(`${tag} tick`));
  queueMicrotask(() => log(`${tag} microtask`));
}

function nativeChain(tag, depth) {
  if (depth === 0) return;
  queueMicrotask(() => {
    log(`${tag} native micro ${depth}`);
    process.nextTick(() => {
      log(`${tag} native tick ${depth}`);
      lib.chain(tag, depth - 1, nativeChain);
    });
  });
}

setImmediate(() => {
  log("native immediate");
  nativeAll("n-imm");
  lib.queueAll("i-imm");
  lib.inImmediate(() => {
    log("island immediate, native callback");
    lib.queueAll("i-imm2");
    nativeAll("n-imm2");
    nativeChain("c", 6);
    lib.chain("d", 5, nativeChain);
  });
});
log("main end");
