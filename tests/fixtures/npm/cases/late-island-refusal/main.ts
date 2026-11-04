// @dynamic
// A refusal that is a consequence of ANOTHER package's refusal: `late-helper`
// requires `vm` (an R1 construct the native pipeline refuses), and `late-lock`
// statically imports `late-helper`, so its own refusal exists only because
// `late-helper` cannot be compiled. The automatic island policy must island
// both — the refused dependency and the package that inherits the refusal —
// and re-analyse, so the program runs in Node and matches Node byte for byte
// instead of stopping at the inherited SC1010.
import { lock } from "late-lock";

console.log(lock("work"));
