import { sha256 } from "./crypto.js";
//#region src/utils/buffer.ts
/**
* @module
* Buffer utility.
*/
const equal = (a, b) => {
	if (a === b) return true;
	if (a.byteLength !== b.byteLength) return false;
	const va = new DataView(a);
	const vb = new DataView(b);
	let i = va.byteLength;
	while (i--) if (va.getUint8(i) !== vb.getUint8(i)) return false;
	return true;
};
const constantTimeEqualString = (a, b) => {
	const aLen = a.length;
	const bLen = b.length;
	const maxLen = Math.max(aLen, bLen);
	let out = aLen ^ bLen;
	for (let i = 0; i < maxLen; i++) {
		const aChar = i < aLen ? a.charCodeAt(i) : 0;
		const bChar = i < bLen ? b.charCodeAt(i) : 0;
		out |= aChar ^ bChar;
	}
	return out === 0;
};
const timingSafeEqualString = async (a, b, hashFunction) => {
	if (!hashFunction) hashFunction = sha256;
	const [sa, sb] = await Promise.all([hashFunction(a), hashFunction(b)]);
	if (sa == null || sb == null || typeof sa !== "string" || typeof sb !== "string") return false;
	const hashEqual = constantTimeEqualString(sa, sb);
	const originalEqual = constantTimeEqualString(a, b);
	return hashEqual && originalEqual;
};
const timingSafeEqual = async (a, b, hashFunction) => {
	if (typeof a === "string" && typeof b === "string") return timingSafeEqualString(a, b, hashFunction);
	if (!hashFunction) hashFunction = sha256;
	const [sa, sb] = await Promise.all([hashFunction(a), hashFunction(b)]);
	if (!sa || !sb || typeof sa !== "string" || typeof sb !== "string") return false;
	return timingSafeEqualString(sa, sb);
};
const bufferToString = (buffer) => {
	if (buffer instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(buffer);
	return buffer;
};
const bufferToFormData = (arrayBuffer, contentType) => {
	return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
};
//#endregion
export { bufferToFormData, bufferToString, equal, timingSafeEqual };
