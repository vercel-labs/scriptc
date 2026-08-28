const MACHO_LINKER_GLOBALS = new Set(["__mh_execute_header"]);

/** Executables may expose Mach-O's linker-defined image-header symbol even
 * when their exported-symbol list contains only the process entry point. */
export function validateLlvmHelperExports(symbols) {
  return {
    hasMain: symbols.includes("_main"),
    unexpected: symbols.filter((symbol) =>
      symbol !== "_main" && !MACHO_LINKER_GLOBALS.has(symbol)),
  };
}
