// Unsupported formatters must reach the Date method diagnostic, including
// names inherited from Object.prototype by the compiler's dispatch table.
// The locale formatters compile (scr_intl.c), with the default locale,
// "en-US" or "en"; any other locale is refused.
const date = new Date(0);
date.toLocaleDateString("de-DE");
date.toLocaleString(["en-US"]);
