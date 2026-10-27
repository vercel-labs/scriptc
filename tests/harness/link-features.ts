/* The runtime units a lowered module links, selected exactly as compile()
 * selects them (executableLinkFeatures). Harnesses that link IR through
 * compileC spread this instead of hand-picking feature flags: a hand-picked
 * list silently misses a unit added later (the dynamic tier's
 * scr_js_value.c), which the sanitized lane, compiling only the listed
 * runtime sources, reports as undefined references. */
export { executableLinkFeatures as moduleLinkFeatures } from "../../packages/compiler/src/backend/executable-features.js";
