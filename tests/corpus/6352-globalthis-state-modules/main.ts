// Boot writes the state; main reads it through a binding exported by
// another module, then takes the pending value out of the global object.
import { boot } from "./boot.ts";
import { PENDING_KEY, STATE_KEY, globalState, readState } from "./state.ts";

console.log(readState() === undefined);
boot();
const state = readState();
console.log(state?.startedAt, state?.steps.join(","));
state?.steps.push("main");
console.log(globalState[STATE_KEY]?.steps.join(","));

async function main(): Promise<void> {
  const pending = globalState[PENDING_KEY];
  globalState[PENDING_KEY] = undefined;
  console.log(await pending, globalState[PENDING_KEY]);
}
void main();
