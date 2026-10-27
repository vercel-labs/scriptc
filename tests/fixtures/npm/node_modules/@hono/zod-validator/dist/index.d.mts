import { InferInput } from "hono/validator";
import { Context, Env, Input, MiddlewareHandler, TypedResponse, ValidationTargets } from "hono";
import * as v3 from "zod/v3";
import { ZodSafeParseResult } from "zod/v4";
import * as v4 from "zod/v4/core";
//#region src/index.d.ts
type ZodSchema = v3.ZodType | v4.$ZodType;
type ZodError<T extends ZodSchema> = T extends v4.$ZodType ? v4.$ZodError<v4.output<T>> : v3.ZodError;
type ZodSafeParseResult$1<T, T2, T3 extends ZodSchema> = T3 extends v4.$ZodType ? ZodSafeParseResult<T> : v3.SafeParseReturnType<T, T2>;
type zInput<T> = T extends v3.ZodType ? v3.input<T> : T extends v4.$ZodType ? v4.input<T> : never;
type zOutput<T> = T extends v3.ZodType ? v3.output<T> : T extends v4.$ZodType ? v4.output<T> : never;
type zInfer<T> = T extends v3.ZodType ? v3.infer<T> : T extends v4.$ZodType ? v4.infer<T> : never;
type ZodValidatorFailureBody<T extends ZodSchema> = T extends v4.$ZodType ? Extract<ZodSafeParseResult<v4.output<T>>, {
  success: false;
}> : T extends v3.ZodType ? Extract<v3.SafeParseReturnType<v3.input<T>, v3.output<T>>, {
  success: false;
}> : never;
type ZodValidatorFailureResponse<T extends ZodSchema> = Response & TypedResponse<ZodValidatorFailureBody<T>, 400, "json">;
type Hook<T, E extends Env, P extends string, Target extends keyof ValidationTargets = keyof ValidationTargets, O = {}, Schema extends ZodSchema = any> = (result: ({
  success: true;
  data: T;
} | {
  success: false;
  error: ZodError<Schema>;
  data: T;
}) & {
  target: Target;
}, c: Context<E, P>) => Response | void | TypedResponse<O> | Promise<Response | void | TypedResponse<O>>;
type HasUndefined<T> = undefined extends T ? true : false;
type ExtractValidationResponse<VF> = VF extends ((value: any, c: any) => infer R) ? R extends Promise<infer PR> ? PR extends TypedResponse<infer T, infer S, infer F> ? Response & TypedResponse<T, S, F> : PR extends Response ? PR : PR extends undefined ? never : never : R extends TypedResponse<infer T, infer S, infer F> ? Response & TypedResponse<T, S, F> : R extends Response ? R : R extends undefined ? never : never : never;
type ValidationFunctionOption<T extends ZodSchema, Target extends keyof ValidationTargets> = {
  validationFunction: (schema: T, value: ValidationTargets[Target]) => ZodSafeParseResult$1<any, any, T> | Promise<ZodSafeParseResult$1<any, any, T>>;
};
type DefaultInput<Target extends keyof ValidationTargets, In, Out> = {
  in: HasUndefined<In> extends true ? { [K in Target]?: [In] extends [ValidationTargets[K]] ? In : InferInput<In, K>; } : { [K in Target]: [In] extends [ValidationTargets[K]] ? In : InferInput<In, K>; };
  out: { [K in Target]: Out; };
};
declare function zValidatorFunction<T extends ZodSchema, Target extends keyof ValidationTargets, E extends Env, P extends string, In = zInput<T>, Out = zOutput<T>, I extends Input = DefaultInput<Target, In, Out>, V extends I = I>(target: Target, schema: T, hook?: undefined, options?: ValidationFunctionOption<T, Target>): MiddlewareHandler<E, P, V, ZodValidatorFailureResponse<T>>;
declare function zValidatorFunction<T extends ZodSchema, Target extends keyof ValidationTargets, E extends Env, P extends string, HookFn extends Hook<InferredValue, E, P, Target, {}, T>, In = zInput<T>, Out = zOutput<T>, I extends Input = DefaultInput<Target, In, Out>, V extends I = I, InferredValue = zInfer<T>>(target: Target, schema: T, hook?: HookFn, options?: ValidationFunctionOption<T, Target>): MiddlewareHandler<E, P, V, ExtractValidationResponse<HookFn>>;
declare const zValidator: typeof zValidatorFunction;
//#endregion
export { Hook, zValidator };
//# sourceMappingURL=index.d.mts.map