// A steal takes the grant from a signal-bearing request before its callback
// turn. Without an abort the callback still runs and the request rejects
// with the steal's AbortError; an abort in the same turn settles the request
// with the signal's reason first and keeps the callback from running; a
// later abort changes nothing.
import { locks } from "node:worker_threads";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const aborted = new AbortController();
let abortedRan = false;
const abortedVictim = locks.request("steal-signal-abort", { signal: aborted.signal }, () => {
  abortedRan = true;
  return "victim";
});
const abortStealer = locks.request("steal-signal-abort", { steal: true }, () => "stolen");
aborted.abort();
console.log("abort stealer", await abortStealer);
try {
  console.log("abort victim", await abortedVictim);
} catch (error) {
  console.log("abort victim rejected", error.name, error.message);
}
console.log("abort victim ran", abortedRan);

const quiet = new AbortController();
let quietRan = false;
const quietVictim = locks.request("steal-signal-callback", { signal: quiet.signal }, () => {
  quietRan = true;
  return "victim";
});
const quietStealer = locks.request("steal-signal-callback", { steal: true }, () => "stolen");
console.log("quiet stealer", await quietStealer);
try {
  console.log("quiet victim", await quietVictim);
} catch (error) {
  console.log("quiet victim rejected", error.name, error.message);
}
console.log("quiet victim ran", quietRan);

const late = new AbortController();
const lateVictim = locks.request("steal-signal-late", { signal: late.signal }, () => "victim");
const lateStealer = locks.request("steal-signal-late", { steal: true }, () => "stolen");
console.log("late stealer", await lateStealer);
let settled = "";
try {
  await lateVictim;
} catch (error) {
  settled = `${error.name} ${error.message}`;
}
late.abort();
try {
  await lateVictim;
} catch (error) {
  console.log("late victim", error.name, error.message);
}
console.log("settled", settled);

await tick();
console.log("held", (await locks.query()).held.length);
