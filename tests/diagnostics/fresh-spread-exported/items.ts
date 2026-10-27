// Exported consts: the importing module reaches their elements, so the
// spreads here keep the element-layout refusal. Copying the elements
// would hide main.ts's write from `results`.
export type Result = { message: string; file: { path: string } | undefined; noisy: boolean };
export const results: Result[] = [];
export const shared = [{ message: "shared", file: undefined, noisy: false }];
results.push(...shared);
const listed = [{ message: "listed", file: undefined, noisy: true }];
export { listed };
results.unshift(...listed);
