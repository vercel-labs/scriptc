// Deleting a declared optional field of a record that keeps a wider source's
// extra keys removes the property from the kept-source view too: Node's
// delete drops the own key, so key walks, `in`, JSON, console output and
// untyped reads stop seeing it, while the source's other extra keys keep
// their order. A later write reintroduces the key at the end.

type Cfg = { command: string; args?: string[] };
type Wide = { command: string; args?: string[]; url: string; note?: string };

const wide: Wide = { command: "c", args: ["a"], url: "u", note: "n" };
const cfg: Cfg = { ...wide };
const view = cfg as unknown as Record<string, unknown>;
console.log(Object.keys(cfg).join(","), "args" in cfg, Object.keys(view).join(","));
delete cfg.args;
console.log(Object.keys(cfg).join(","), "args" in cfg, JSON.stringify(cfg), cfg.args === undefined);
console.log(Object.keys(view).join(","), "args" in view, view["args"] === undefined);
console.log(cfg);
cfg.args = ["b"];
console.log(Object.keys(cfg).join(","), JSON.stringify(cfg), cfg.args === undefined);

// A deleted optional field that the source never held is still absent, and
// deleting it again stays a no-op.
const plain: Cfg = { ...wide };
delete plain.args;
delete plain.args;
console.log(Object.keys(plain).join(","), JSON.stringify(plain));

// The delete runs on a value that went through a later spread as well: the
// extra key copied forward keeps its order, the deleted field stays gone.
const again: Cfg = { ...cfg };
console.log(Object.keys(again).join(","), JSON.stringify(again));
