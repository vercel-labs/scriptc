// Reads the environment and the clock while it loads: the values of the
// moment it is loaded, which here is after the program changed the variable.
export const MODE: string = process.env["LAZY_INIT_FORMS"] ?? "unset";
export const AT: number = Date.now();
export const PARTS: string[] = MODE.split("-").map((part) => part.toUpperCase());
