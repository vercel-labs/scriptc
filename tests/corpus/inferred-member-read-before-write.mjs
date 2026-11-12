// A member the checker types from the write that introduces it is absent
// at a read before that write runs, so Node answers undefined: the
// destructured binding and the dotted read hold that answer, and the
// later write still reaches the same object.
async function get(flag) {
  let entry = {};
  if (flag) entry = { value: 1, mtime: 2 };
  entry = { ...entry };
  const status = entry.value === void 0 ? "miss" : "hit";
  entry.value = 3;
  const { status: _status, ...rest } = entry;
  console.log(_status, JSON.stringify(rest));
  Object.defineProperty(entry, "status", { value: status, enumerable: false, writable: true, configurable: true });
  return entry;
}

const missed = await get(false);
console.log(missed.status);
const hit = await get(true);
console.log(hit.status);

function readBeforeWrite() {
  let local = {};
  local.count = 1;
  const early = local.label;
  const keyed = local["label"];
  const optional = local?.label;
  const { label } = local;
  console.log(early, keyed, optional, label);
  local.label = "ready";
  console.log(local.label, local.label.length, typeof local.label);
}

readBeforeWrite();

// the same read stored by an assignment rather than a declaration
function assignReadBeforeWrite() {
  const holder = {};
  let held;
  held = holder.tag;
  var hoisted;
  hoisted = holder.tag;
  console.log(held, hoisted);
  holder.tag = "assigned";
  console.log(held, hoisted, holder.tag);
}

assignReadBeforeWrite();
