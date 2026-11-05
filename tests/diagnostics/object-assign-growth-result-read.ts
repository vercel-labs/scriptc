// Object.assign(target, source) whose source carries keys the target's type
// does not declare: the write itself is supported (the added keys join the
// record's kept source, so every reference sees them), but the checker types
// the RESULT as the target with those keys added, and a native record has no
// layout for that wider type. A discarded result is the supported spelling;
// reading the result refuses by name instead of answering a value whose type
// the program would then trust.
interface Tool {
  name: string;
  label: string;
}

function wrap(name: string): Tool {
  return { name, label: name.toUpperCase() };
}

const tool = wrap("sh");
const grown = Object.assign(tool, { snippet: "run shell" });
console.log(grown.snippet);
