// An entry's toJSON through an indexed read: `getEntriesByName(name)[0]` and
// `list[0]` lower to the entry beside an absent arm (an indexed read may
// miss), so the call answers the entry's five fields when the element is
// there and Node's TypeError when it is not.
import { performance } from "node:perf_hooks";

performance.mark("fixed", { startTime: 5, detail: { at: "mark" } });
performance.measure("span", { start: 1, duration: 2, detail: [1, 2] });

console.log("mark", JSON.stringify(performance.getEntriesByName("fixed")[0].toJSON()));
const list = performance.getEntriesByName("span");
console.log("measure", JSON.stringify(list[0].toJSON()));
console.log("by type", JSON.stringify(performance.getEntriesByType("measure")[0].toJSON()));
console.log("detail identity", list[0].toJSON().detail !== undefined);

try {
  console.log(performance.getEntriesByName("missing")[0].toJSON());
} catch (error) {
  console.log("missing", error instanceof TypeError, (error as Error).message);
}
try {
  console.log(list[3].toJSON());
} catch (error) {
  console.log("list missing", error instanceof TypeError, (error as Error).message);
}
