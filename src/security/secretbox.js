/**
 * AES-GCM secret box for provider API keys stored in D1.
 *
 * Ciphertext format: "v1.<iv-base64url>.<ciphertext-base64url>"
 * The AES key is derived (SHA-256) from MODEL_SECRET_ENCRYPTION_KEY.
 * ADMIN_API_TOKEN is the fallback so the feature works before the dedicated
 * secret is configured; a constant dev fallback keeps local dev usable.
 * Rotating the secret makes stored ciphertexts undecryptable (the affected
 * models simply resolve to "no key" until re-entered), so set the dedicated
 * secret before storing production keys.
 */

const VERSION = "v1";
const FALLBACK_SECRET = "studypulse-local-dev-secret";

function toBase64Url(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function getPassphrase(env) {
	return env?.MODEL_SECRET_ENCRYPTION_KEY || env?.ADMIN_API_TOKEN || FALLBACK_SECRET;
}

async function getAesKey(env) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(getPassphrase(env)),
	);
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt plaintext → "v1.<iv>.<ct>". Empty/null input returns null. */
export async function encryptSecret(plaintext, env) {
	const value = String(plaintext ?? "");
	if (!value) return null;
	const key = await getAesKey(env);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(value),
	);
	return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

/** Decrypt a secretbox payload → plaintext, or null when undecryptable. */
export async function decryptSecret(payload, env) {
	if (typeof payload !== "string" || !payload.startsWith(`${VERSION}.`)) return null;
	const [, ivPart, ctPart] = payload.split(".");
	if (!ivPart || !ctPart) return null;
	try {
		const key = await getAesKey(env);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64Url(ivPart) },
			key,
			fromBase64Url(ctPart),
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		return null;
	}
}

/** Human-safe hint for UI display: never returns the secret itself. */
export function keyHintFor(plaintext) {
	const value = String(plaintext ?? "");
	if (!value) return null;
	if (value.length <= 4) return "****";
	return `…${value.slice(-4)}`;
}
