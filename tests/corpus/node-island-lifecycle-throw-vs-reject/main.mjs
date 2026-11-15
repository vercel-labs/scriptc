// @requires-libnode
// A synchronous throw stays synchronous and a rejection stays a rejection in
// both directions; finally blocks and return overrides keep their order.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function probe(fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    return `threw synchronously: ${e.message}`;
  }
  if (r instanceof Promise) return r.then((v) => `fulfilled: ${v}`, (e) => `rejected: ${e.message}`);
  return `returned ${typeof r}`;
}

async function main() {
  log(`native sees ${await probe(lib.syncThrower)}`);
  log(`native sees ${await probe(lib.rejecter)}`);
  log(`native sees ${await probe(lib.asyncThrower)}`);
  log(`island sees ${await lib.probe(() => { throw new Error("native sync throw"); })}`);
  log(`island sees ${await lib.probe(() => Promise.reject(new Error("native rejection")))}`);
  log(`island sees ${await lib.probe(async () => { throw new Error("native async throw"); })}`);
  log(`island sees ${await lib.probe(async () => "ok")}`);
  log(`island sees ${await lib.probe(() => 1)}`);

  try {
    await lib.finallyOrder(async () => {
      try {
        throw new Error("inner");
      } finally {
        log("native finally");
      }
    }, log);
  } catch (e) {
    log(`native catch ${e.message}`);
  }
  // A finally that returns overrides the rejection.
  const override = async () => {
    try {
      await lib.rejecter();
    } finally {
      return "overridden";
    }
  };
  log(await override());
  // A rejection handled only later by the other side is not unhandled.
  const p = lib.rejecter();
  p.catch(() => {});
  await null;
  log("end");
}

main();
