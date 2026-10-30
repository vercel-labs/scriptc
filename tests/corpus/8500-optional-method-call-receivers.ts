// Optional-chained METHOD calls on structural receivers: a class seen
// through `Pick<Class, ...>`, an interface implemented by program classes,
// and the same receivers held in optional fields. Node calls the method
// when the receiver is present and answers undefined (no call) when not.

class CacheWarmer {
  status = "idle";
  onAgentSettled(): void {
    console.log("settled", this.status);
  }
  onModeChanged(): void {
    console.log("mode", this.status);
  }
}

interface Renderer {
  requestRender(): void;
}

class MainScreen implements Renderer {
  requestRender(): void {
    console.log("main");
  }
}

class AltScreen implements Renderer {
  requestRender(): void {
    console.log("alt");
  }
}

function settle(w: Pick<CacheWarmer, "onAgentSettled"> | undefined): void {
  w?.onAgentSettled();
}

function tick(tui: Renderer | undefined): void {
  tui?.requestRender();
}

class Session {
  private cacheWarmer?: Pick<CacheWarmer, "onModeChanged" | "status">;
  private renderer: Renderer | undefined;
  constructor(w: CacheWarmer | undefined, r: Renderer | undefined) {
    this.cacheWarmer = w;
    this.renderer = r;
  }
  settle(): void {
    this.cacheWarmer?.onModeChanged();
    this.renderer?.requestRender();
  }
  describe(): string {
    return `${this.cacheWarmer?.status ?? "none"}/${this.renderer === undefined ? "none" : "ui"}`;
  }
}

settle(new CacheWarmer());
settle(undefined);
tick(new MainScreen());
tick(new AltScreen());
tick(undefined);
new Session(new CacheWarmer(), new MainScreen()).settle();
new Session(undefined, undefined).settle();
console.log(new Session(new CacheWarmer(), undefined).describe());
console.log(new Session(undefined, new AltScreen()).describe());

// A present but non-callable member still throws Node's catchable TypeError;
// the `?.` step only skips the call when the RECEIVER is absent.
const loose: any = { render: 42 };
try {
  loose?.render();
} catch (e) {
  console.log("call:", e instanceof TypeError, (e as Error).message);
}
const looseStep: any = { render: 42 };
try {
  looseStep.render?.();
} catch (e) {
  console.log("step:", e instanceof TypeError, (e as Error).message);
}
