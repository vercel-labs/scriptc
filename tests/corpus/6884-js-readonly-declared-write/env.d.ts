// Declarations that mark a member readonly, as Next.js's global types do
// for process.env.NODE_ENV.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly APP_STAGE?: "development" | "production";
  }
}
