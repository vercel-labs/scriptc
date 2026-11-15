import { Kit } from "shape-kit";

export const id = Kit.text({ label: "id" });
export const row = Kit.record({ id: id, size: Kit.number() });
