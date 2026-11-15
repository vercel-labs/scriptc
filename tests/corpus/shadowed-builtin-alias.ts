// A parameter or block-local that reuses a builtin alias's name is its own
// object: writes through it stay local instead of reading as a patch of the
// builtin module's CommonJS object.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const data = require("node:path") as typeof import("node:path");

type Metadata = { sdkProcessingMetadata: string };

function annotate(data: Metadata): string {
  data.sdkProcessingMetadata = "local";
  return data.sdkProcessingMetadata;
}

{
  const data = { tag: "outer" };
  data.tag = "inner";
  console.log(data.tag);
}

function label(): string {
  return data.basename("/tmp/shadowed-builtin-alias.ts");
}

console.log(annotate({ sdkProcessingMetadata: "argument" }));
console.log(data.join("shadowed", "builtin-alias.ts"));
console.log(label());
