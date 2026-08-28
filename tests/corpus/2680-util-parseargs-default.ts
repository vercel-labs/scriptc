// Omitted args reads process.argv.slice(2); the corpus run pins the empty
// case, while focused CLI validation invokes the compiled binary with args.
import { parseArgs } from "node:util";

console.log(JSON.stringify(parseArgs({ strict: false, tokens: true })));
