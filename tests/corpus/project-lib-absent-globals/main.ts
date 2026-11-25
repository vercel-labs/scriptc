// The project's tsconfig lists "dom" in "lib". A global that only that library
// declares is absent at run time, as under Node: typeof answers "undefined",
// a read throws ReferenceError, and the global object has no such property.
console.log(typeof document, typeof window, typeof HTMLElement, typeof requestAnimationFrame);

const inPage = typeof window !== "undefined" && typeof document !== "undefined";
console.log(inPage);

function pageTitle(): string {
  if (typeof document === "undefined") return "(no page)";
  return document.title;
}
console.log(pageTitle());

const host = typeof window !== "undefined" ? window : null;
console.log(host === null);

const probe: unknown = { tag: 1 };
console.log(typeof HTMLElement !== "undefined" && probe instanceof HTMLElement);

let width = 80;
if (typeof window !== "undefined") {
  width = window.innerWidth;
  window.addEventListener("resize", () => {
    width = window.innerWidth;
  });
}
console.log(width);

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, String(run()));
  } catch (error) {
    console.log(label, (error as Error).name + ": " + (error as Error).message);
  }
}
attempt("read", () => document);
attempt("member", () => document.title);
attempt("optional", () => window?.innerWidth);
attempt("call", () => alert("hello"));
attempt("new", () => new XMLHttpRequest());
attempt("instanceof", () => probe instanceof HTMLElement);
attempt("write", () => {
  document.title = "x";
  return "wrote";
});
attempt("argument", () => String(location));
attempt("global object", () => typeof globalThis.document + " " + ("document" in globalThis));
attempt("global object member", () => globalThis.window === undefined);

// Code that never runs.
function mount(): void {
  const root = document.createElement("div");
  root.addEventListener("click", () => window.scrollTo(0, 0));
  document.body.appendChild(root);
}
console.log(typeof mount);
