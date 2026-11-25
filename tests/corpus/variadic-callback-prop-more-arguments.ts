// Callback props: a variadic function property invoked with more arguments
// than the functions stored in it declare, and a variadic function stored
// where a one-parameter callback property is expected.
interface Props {
  onChange: (...args: unknown[]) => void;
  onCommit: (value: string) => void;
}

function invoke(p: Props): void {
  p.onChange("a", 1, true);
  p.onCommit("done");
}

const props: Props = {
  onChange: (a: unknown) => {
    console.log("change", String(a));
  },
  onCommit: (...args: unknown[]) => {
    console.log("commit", args.length, args.map(String).join(","));
  },
};
invoke(props);

const handler = (...args: unknown[]) => {
  console.log("handler", args.length);
};
const narrow: Props = {
  onChange: handler,
  onCommit: handler,
};
invoke(narrow);
