import { locks } from "node:worker_threads";
const log = [];
const sleep = () => new Promise((r) => setTimeout(r, 10));
// aborted in the same turn as the request: the callback never starts
{
  const ac = new AbortController();
  const p = locks.request("same-turn", { signal: ac.signal }, () => {
    log.push("same-turn ran");
    return "value";
  });
  ac.abort();
  try { log.push("same-turn:" + JSON.stringify(await p)); }
  catch (e) { log.push("same-turn:" + e.name); }
  await sleep();
  log.push("same-turn held:" + (await locks.query()).held.length);
}
// queued request aborted while it waits
{
  let release;
  const holder = locks.request("queued", () => new Promise((resolve) => { release = resolve; }));
  await sleep();
  const ac = new AbortController();
  const queued = locks.request("queued", { signal: ac.signal }, () => {
    log.push("queued ran");
    return "queued value";
  });
  await sleep();
  ac.abort();
  try { log.push("queued:" + JSON.stringify(await queued)); }
  catch (e) { log.push("queued:" + e.name); }
  release("holder value");
  log.push("holder:" + JSON.stringify(await holder));
}
// abort after the callback started: no effect on the request
{
  let release;
  const ac = new AbortController();
  const p = locks.request("running", { signal: ac.signal }, () => new Promise((resolve) => { release = resolve; }));
  await sleep();
  ac.abort();
  await sleep();
  release("done");
  try { log.push("running:" + JSON.stringify(await p)); }
  catch (e) { log.push("running:" + e.name); }
}
console.log(log.join(" | "));
