// A type-position `import('spec')['name']` names the type of that module
// member's value, the type `typeof import('spec')['name']` names. Published
// TypeScript-adjacent code writes the form (svelte 4's
// internal/Component.js spells `@param {import('./n.js')['f']}` for a value
// export); the checker refuses it as written and types it `any`.
import { k, f, record } from "./n.js";

type Count = import("./n.js")["k"];
type Mapper = import("./n.js")["f"];
type RecordValue = import("./n.js")["record"];

const count: Count = 3;
// Contextually typed by the imported member's VALUE type: without the
// resolution, this parameter would be an implicit `any`.
const doubled: Mapper = (value) => value * 2;
const value: RecordValue = { kind: "record", n: count };

console.log(typeof count, count + 1);
console.log(doubled(count), doubled(f(k)));
console.log(value.kind, typeof value.n, record.n);
