// `'k' in instance` answers from the class declaration, but a subclass that
// lands in the SAME union arm may declare the key: the arm then has no
// static answer and the site keeps its named refusal rather than guessing.
class Base {
  stop(): void {
    console.log("stop");
  }
}

class Extra extends Base {
  dispose(): void {
    console.log("dispose");
  }
}

export function shutDown(target: Base | { kind: "plain" }): void {
  // Extra is not an arm of the union, so a Base-arm value may be an Extra
  // that carries `dispose`.
  if ("dispose" in target && typeof (target as Extra).dispose === "function") {
    (target as Extra).dispose();
  }
}

shutDown({ kind: "plain" });
