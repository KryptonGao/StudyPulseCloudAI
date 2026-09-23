const $ = (selector) => document.querySelector(selector);
const message = $("#message");

function show(text, type = "") {
  message.textContent = text;
  message.className = "message " + type;
}

function setVisible(id) {
  document.querySelectorAll(".form,.aux").forEach((item) => item.classList.toggle("active", item.id === id));
  show("");
}

async function request(path, data, options = {}) {
  const response = await fetch(path, {
    method: options.method || "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Error(body?.error?.message || body?.error || "请求失败");
  return body;
}

async function authorizedRequest(path, token, data, method = "POST") {
  return request(path, data, { method, headers: { Authorization: "Bearer " + token } });
}

function base64UrlToBuffer(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeRegistrationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBuffer(options.challenge),
    user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: base64UrlToBuffer(item.id) })),
  };
}

function decodeAuthenticationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBuffer(options.challenge),
    allowCredentials: options.allowCredentials?.map((item) => ({ ...item, id: base64UrlToBuffer(item.id) })),
  };
}

function credentialToJSON(credential) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response;
  const result = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: { clientDataJSON: bufferToBase64Url(response.clientDataJSON) },
  };
  if ("attestationObject" in response) {
    result.response.attestationObject = bufferToBase64Url(response.attestationObject);
    if (response.getTransports) result.response.transports = response.getTransports();
  } else {
    result.response.authenticatorData = bufferToBase64Url(response.authenticatorData);
    result.response.signature = bufferToBase64Url(response.signature);
    if (response.userHandle) result.response.userHandle = bufferToBase64Url(response.userHandle);
  }
  return result;
}

function getAppReturnTo() {
  const fallback = "studypulse://auth/callback";
  const value = new URLSearchParams(location.search).get("return_to");
  return !value || /^studypulse:\/\/auth\/callback(?:\?.*)?$/.test(value) ? value || fallback : fallback;
}

async function finishLogin(data) {
  const loginParams = new URLSearchParams(location.search);
  if (loginParams.has("response_type")) {
    try {
      const state = loginParams.get("state") || "";
      const codeChallenge = loginParams.get("code_challenge") || "";
      if (loginParams.get("response_type") !== "code" || !state || !codeChallenge || loginParams.get("code_challenge_method") !== "S256") {
        throw Error("安全登录参数无效，请重新开始登录");
      }
      const result = await authorizedRequest("/auth/authorize", data.access_token, {
        response_type: "code",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        redirect_uri: getAppReturnTo(),
      });
      const callback = new URL(result.data?.redirect_uri || "");
      if (callback.protocol !== "studypulse:" || callback.host !== "auth" || callback.pathname !== "/callback" || callback.searchParams.get("state") !== state || !callback.searchParams.has("code")) {
        throw Error("登录回调无效，请重新开始登录");
      }
      location.replace(callback.toString());
    } catch (error) {
      show(error.message || "安全登录失败，请重试", "error");
    }
    return;
  }
  const returnTo = getAppReturnTo();
  const target = new URL(returnTo);
  target.searchParams.set("access_token", data.access_token);
  target.searchParams.set("refresh_token", data.refresh_token);
  location.replace(target.toString());
}

async function offerPasskeySetup(data) {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return finishLogin(data);
  try {
    const status = await authorizedRequest("/auth/passkey", data.access_token, undefined, "GET");
    if (status.data?.passkeys?.length || status.data?.prompt_dismissed) return finishLogin(data);
    if (!window.confirm("为账号绑定 Passkey？以后可以更快速、安全地登录。")) {
      await authorizedRequest("/auth/passkey/prompt-dismiss", data.access_token, {});
      return finishLogin(data);
    }
    const name = "Passkey";
    const options = await authorizedRequest("/auth/passkey/register/options", data.access_token, { name });
    const credential = await navigator.credentials.create({ publicKey: decodeRegistrationOptions(options.data.public_key) });
    if (!credential) throw new Error("未创建 Passkey");
    await authorizedRequest("/auth/passkey/register/verify", data.access_token, {
      challenge_token: options.data.challenge_token,
      response: credentialToJSON(credential),
    });
    show("Passkey 已绑定，正在登录…", "success");
    setTimeout(() => finishLogin(data), 450);
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      await authorizedRequest("/auth/passkey/prompt-dismiss", data.access_token, {}).catch(() => {});
    }
    show("Passkey 绑定未完成，正在继续登录…", "error");
    setTimeout(() => finishLogin(data), 700);
  }
}

