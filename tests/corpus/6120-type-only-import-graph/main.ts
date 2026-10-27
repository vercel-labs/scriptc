// Node's type stripping erases `import type` and `export type … from`, so
// the modules and packages they name are never loaded: a package with no
// runtime entry, a module importing a builtin scriptc does not compile, and
// modules with load-time output. An inline `type` specifier keeps an empty
// import clause and still evaluates its module, as does a mixed clause.
import type { Frozen, Shape } from "types-only-pkg";
import type { Label } from "./uses-vm.ts";
import type * as Models from "./models.ts";
import type { Reexported } from "./reexports.ts";
import { type Mode, describe } from "./mixed.ts";
import { type Flag } from "./flags.ts";

const shape: Shape = { width: 3, height: 4 };
const frozen: Frozen<Shape> = { width: 5, height: 6 };
const label: Label = "area";
const model: Models.Model = { id: 1 };
const payload: Reexported = { ok: true };
const mode: Mode = "fast";
const flag: Flag = true;
console.log(label, shape.width * shape.height, model.id, payload.ok);
console.log(describe(mode), flag, frozen.width + frozen.height);
