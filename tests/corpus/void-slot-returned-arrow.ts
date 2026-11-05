// A value-returning arrow RETURNED through a `() => void` interface member.
// TypeScript types the inner arrow `() => number` (its own type) while the
// checker contextually types it `() => void`; the enclosing arrow's result
// is `() => number`, so the value is observed and must be produced. Node
// runs this; the closure is called for its effect only.
interface Subscriber {
  on(handler: (data: string) => void): () => void;
}

function makeSubscriber(): Subscriber {
  const seen: string[] = [];
  return {
    on: (handler) => {
      seen.push("registered");
      handler("first");
      // Concise arrow whose body returns a number: the result is discarded
      // at the `() => void` slot but the arrow's own type keeps it.
      return () => seen.push("unsubscribed");
    },
  };
}

const off = makeSubscriber().on((data) => console.log("got", data));
console.log("off is", typeof off);
off();
console.log("done");
