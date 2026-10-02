// `a ?? b` and `a || b` evaluate to `b` when `a` is undefined, so a
// defaulted array read is present even though the read itself may miss.
// Treating the default as runtime-optional widened `result`'s storage
// shape, and passing it to a parameter of the declared type copied it:
// writes made by the callee landed on the copy and vanished. `a && b`
// still yields an undefined left operand, so it keeps the optional ABI.

interface Parsed {
  command: string;
  argument: string;
  extra?: string[];
  flag?: boolean;
}

const fill = (options: Parsed, values: string[]): void => {
  options.extra = values;
  options.flag = true;
  options.argument = values.join(" ");
};

const parseNullish = (args: string[]): Parsed => {
  const result: Parsed = { argument: "", command: "" };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    positional.push(arg);
    if (arg === "skills") {
      result.command = "skills";
      fill(result, args.slice(index + 1));
      return result;
    }
  }
  result.command = positional[0] ?? "";
  result.argument = positional[1] ?? "";
  return result;
};

const parseOr = (args: string[]): Parsed => {
  const result: Parsed = { argument: "", command: "" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "skills") {
      result.command = "skills";
      fill(result, args.slice(index + 1));
      return result;
    }
  }
  result.command = args[0] || "none";
  result.argument = args[1] || "none";
  return result;
};

const show = (label: string, parsed: Parsed): void => {
  console.log(label, parsed.command, JSON.stringify(parsed.argument), JSON.stringify(parsed.extra ?? ["<missing>"]), parsed.flag === true);
};

show("nullish skills:", parseNullish(["skills", "--skill", "c15t"]));
show("nullish other:", parseNullish(["status", "verbose"]));
show("nullish empty:", parseNullish([]));
show("or skills:", parseOr(["skills", "--yes"]));
show("or other:", parseOr(["status"]));

// The left operand of `&&` is the result when it is falsy, including a
// missing element, so this read stays optional.
const firstOrMissing = (items: string[], index: number): string | undefined => items[index] && items[index];
console.log("and present:", firstOrMissing(["a", "b"], 1));
console.log("and missing:", String(firstOrMissing(["a", "b"], 5)));
console.log("nullish missing:", ["a"][3] ?? "default");
