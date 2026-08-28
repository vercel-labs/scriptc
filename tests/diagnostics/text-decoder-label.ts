const bytes = new Uint8Array([0x41]);

const runtimeLabel: string = process.argv[2] ?? "utf-8";
console.log(new TextDecoder(runtimeLabel).decode(bytes));

// WHATWG's replacement labels deliberately fail TextDecoder construction.
console.log(new TextDecoder("replacement").decode(bytes));

// Vertical tab is not WHATWG ASCII whitespace and must not be trimmed.
console.log(new TextDecoder("\vutf-8").decode(bytes));

// A literal-typed variable read is still runtime constructor evaluation. Do
// not drop its TDZ behavior after selecting the static decoder id.
function forwardLabelRead(): void {
  // @ts-expect-error Deliberately retain the runtime TDZ shape.
  console.log(new TextDecoder(forwardLabel).decode(bytes));
  const forwardLabel = "windows-1252" as const;
  void forwardLabel;
}
forwardLabelRead();
