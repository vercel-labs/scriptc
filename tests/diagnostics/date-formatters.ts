// Unsupported formatters must reach the Date method diagnostic, including
// names inherited from Object.prototype by the compiler's dispatch table.
// The default-locale toLocaleString()/toLocaleTimeString() lower now
// (scr_intl.c); a locale or options argument still has none.
const date = new Date(0);
date.toLocaleDateString();
date.toLocaleString("en-US");
