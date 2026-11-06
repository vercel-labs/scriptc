// `+=` into a `string | undefined` field: JavaScript's `undefined + "x"` is
// "undefinedx", and once the field holds a string the append keeps it.
interface Output {
  stopReason: string;
  errorMessage: string | undefined;
}

function annotate(output: Output, raw: string): void {
  if (!(output.errorMessage ?? "").includes(raw)) {
    output.errorMessage += `\n${raw}`;
  }
}

const out: Output = { stopReason: "error", errorMessage: "boom" };
annotate(out, "raw");
annotate(out, "raw");
console.log(JSON.stringify(out));

const fresh: Output = { stopReason: "error", errorMessage: undefined };
annotate(fresh, "first");
console.log(JSON.stringify(fresh));

interface Block {
  type: string;
  label?: string;
}

function append(block: Block, text: string): void {
  block.label = block.label || "";
  block.label += text;
}

const b: Block = { type: "text" };
append(b, "x");
append(b, "y");
console.log("appended", JSON.stringify(b));

const bare: Block = { type: "text" };
bare.label += "z";
console.log("bare", JSON.stringify(bare));
