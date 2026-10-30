import { parse, parseSigned, serialize, serializeSigned } from "../../utils/cookie.js";
//#region src/helper/cookie/index.ts
const getCookie = (c, key, prefix) => {
	const cookie = c.req.raw.headers.get("Cookie");
	if (typeof key === "string") {
		if (!cookie) return;
		let finalKey = key;
		if (prefix === "secure") finalKey = "__Secure-" + key;
		else if (prefix === "host") finalKey = "__Host-" + key;
		return parse(cookie, finalKey)[finalKey];
	}
	if (!cookie) return {};
	return parse(cookie);
};
const getSignedCookie = async (c, secret, key, prefix) => {
	const cookie = c.req.raw.headers.get("Cookie");
	if (typeof key === "string") {
		if (!cookie) return;
		let finalKey = key;
		if (prefix === "secure") finalKey = "__Secure-" + key;
		else if (prefix === "host") finalKey = "__Host-" + key;
		return (await parseSigned(cookie, secret, finalKey))[finalKey];
	}
	if (!cookie) return {};
	return await parseSigned(cookie, secret);
};
const generateCookie = (name, value, opt) => {
	let cookie;
	if (opt?.prefix === "secure") cookie = serialize("__Secure-" + name, value, {
		path: "/",
		...opt,
		secure: true
	});
	else if (opt?.prefix === "host") cookie = serialize("__Host-" + name, value, {
		...opt,
		path: "/",
		secure: true,
		domain: void 0
	});
	else cookie = serialize(name, value, {
		path: "/",
		...opt
	});
	return cookie;
};
const setCookie = (c, name, value, opt) => {
	const cookie = generateCookie(name, value, opt);
	c.header("Set-Cookie", cookie, { append: true });
};
const generateSignedCookie = async (name, value, secret, opt) => {
	let cookie;
	if (opt?.prefix === "secure") cookie = await serializeSigned("__Secure-" + name, value, secret, {
		path: "/",
		...opt,
		secure: true
	});
	else if (opt?.prefix === "host") cookie = await serializeSigned("__Host-" + name, value, secret, {
		...opt,
		path: "/",
		secure: true,
		domain: void 0
	});
	else cookie = await serializeSigned(name, value, secret, {
		path: "/",
		...opt
	});
	return cookie;
};
const setSignedCookie = async (c, name, value, secret, opt) => {
	const cookie = await generateSignedCookie(name, value, secret, opt);
	c.header("set-cookie", cookie, { append: true });
};
const deleteCookie = (c, name, opt) => {
	const deletedCookie = getCookie(c, name, opt?.prefix);
	setCookie(c, name, "", {
		...opt,
		maxAge: 0
	});
	return deletedCookie;
};
//#endregion
export { deleteCookie, generateCookie, generateSignedCookie, getCookie, getSignedCookie, setCookie, setSignedCookie };
