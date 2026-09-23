const form = document.getElementById("form");
const status = document.getElementById("status");
const challenge = new URLSearchParams(location.search).get("challenge");
form.challenge.value = challenge || "";

async function call(path, data) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) throw Error(body?.error?.message || "请求失败");
	return body;
}

document.getElementById("send").onclick = async () => {
	try {
		await call("/oauth/github/bind/send-code", {
			challenge,
			email: document.getElementById("email").value,
		});
		status.textContent = "验证码已发送，请查收邮箱";
	} catch (error) {
		status.textContent = error.message;
		status.className = "message error";
	}
};

form.onsubmit = async (event) => {
	event.preventDefault();
	try {
		const result = await call("/oauth/github/bind/verify", Object.fromEntries(new FormData(form)));
		status.textContent = "绑定成功，正在返回…";
		if (result.data.redirect_uri) {
			location.replace(result.data.redirect_uri);
			return;
		}
		const returnTo = result.data.return_to;
		const callback = new URL(returnTo);
		callback.searchParams.set("access_token", result.data.access_token);
		callback.searchParams.set("refresh_token", result.data.refresh_token);
		location.replace(callback.toString());
	} catch (error) {
		status.textContent = error.message;
		status.className = "message error";
	}
};
