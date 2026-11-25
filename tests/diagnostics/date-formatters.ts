// Unsupported formatters must reach the Date method diagnostic, including
// names inherited from Object.prototype by the compiler's dispatch table.
// The locale formatters compile (scr_intl.c), with the default locale or a
// string locale tag; a list of locales is refused.
const date = new Date(0);
declare const tags: string[];
date.toLocaleDateString(tags);
date.toLocaleString(["en-US"]);
