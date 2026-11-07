// @requires-libnode
// A native AbortSignal that aborted before it crossed into a Node island
// arrives aborted, with its reason: AbortSignal.abort(), a controller that
// already aborted, and a signal aborted with itself as the reason.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

async function main(): Promise<void> {
  lib.inspect("abort()", AbortSignal.abort());
  lib.inspect("abort(text)", AbortSignal.abort("text reason"));
  lib.inspect("abort(error)", AbortSignal.abort(new TypeError("typed reason")));
  lib.inspect("abort(0)", AbortSignal.abort(0));
  lib.inspect("abort(record)", AbortSignal.abort({ why: "record", n: 1 }));

  const controller = new AbortController();
  controller.abort(new Error("earlier"));
  lib.inspect("controller", controller.signal);
  lib.inspect("controller again", controller.signal);

  // The reason is the signal itself: on the island, its own twin.
  const self = new AbortController();
  self.abort(self.signal);
  console.log("self", lib.selfReason(self.signal), self.signal.reason === self.signal);

  console.log(await lib.receivers(AbortSignal.abort(new Error("gone"))));
}

main();
