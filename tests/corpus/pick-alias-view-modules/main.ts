import { Registry } from "./registry.ts";
import { run } from "./globals.ts";
console.log(run({ registry: new Registry(), label: "L" }), run(undefined));
