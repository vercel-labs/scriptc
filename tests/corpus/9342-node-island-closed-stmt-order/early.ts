import { alpha, registry } from "plug-kit";

registry.register("early", alpha);
export const first: number = registry.count();
