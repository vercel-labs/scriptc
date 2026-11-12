// A Console instance's options and members that have no lowering. The
// accepted options are stdout, stderr, ignoreErrors and a groupIndentation
// whose type is a number; every other option and every member outside the
// prototype's lowered set is refused at build time by name.
import { Console } from "node:console";
import { Writable } from "node:stream";

declare const stream: Writable;

// A groupIndentation that is not statically a number: Node would throw
// ERR_INVALID_ARG_TYPE, so the value is refused rather than guessed.
new Console({ stdout: stream, groupIndentation: "3" as unknown as number });

// colorMode and inspectOptions change the rendering the lowering fixes at
// compile time.
new Console({ stdout: stream, colorMode: "auto" });
new Console({ stdout: stream, inspectOptions: { depth: 1 } });

// The inspector-only members exist on the global console as no-ops but not
// on a Console instance, so they are refused by name.
const c = new Console({ stdout: stream });
c.profile();
c.profileEnd();
c.timeStamp("label");
