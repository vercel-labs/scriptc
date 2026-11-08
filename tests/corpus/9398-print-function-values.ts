// Pins: a function value prints as Node prints it wherever it sits in the
// printed value: an arm of a union, a position of a tuple, a member of a
// record or an element of an array. Its name is the function's own, not the
// name of the parameter or member it is read through.
import { inspect } from "node:util";

// A stage of a text pipeline: the name of another stage, a filter, or a
// filter in a one-element tuple (applied until the text stops changing).
type Filter = (text: string) => string;
type Stage = string | Filter | [Filter];

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ");
}
const shout = (text: string): string => text.toUpperCase();
const clip = function firstTen(text: string): string {
  return text.slice(0, 10);
};
function identity(): Filter {
  return (text) => text;
}
const tools = {
  strip(text: string): string {
    return text.trim();
  },
};
class Counter {
  seen = 0;
  mark(text: string): string {
    return `${text}#${this.seen}`;
  }
}
const counter = new Counter();

const pipeline: Record<string, Stage> = {
  tidy: "squeeze",
  squeeze: squeeze,
  loud: [shout],
};
console.log(pipeline["tidy"], pipeline["squeeze"], pipeline["loud"]);
console.log(pipeline);

function show(stage: Stage): void {
  console.log(stage);
}
show("by-name");
show(squeeze);
show(shout);
show(clip);
show(identity());
show(tools.strip);
show(counter.mark);
show(squeeze.bind(null));
show([squeeze]);
show([identity()]);

// Read through a parameter, the function keeps its own name.
function direct(filter: Filter): void {
  console.log(filter);
  console.log("filter:", filter, 1);
  console.error(filter);
  console.log(inspect(filter));
}
direct(squeeze);
direct(shout);
direct(identity());
direct(clip);

// Containers of functions.
function containers(filter: Filter): void {
  const pair: [string, Filter] = ["run", filter];
  const list: Filter[] = [filter, shout];
  const record: { label: string; apply: Filter; undo?: Filter } = { label: "n", apply: filter };
  const nested: { steps: { apply: Filter }[] } = { steps: [{ apply: filter }, { apply: identity() }] };
  const byLabel = new Map<string, Filter>([["first", filter]]);
  const optional: Filter | undefined = filter;
  console.log(pair);
  console.log(list);
  console.log(record);
  console.log(nested);
  console.log(byLabel);
  console.log(optional);
  console.log(inspect(record), inspect(list), inspect(pair));
  console.log(inspect(nested, { depth: 0 }));
}
containers(squeeze);
containers(identity());

// A union with a number arm, and an absent function.
function maybe(value: number | Filter | undefined): void {
  console.log(value);
  console.log(inspect(value));
}
maybe(1);
maybe(squeeze);
maybe(undefined);

// A definition printed directly keeps its baked name.
console.log(squeeze, shout, clip);
console.log(inspect(squeeze), inspect(shout));
