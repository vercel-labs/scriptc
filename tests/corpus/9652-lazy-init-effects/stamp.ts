// Inputs read at load: the environment as it is when the module is
// imported, and the clock.
export const PROBE: string = process.env["LAZY_INIT_PROBE"] ?? "unset";
export const AT: number = Date.now();
export const WORDS: string[] = PROBE.split("-").map((word) => word.toUpperCase());
