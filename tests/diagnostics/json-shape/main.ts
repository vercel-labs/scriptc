/* A JSON document whose value doesn't bake: `1e400` parses to Infinity,
 * which no number literal spells, so the import reports the bake failure
 * at the import site and uses of the binding poison. (Its null-valued
 * field bakes as null.) */
import bad from "./nulled.json" with { type: "json" };

console.log(bad.name);
