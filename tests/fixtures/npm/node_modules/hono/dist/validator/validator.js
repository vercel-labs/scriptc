import { HTTPException } from "../http-exception.js";
import { bufferToFormData } from "../utils/buffer.js";
import { getCookie } from "../helper/cookie/index.js";
//#region src/validator/validator.ts
const jsonRegex = /^application\/([a-z-\.]+\+)?json(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/i;
const multipartRegex = /^multipart\/form-data(;\s?boundary=[a-zA-Z0-9'"()+_,\-./:=?]+)?$/i;
const urlencodedRegex = /^application\/x-www-form-urlencoded(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/i;
const validator = (target, validationFunc) => {
	return async (c, next) => {
		let value = {};
		const contentType = c.req.header("Content-Type");
		switch (target) {
			case "json":
				if (!contentType || !jsonRegex.test(contentType)) break;
				try {
					value = await c.req.json();
				} catch {
					throw new HTTPException(400, { message: "Malformed JSON in request body" });
				}
				break;
			case "form": {
				if (!contentType || !(multipartRegex.test(contentType) || urlencodedRegex.test(contentType))) break;
				let formData;
				if (c.req.bodyCache.formData) formData = await c.req.bodyCache.formData;
				else try {
					const arrayBuffer = await c.req.arrayBuffer();
					formData = await bufferToFormData(arrayBuffer, contentType);
					c.req.bodyCache.formData = formData;
				} catch (e) {
					let message = "Malformed FormData request.";
					message += e instanceof Error ? ` ${e.message}` : ` ${String(e)}`;
					throw new HTTPException(400, { message });
				}
				const form = Object.create(null);
				formData.forEach((value, key) => {
					if (key.endsWith("[]")) (form[key] ??= []).push(value);
					else if (Array.isArray(form[key])) form[key].push(value);
					else if (Object.hasOwn(form, key)) form[key] = [form[key], value];
					else form[key] = value;
				});
				value = form;
				break;
			}
			case "query":
				value = Object.fromEntries(Object.entries(c.req.queries()).map(([k, v]) => {
					return v.length === 1 ? [k, v[0]] : [k, v];
				}));
				break;
			case "param":
				value = c.req.param();
				break;
			case "header":
				value = c.req.header();
				break;
			case "cookie": value = getCookie(c);
		}
		const res = await validationFunc(value, c);
		if (res instanceof Response) return res;
		c.req.addValidatedData(target, res);
		return await next();
	};
};
//#endregion
export { validator };
