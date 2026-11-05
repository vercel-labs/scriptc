// A `satisfies` expression keeps its operand's type, so a satisfies'd
// record inside a conditional maps exactly like the record itself — in an
// annotated union slot, in an inferred one, and as a call argument.
type Num = { kind: "num"; value: number };
type Text = { kind: "text"; value: string };
type Node = Num | Text;

function render(node: Node): string {
  return node.kind === "num" ? "n:" + node.value : "t:" + node.value;
}
function describe(flag: boolean, n: number): Node | null {
  const node = flag ? ({ kind: "num", value: n } satisfies Node) : null;
  return node;
}
function take(node: Node): string {
  return render(node);
}

const annotated: Node | null = true ? ({ kind: "text", value: "hi" } satisfies Node) : null;
console.log("annotated", annotated === null ? "none" : render(annotated));
const inferred = false ? ({ kind: "num", value: 1 } satisfies Node) : null;
console.log("inferred", inferred === null ? "none" : render(inferred));
console.log("call", take({ kind: "num", value: 7 } satisfies Node));
console.log("describe", describe(true, 3) === null ? "none" : render(describe(true, 3) as Node));
console.log("describe-null", describe(false, 3) === null);
