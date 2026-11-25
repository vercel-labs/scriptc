// The same instances seen from TypeScript through `any`, `unknown` and an
// untyped array.
import { ElementList, getElementsByTagName } from "./collection.ts";

export function fromTyped(): string {
  const list = getElementsByTagName();
  const anys: any[] = [list];
  const first = anys[0].item(0);
  const u: unknown = list;
  const back = u as ElementList;
  back.refresh();
  function viaAny(v: any): number {
    return v.refreshes;
  }
  return [first, back === list, viaAny(list), anys[0].first, anys[0] instanceof ElementList].join(" ");
}
