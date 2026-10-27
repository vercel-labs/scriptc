import { validator } from "hono/validator";
//#region src/index.ts
function zValidatorFunction(target, schema, hook, options) {
	const caseInsensitiveKeymap = target === "header" && ("_def" in schema || "_zod" in schema) ? Object.fromEntries(Object.keys("in" in schema ? schema.in.shape : schema.shape).map((key) => [key.toLowerCase(), key])) : void 0;
	return validator(target, async (value, c) => {
		let validatorValue = value;
		if (caseInsensitiveKeymap) validatorValue = Object.fromEntries(Object.entries(value).map(([key, value]) => [caseInsensitiveKeymap[key] || key, value]));
		const result = options && options.validationFunction ? await options.validationFunction(schema, validatorValue) : await schema.safeParseAsync(validatorValue);
		if (hook) {
			const hookResult = await hook({
				data: validatorValue,
				...result,
				target
			}, c);
			if (hookResult) {
				if (hookResult instanceof Response) return hookResult;
				if ("response" in hookResult) return hookResult.response;
			}
		}
		if (!result.success) return c.json(result, 400);
		return result.data;
	});
}
const zValidator = zValidatorFunction;
//#endregion
export { zValidator };

//# sourceMappingURL=index.mjs.map