async function loginWithPasskey() {
  const button = $("#passkeyLogin");
  if (!window.PublicKeyCredential || !navigator.credentials?.get) {
    show("当前浏览器不支持 Passkey，请使用其他登录方式", "error");
    return;
  }
  button.disabled = true;
  show("请使用设备上的 Passkey 完成验证…");
  try {
    const options = await request("/auth/passkey/login/options", {});
    const credential = await navigator.credentials.get({ publicKey: decodeAuthenticationOptions(options.data.public_key) });
    if (!credential) throw new Error("未选择 Passkey");
    const result = await request("/auth/passkey/login/verify", {
      challenge_token: options.data.challenge_token,
      response: credentialToJSON(credential),
    });
    finishLogin(result.data);
  } catch (error) {
    show(error?.name === "NotAllowedError" ? "Passkey 验证已取消" : error.message, "error");
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    setVisible(tab.dataset.tab);
  };
});
$("#passkeyLogin").onclick = loginWithPasskey;
$("#forgot").onclick = () => setVisible("reset");

document.querySelectorAll(".form,.aux").forEach((form) => {
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector(".submit");
    button.disabled = true;
    try {
      const path = form.id === "password"
        ? "/auth/login/password"
        : form.id === "code"
          ? "/auth/login/code"
          : form.id === "setup"
            ? "/auth/password/set-after-code"
            : "/v1/auth/password/reset";
      const result = await request(path, Object.fromEntries(new FormData(form)));
      if (result.data?.requires_password_setup) {
        $("#setup [name=setup_token]").value = result.data.setup_token;
        setVisible("setup");
        show("验证成功，请设置密码", "success");
      } else if (form.id === "reset") {
        setVisible("password");
        show("密码重置成功，请使用新密码登录", "success");
      } else if (result.data?.access_token) {
        await offerPasskeySetup(result.data);
      } else {
        show("操作成功", "success");
      }
    } catch (error) {
      show(error.message, "error");
    } finally {
      button.disabled = false;
    }
  };
});

document.querySelectorAll(".send-code").forEach((button) => {
  button.onclick = async () => {
    const form = button.closest("form");
    const email = form.querySelector("[name=email]").value.trim();
    if (!email) return show("请先输入邮箱地址", "error");
    button.disabled = true;
    try {
      await request("/auth/send-code", { email, purpose: form.id === "reset" ? "reset_password" : "login" });
      show("验证码已发送，请查收邮箱", "success");
      let seconds = 60;
      const timer = setInterval(() => {
        button.textContent = seconds ? "重新发送 " + seconds-- + "s" : "获取验证码";
        if (!seconds) {
          clearInterval(timer);
          button.disabled = false;
        }
      }, 1000);
    } catch (error) {
      show(error.message, "error");
      button.disabled = false;
    }
  };
});

const originalReturnTo = getAppReturnTo;
getAppReturnTo = function () {
  const fallback = "studypulse://auth/callback";
  const params = new URLSearchParams(location.search);
  const value = params.get("redirect") || params.get("return_to");
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "dash.studypulse.chenkai.space") {
      return url.pathname === "/" ? url.origin + "/dashboard" : url.pathname.startsWith("/dashboard") ? value : fallback;
    }
  } catch {}
  return originalReturnTo();
};

const oauthParams = new URLSearchParams(location.search);
const hasOAuthReturnTarget = oauthParams.has("redirect") || oauthParams.has("return_to") || oauthParams.has("response_type");
document.querySelectorAll(".oauth-login").forEach((link) => {
  const startUrl = "/oauth/" + link.dataset.provider + "/start";
  if (!hasOAuthReturnTarget) {
    link.href = startUrl;
    return;
  }
  const providerParams = new URLSearchParams({ return_to: getAppReturnTo() });
  for (const key of ["response_type", "state", "code_challenge", "code_challenge_method"]) {
    const value = oauthParams.get(key);
    if (value) providerParams.set(key, value);
  }
  link.href = startUrl + "?" + providerParams.toString();
});
