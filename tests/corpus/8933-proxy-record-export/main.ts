import { reads, replace, settings } from "./settings.ts";
import { summary } from "./reader.ts";
console.log(settings.depth, settings.label, summary());
replace({ depth: 2, label: "second" });
console.log(settings.depth, settings.label, summary());
console.log(reads.join(","));
