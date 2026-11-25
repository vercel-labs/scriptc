// @requires-libnode
// A member a package's data interface declares, read on a spread copy the
// program made of an island object's member. The copy's type is the
// program's own and only the member's declaration is the package's: the
// read is a read of data the program holds, so it is not refused as a
// crossing into the package, and it answers what Node answers.
import { makeItem } from "shelf-kit";
import type { Item, PinnedItem } from "shelf-kit";

function summaryOf(item: Item | PinnedItem) {
  return {
    title: item.title,
    ...("variant" in item && item.variant === "Pinned"
      ? { variant: item.variant, sticky: item.sticky }
      : {}),
    label: item.label && { ...item.label },
  };
}

const summary = summaryOf(makeItem("first", "red"));
const input = {
  ...summary,
  label: summary.label && { name: summary.label.name },
  size: 3,
};
console.log(JSON.stringify(input));
console.log(summary.label?.name, summary.label?.revision, typeof summary.label?.name);

// The copy is the program's object: a write to it does not reach the island's.
const item = makeItem("second", "blue");
const copied = summaryOf(item);
if (copied.label) {
  copied.label.name = "changed";
  console.log(copied.label.name, item.label?.name);
}

// No label: the member is absent on the copy's holder.
const bare = summaryOf(makeItem("third"));
console.log(JSON.stringify({ ...bare, label: bare.label && { name: bare.label.name } }));
console.log(bare.label === undefined, bare.label?.name);
