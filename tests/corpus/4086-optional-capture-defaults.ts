// A closure reading a captured binding that may later hold an absent
// array element: defaults and conditions decide on the stored value.
function defaults(names: string[]): void {
  let name = names[0];
  if (!name) return;
  const orDefault = () => console.log("or", name || "fallback", (name || "fallback").length);
  const nullish = () => console.log("nullish", name ?? "fallback", (name ?? "fallback").length);
  orDefault();
  nullish();
  name = names.slice(1)[0];
  orDefault();
  nullish();
}

function condition(names: string[]): void {
  let name = names[0];
  if (!name) return;
  const describe = () => console.log("condition", name ? "set" : "unset", name === undefined);
  describe();
  name = names.slice(1)[0];
  describe();
}

defaults(["first"]);
defaults(["first", ""]);
defaults(["first", "second"]);
condition(["first"]);
condition(["first", "next"]);
