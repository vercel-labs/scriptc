import { beta, registry } from "plug-kit";

registry.register("late", beta);
export const size: number = registry.count();
