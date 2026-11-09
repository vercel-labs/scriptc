// @requires-libnode
// An optional chain on a native receiver whose tail reads members of an
// island object: a nullish receiver short-circuits the whole chain, the
// island reads included, and a present one reads them.
import { load } from "settings-kit";
import Holder from "./holder.ts";

let holder: Holder;
let spare: Holder | undefined;

async function after(code: number): Promise<void> {
  if (holder?.config.usedBefore !== false) {
    console.log("skipped", code);
    return;
  }
  console.log("offered", code, holder.config.label);
}

function report(tag: string): void {
  console.log(tag, "label", holder?.config.label);
  console.log(tag, "keyed", holder?.config["label"]);
  console.log(tag, "call", holder?.config.describe());
  console.log(tag, "deep", holder?.config.limits?.retries);
  console.log(tag, "typeof", typeof holder?.config.usedBefore);
  console.log(tag, "spare", spare?.config.label, spare?.config.describe(), spare?.config.limits?.retries ?? "none");
  console.log(tag, "fallback", holder?.config.label ?? "no holder");
}

function forms(tag: string, h: Holder | undefined, list: Holder[], byName: Map<string, Holder>): void {
  console.log(tag, "param", h?.config.label, h?.config.describe(), h?.["config"].label);
  console.log(tag, "method", h?.settings().label, h?.settings().describe().length);
  console.log(tag, "asserted", h?.config!.label, `${h?.config.label}`);
  console.log(tag, "element", list[1]?.config.label, list[1]?.config.limits?.retries);
  console.log(tag, "map", byName.get("b")?.config.label, byName.get("b")?.config.describe());
  h?.config.describe();
  const retries = h?.config.limits?.retries ?? -1;
  console.log(tag, "retries", retries, h?.config.usedBefore === true, h?.config.usedBefore ? "used" : "fresh");
}

async function main(): Promise<void> {
  report("unset");
  forms("none", undefined, [], new Map());
  await after(1);
  holder = new Holder({ config: load("first", false, 3) });
  report("set");
  await after(2);
  spare = new Holder({ config: load("second") });
  report("spare");
  forms("some", holder, [holder, spare], new Map([["b", spare]]));
  holder = new Holder({ config: load("third", true) });
  await after(3);
}

main().then(() => console.log("done"));
