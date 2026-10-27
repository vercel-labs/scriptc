// Unsupported formatters must reach the Date method diagnostic, including
// names inherited from Object.prototype by the compiler's dispatch table.
const date = new Date(0);
date.toLocaleTimeString();
date.toLocaleString();
