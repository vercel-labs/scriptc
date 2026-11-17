import { compile } from "./packages/compiler/dist/index.js";
const r = await compile(process.argv[2], { outDir: "/tmp/b5dbg/arout", outPath: "/tmp/b5dbg/arout/prog", backend: "llvm" });
if (!r.ok) { console.error(r.diagnostics.map(d => d.code + ": " + d.message).join("\n")); process.exit(1); }
console.log("built");
