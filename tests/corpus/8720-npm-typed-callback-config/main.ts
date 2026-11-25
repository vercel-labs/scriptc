// A types-only SDK package declares its client CONFIG as an interface whose
// members are methods (`describe()`, `Logger.info`) and callback slots
// (`normalize: (input: string) => string`, `RetryHooks.onGiveUp?`). The
// program builds the config itself, so the declaration describes data and
// call signatures the program supplies — the shape maps like a local
// declaration, and every `config.field = value` write below compiles.
import type { Logger, ProviderConfig } from "typed-sdk";

const logger: Logger = {
  info(message) {
    console.log("info:", message);
  },
  error(message, cause) {
    console.log("error:", message, cause ?? "(no cause)");
  },
};

const config: ProviderConfig = {
  logger,
  describe() {
    return "typed-sdk-client";
  },
  normalize(input) {
    return input.trim().toLowerCase();
  },
};

config.region = "us-east-1";
config.endpoint = "https://sdk.example.invalid";
config.maxAttempts = 3;
config.hooks = {
  onRetry(attempt, delayMs) {
    console.log("retry:", attempt, delayMs);
  },
  onGiveUp(reason) {
    console.log("give up:", reason);
  },
};

console.log(config.describe(), config.region, config.endpoint, config.maxAttempts);
console.log(config.normalize("  MiXeD Case  "));
config.hooks.onRetry(1, 250);
if (config.hooks.onGiveUp) config.hooks.onGiveUp("timeout");
config.logger?.info("ready");
config.logger?.error("boom");
console.log(JSON.stringify(Object.keys(config).sort()));
