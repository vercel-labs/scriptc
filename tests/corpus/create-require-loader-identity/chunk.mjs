// A createRequire loader exported for another module: its identity must
// survive the import alias (Node hands out the one function object).
import { createRequire } from "node:module";

export const req = createRequire(import.meta.url);
