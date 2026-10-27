// Two modules that import each other, where one declares a class the other
// reaches only after both finished initializing: Node runs it normally.
import { logger } from "./log.ts";
import { report } from "./stats.ts";

logger.make("main").write("hello");
report();
