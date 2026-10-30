// Class fields typed AbortController and AbortSignal (plain, optional,
// `| undefined`, `| null`, in arrays) hold the live handles: aborting
// through the field is seen through every other reference, and optional
// calls on a nullable field skip an empty slot.
class Editor {
  private abort: AbortController | undefined;
  private signal: AbortSignal | null = null;
  private readonly lifetime = new AbortController();
  history: AbortController[] = [];
  last?: AbortSignal;
  start(): AbortSignal {
    this.abort?.abort();
    this.abort = new AbortController();
    this.history.push(this.abort);
    this.signal = this.abort.signal;
    this.last = this.signal;
    return this.signal;
  }
  cancel(reason?: string): boolean {
    this.abort?.abort(reason);
    return this.signal?.aborted ?? false;
  }
  reason(): unknown {
    return this.signal?.reason;
  }
  dispose(): boolean {
    this.lifetime.abort();
    return this.lifetime.signal.aborted;
  }
}

const idle = new Editor();
console.log(idle.cancel(), idle.reason());

const e = new Editor();
const first = e.start();
let events = 0;
first.addEventListener("abort", () => {
  events++;
});
const second = e.start();
console.log(first.aborted, second.aborted, events, e.history.length);
console.log(e.cancel("stop"), e.reason(), second.aborted, second.reason);
console.log(e.history[0]!.signal === first, e.last === second, e.dispose());

// A nullable local takes the same optional call.
let maybe: AbortController | undefined = e.history.length > 5 ? new AbortController() : undefined;
maybe?.abort();
console.log(maybe?.signal.aborted);
maybe = new AbortController();
maybe?.abort("late");
console.log(maybe?.signal.aborted, maybe?.signal.reason);
