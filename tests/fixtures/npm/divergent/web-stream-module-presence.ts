// @dynamic
// This is a scriptc-only probe: Node's node:stream/web has more exports than
// the deliberately bounded island shim, so it is not part of npm's
// byte-for-byte differential corpus.
import { modulePresence } from "webstream";

console.log(modulePresence());
