// A package declaration file replaced by a local one (scriptc.typePatches
// files), plus a declaration patch on another file of the same package.
import { parseLog, summarize } from "eventlog";

const entries = parseLog("10 info ada started\n12 warn - disk low\n15 error lin crashed hard\n");
for (const e of entries) console.log(e.at, e.level.toUpperCase(), e.user ?? "(system)", e.message);
console.log(entries.filter((e) => e.level !== "info").length, JSON.stringify(entries[1]));
const all = summarize(entries);
const none = summarize([]);
console.log(all.count, all.last ?? "-", none.count, none.last ?? "-");
