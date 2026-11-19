// crypto.setFips stores its argument's truthiness as the process's FIPS
// flag (answering undefined), and crypto.getFips reports it. Node's types
// take a boolean; the runtime coerces any value, so the odd shapes below
// pass through a never assertion.
import { getFips, setFips } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));

log("initial", getFips());
log("set true", setFips(true), getFips());
log("set zero", setFips(0 as never), getFips());
log("set string", setFips("x" as never), getFips());
log("set object", setFips({} as never), getFips());
log("set undefined", setFips(undefined as never), getFips());
log("set null", setFips(null as never), getFips());
log("set empty string", setFips("" as never), getFips());
