// crypto.setFips accepts any value and answers undefined; crypto.getFips
// reports the process's FIPS mode. This build has no FIPS provider, so
// switching FIPS on is refused (ERR_CRYPTO_FIPS_UNAVAILABLE) and the
// falsy calls below leave the mode off, as Node's non-FIPS builds do.
// The truthy refusal cannot be a differential case here: the Node oracle
// on this machine is a FIPS-capable build, where setFips(true) succeeds.
import { getFips, setFips } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));

log("initial", getFips());
log("set false", setFips(false as never), getFips());
log("set zero", setFips(0 as never), getFips());
log("set undefined", setFips(undefined as never), getFips());
log("set null", setFips(null as never), getFips());
log("set empty string", setFips("" as never), getFips());
