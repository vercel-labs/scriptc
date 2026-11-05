// A WeakRef answers its target for the whole job: the runtime keeps the
// target until the job ends (ClearKeptObjects keeps longer than required),
// so deref's identity and the handle's rendering are deterministic here.
// Every target below is also strongly held by a live binding, so nothing
// depends on when the heap frees anything.
interface Cached {
  source: string;
  tokens: number[];
}

class Renderer {
  private cachedTokens?: WeakRef<Cached>;
  render(text: string, tokens: number[]): string {
    const hit = this.cachedTokens?.deref();
    if (hit !== undefined && hit.source === text) return `hit ${hit.tokens.join(" ")}`;
    this.cachedTokens = new WeakRef({ source: text, tokens });
    return `miss ${tokens.join(" ")}`;
  }
}

const renderer = new Renderer();
console.log(renderer.render("alpha", [1, 2]));
console.log(renderer.render("alpha", [1, 2]));
console.log(renderer.render("beta", [3]));

const target = { source: "kept" };
const ref = new WeakRef(target);
console.log(ref.deref() === target, ref.deref() === ref.deref());

const list = [1, 2, 3];
const listRef = new WeakRef(list);
console.log(listRef.deref() === list, String(listRef.deref()));

// A target nothing else holds still answers within the job it was made in.
const fresh = new WeakRef({ source: "fresh" });
console.log(fresh.deref()?.source);

console.log(String(ref), JSON.stringify(ref));
console.log(ref instanceof WeakRef, target instanceof WeakRef);
