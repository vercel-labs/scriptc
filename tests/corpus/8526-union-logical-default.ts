// `o || {}` where flow narrowing ruled out the other arm of `o`'s type:
// the stored value keeps its wider union, so the default tests the value in
// its own union and extracts the checker's arm through the checked
// narrowing. The falsy arm takes the default; an object argument is the
// result itself.
interface ExportOptions {
  outputPath?: string;
  theme?: string;
  inlineImages?: boolean;
}

function fromPath(options?: ExportOptions | string): ExportOptions {
  return typeof options === "string" ? { outputPath: options } : options || {};
}

const names = (o: ExportOptions): string => `${o.outputPath ?? "-"}/${o.theme ?? "-"}/${o.inlineImages ?? "-"}`;
console.log("none", names(fromPath(undefined)));
console.log("path", names(fromPath("out.html")));
console.log("object", names(fromPath({ outputPath: "p", theme: "dark", inlineImages: true })));
console.log("empty", JSON.stringify(fromPath({})));

// The same shape over a union of records with a default object.
interface Cursor {
  line: number;
  column: number;
}
function cursorAt(where: Cursor | undefined): Cursor {
  return where || { line: 1, column: 1 };
}
console.log("cursor", JSON.stringify(cursorAt(undefined)), JSON.stringify(cursorAt({ line: 4, column: 2 })));

// The default is evaluated only when the left is falsy.
let defaults = 0;
function counted(): Cursor {
  defaults++;
  return { line: 0, column: 0 };
}
const base: Cursor | undefined = { line: 2, column: 3 };
console.log("lazy", JSON.stringify(base || counted()), defaults);
const missing: Cursor | undefined = undefined;
console.log("fallback", JSON.stringify(missing || counted()), defaults);
