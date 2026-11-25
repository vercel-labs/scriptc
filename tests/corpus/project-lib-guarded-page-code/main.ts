// The project's tsconfig lists "dom" in "lib". Code written for a page and a
// server alike: every use of the page is behind a guard that is false here,
// as under Node, and the guarded code compiles. A callback parameter that the
// DOM library would type (`event`, `anchor`, `[entry]`) is implicitly `any`
// in the compiled program.
let clicks = 0;
if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    clicks += event.detail;
  });
}
console.log(clicks);

const onKey: (event: KeyboardEvent) => string = (event) => event.key;
const listener: EventListener = (event) => {
  void event;
};
console.log(typeof onKey, typeof listener);

function fieldValue(id: string): string {
  if (typeof document === "undefined") return "";
  const field = document.querySelector<HTMLInputElement>(`#${id}`);
  return field?.value ?? "";
}
console.log(JSON.stringify(fieldValue("name")));

function labels(): string[] {
  const out: string[] = [];
  if (typeof document === "undefined") return out;
  for (const node of document.querySelectorAll("label")) out.push(node.textContent ?? "");
  document.querySelectorAll("a").forEach((anchor, index) => out.push(`${index}:${anchor.href}`));
  const { width, height } = document.body.getBoundingClientRect();
  out.push(`${width}x${height}`);
  return out;
}
console.log(labels().length);

function remember(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
console.log(remember("theme", "dark"));

function watch(run: (size: number) => void): void {
  if (typeof window === "undefined") {
    run(0);
    return;
  }
  const observer = new ResizeObserver(([entry]) => run(entry?.contentRect.width ?? 0));
  observer.observe(document.body);
  window.requestAnimationFrame((time) => run(time));
}
watch((size) => console.log(size));

class View {
  private root: HTMLElement | null = null;
  attach(root: HTMLElement): void {
    this.root = root;
  }
  get attached(): boolean {
    return this.root !== null;
  }
  size(): [number, number] {
    return this.root ? [this.root.clientWidth, this.root.clientHeight] : [0, 0];
  }
}
const view = new View();
console.log(view.attached, view.size().join("x"));

function firstOf<T extends Element>(list: ArrayLike<T> | null): T | null {
  return list !== null && list.length > 0 ? list[0]! : null;
}
function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | null,
  type: K,
  run: (event: HTMLElementEventMap[K]) => void,
): boolean {
  if (target === null) return false;
  target.addEventListener(type, run);
  return true;
}
console.log(
  firstOf(null) === null,
  on(null, "click", (event) => console.log(event.button)),
);

async function load(src: string): Promise<number> {
  if (typeof Image === "undefined") return -1;
  return new Promise<number>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth);
    image.onerror = (cause) => reject(new Error(String(cause)));
    image.src = src;
  });
}
load("x.png").then((width) => console.log(width));
