const AUTH = "https://auth.chenkai.space/login";
const PAGE = location.pathname;
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => new Intl.NumberFormat("zh-CN").format(Number(v || 0));

function datetime(v) {
  return v ? new Date(v).toLocaleString("zh-CN") : "—";
}
function day(v) {
  return v ? new Date(v).toLocaleDateString("zh-CN") : "—";
}

function token() {
  const q = new URLSearchParams(location.search);
  const t = q.get("access_token");
  if (t) {
    localStorage.setItem("sp_session_token", t);
    history.replaceState({}, "", location.pathname);
  }
  return localStorage.getItem("sp_session_token");
}
function login() {
  location.replace(AUTH + "?redirect=" + encodeURIComponent(location.origin + location.pathname));
}
function logout() {
  const t = token();
  localStorage.removeItem("sp_session_token");
  if (t) fetch("/api/v1/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + t } }).finally(login);
  else login();
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token(), ...(opts.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "请求失败");
  return j;
}
function isOverview() {
  return PAGE === "/" || PAGE === "/dashboard" || PAGE === "/dashboard/";
}
function activateNav() {
  document.querySelectorAll(".tab").forEach((item) => {
    const on = item.dataset.page === "/dashboard" ? isOverview() : item.dataset.page === PAGE;
    item.classList.toggle("active", on);
  });
}
function refreshPage() {
  if (PAGE === "/contributions") return loadContributions();
  if (PAGE === "/security") return loadSecurity();
  if (PAGE === "/feedback") return loadFeedback();
  return loadDashboard();
}
function setApp(html) {
  $("app").className = "";
  $("app").innerHTML = html;
}
function setError(error) {
  $("app").className = "loading error-text";
  $("app").innerHTML = esc(error.message || "加载失败");
  if (/Session|Unauthorized|Invalid/i.test(error.message || "")) login();
}
function applyAccountChrome(user, subscription) {
  const email = $("sidebarEmail");
  const plan = $("sidebarPlan");
  if (email) email.textContent = user?.email || "";
  if (plan) plan.textContent = planLabel(subscription);
}
function quotaPct(used, limit) {
  if (limit == null) return 0;
  return Math.min(100, Math.round((Number(used || 0) / limit) * 100));
}
function quotaText(used, limit) {
  return num(used) + " / " + (limit == null ? "∞" : num(limit));
}
function planLabel(s) {
  if (!s) return "";
  if (s.status === "expired") return (s.type || "Plus").toUpperCase() + " · 已到期";
  return s.plan || (s.effective_type || s.type || "Free");
}
function planRows(s) {
  const type = (s.type || "free").toLowerCase();
  if (type === "free") {
    return kv("套餐", esc(s.plan || "Free")) + kv("到期", "无到期");
  }
  if (s.status === "expired") {
    const name = (s.type || "plus").toUpperCase();
    return kv("套餐", esc(name) + " 已到期") + kv("说明", esc(name) + " 已于 " + day(s.expire_time) + " 到期，当前按 Free 额度计");
  }
  return kv("套餐", esc(s.plan || s.type)) + kv("有效至", day(s.expire_time));
}
function kv(label, value, extra) {
  return '<div class="kv"><span>' + label + "</span><strong" + (extra ? ' class="' + extra + '"' : "") + ">" + value + "</strong></div>";
}

async function loadDashboard() {
  activateNav();
  $("pageTitle").textContent = "Overview";
  try {
    const d = (await api("/api/user/dashboard")).data;
    const u = d.user;
    const s = d.subscription;
    const t = d.usage;
    applyAccountChrome(u, s);
    const inTok = Number(t.month.input_tokens || 0);
    const outTok = Number(t.month.output_tokens || 0);
    const splitTotal = inTok + outTok;
    const inPct = splitTotal ? (inTok / splitTotal) * 100 : 0;
    const outPct = splitTotal ? (outTok / splitTotal) * 100 : 0;
    const dp = quotaPct(t.today.requests, s.daily_request_limit);
    const mp = quotaPct(t.month.tokens, s.monthly_token_limit);
    const calls = d.recent_calls || [];
    const rows = calls.length
      ? calls
          .map((x) => {
            const ok = Number(x.status) >= 200 && Number(x.status) < 300;
            return (
              "<tr><td>" +
              datetime(x.created_at) +
              "</td><td>" +
              esc(x.model || "-") +
              "</td><td>" +
              num(x.input_tokens) +
              "</td><td>" +
              num(x.output_tokens) +
              "</td><td>" +
              num(x.tokens) +
              '</td><td class="' +
              (ok ? "ok" : "fail") +
              '">' +
              (ok ? "成功" : "失败") +
              "</td></tr>"
            );
          })
          .join("")
      : '<tr><td class="empty" colspan="6">暂无调用记录</td></tr>';
    setApp(
      '<section class="section usage">' +
        "<div><div class=\"metric\">" +
        num(t.month.tokens) +
        '</div><div class="metric-caption">本月 Token · 北京时间</div>' +
        (splitTotal
          ? '<div class="split" aria-hidden="true"><i style="width:' +
            inPct +
            '%"></i><b style="width:' +
            outPct +
            '%"></b></div>'
          : "") +
        "</div><div>" +
        kv("Input", num(t.month.input_tokens)) +
        kv("Output", num(t.month.output_tokens)) +
        kv("本月请求", num(t.month.requests)) +
        kv("今日请求", quotaText(t.today.requests, s.daily_request_limit)) +
        "</div></section>" +
        '<section class="section"><h2 class="section-title">Limits</h2>' +
        kv("今日请求", quotaText(t.today.requests, s.daily_request_limit)) +
        (s.daily_request_limit == null ? "" : '<div class="meter"><span style="width:' + dp + '%"></span></div>') +
        kv("本月 Token", quotaText(t.month.tokens, s.monthly_token_limit)) +
        (s.monthly_token_limit == null ? "" : '<div class="meter"><span style="width:' + mp + '%"></span></div>') +
        "</section>" +
        '<section class="section"><h2 class="section-title">Plan</h2>' +
        planRows(s) +
        "</section>" +
        '<section class="section"><h2 class="section-title">Account</h2>' +
        kv("Email", esc(u.email)) +
        kv("注册时间", day(u.created_at)) +
        kv("邮箱", u.email_verified ? "已验证" : "未验证", u.email_verified ? "" : "warn") +
        (u.status && u.status !== "active" ? kv("账号", esc(u.status), "warn") : "") +
        "</section>" +
        '<section class="section"><h2 class="section-title">Recent calls</h2>' +
        '<div class="tablewrap"><table><thead><tr><th>时间</th><th>模型</th><th>Input</th><th>Output</th><th>Total</th><th>状态</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div></section>"
    );
  } catch (e) {
    setError(e);
  }
}

async function loadContributions() {
  activateNav();
  $("pageTitle").textContent = "Contributions";
  try {
    const dashboard = (await api("/api/user/dashboard")).data;
    applyAccountChrome(dashboard.user, dashboard.subscription);
    const u = dashboard.user;
    const items = (await api("/api/user/contributions")).data || [];
    const labels = { pending: "待审核", approved: "已通过", rejected: "已打回" };
    const rows = items.length
      ? items
          .map(
            (c) =>
              '<div class="history-item"><strong>' +
              esc(c.contribution_type) +
              "</strong> · " +
              esc(labels[c.status] || c.status) +
              '<br><a href="' +
              esc(c.contribution_url) +
              '" target="_blank" rel="noopener">查看贡献链接</a>' +
              (c.awarded_membership
                ? "<br>已发放 " + esc(c.awarded_membership.toUpperCase()) + "，有效期至 " + day(c.membership_expires_at)
                : "") +
              (c.admin_reply ? '<br><span class="section-copy">审核回复：' + esc(c.admin_reply) + "</span>" : "") +
              "</div>"
          )
          .join("")
      : '<p class="section-copy">暂无贡献记录</p>';
    setApp(
      '<p class="page-lede">提交可公开访问的 Fork、Issue 或 Pull Request。审核通过后可获得会员权益。</p>' +
        '<div class="two"><section class="section"><h2 class="section-title">提交贡献</h2>' +
        '<form onsubmit="submitContribution(event)"><div class="form-grid"><div class="field"><label>贡献类型</label><select name="type"><option value="fork">Fork</option><option value="issue">Issue</option><option value="pull_request">Pull Request</option><option value="other">其他</option></select></div><div class="field"><label>邮箱</label><input name="email" type="email" required value="' +
        esc(u.email) +
        '"></div></div><div class="field"><label>贡献 URL</label><input name="url" type="url" required maxlength="2048" placeholder="https://github.com/..."></div><div class="field"><label>说明（可选）</label><textarea name="description" maxlength="2000" placeholder="请说明你做出的贡献"></textarea></div><div class="actions"><button class="btn btn-primary">提交贡献</button><span id="contributionMsg" class="msg"></span></div></form></section>' +
        '<section class="section"><h2 class="section-title">审核记录</h2><p class="section-copy">审核完成后工单会自动关闭，结果会通过邮件反馈。</p><div>' +
        rows +
        "</div></section></div>"
    );
  } catch (e) {
    setError(e);
  }
}
async function submitContribution(e) {
  e.preventDefault();
  const f = e.target;
  const m = $("contributionMsg");
  try {
    await api("/api/user/contributions", {
      method: "POST",
      body: JSON.stringify({
        contribution_url: f.url.value,
        email: f.email.value,
        contribution_type: f.type.value,
        description: f.description.value,
      }),
    });
    f.reset();
    f.email.value = "";
    m.textContent = "贡献已提交，等待审核";
    m.style.color = "var(--success)";
    loadContributions();
  } catch (x) {
    m.textContent = x.message;
    m.style.color = "var(--danger)";
  }
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
function credentialToJSON(credential) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response;
  const result = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
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
function decodeRegistrationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBuffer(options.challenge),
    user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: base64UrlToBuffer(item.id) })),
  };
}
async function addPasskey() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    passkeyMessage("当前浏览器不支持 Passkey", true);
    return;
  }
  const button = $("addPasskey");
  const name = $("passkeyName").value.trim() || "Passkey";
  button.disabled = true;
  try {
    const options = await api("/api/user/passkeys/register/options", { method: "POST", body: JSON.stringify({ name }) });
    const credential = await navigator.credentials.create({ publicKey: decodeRegistrationOptions(options.data.public_key) });
    if (!credential) throw Error("未创建 Passkey");
    await api("/api/user/passkeys/register/verify", {
      method: "POST",
      body: JSON.stringify({ challenge_token: options.data.challenge_token, response: credentialToJSON(credential) }),
    });
    passkeyMessage("Passkey 已绑定");
    loadSecurity();
  } catch (error) {
    passkeyMessage(error?.name === "NotAllowedError" ? "Passkey 绑定已取消" : "绑定失败: " + error.message, true);
  } finally {
    button.disabled = false;
  }
}
async function removePasskey(id) {
  if (!confirm("确定删除这个 Passkey 吗？删除后仍可使用其他登录方式。")) return;
  try {
    await api("/api/user/passkeys/" + encodeURIComponent(id), { method: "DELETE" });
    passkeyMessage("Passkey 已删除");
    loadSecurity();
  } catch (error) {
    passkeyMessage("删除失败: " + error.message, true);
  }
}
function passkeyMessage(text, bad = false) {
  const node = $("securityMessage");
  if (node) {
    node.textContent = text;
    node.style.color = bad ? "var(--danger)" : "var(--success)";
  }
}
async function loadSecurity() {
  activateNav();
  $("pageTitle").textContent = "Security";
  try {
    const { data } = await api("/api/user/passkeys");
    const rows = (data.passkeys || [])
      .map(
        (item) =>
          '<article class="history-item"><div class="kv" style="padding-top:0"><span><strong>' +
          esc(item.name || "Passkey") +
          '</strong></span><button class="btn" onclick="removePasskey(\'' +
          esc(item.id) +
          "')\">删除</button></div><p class=\"section-copy\">设备：" +
          esc(item.device_type || "未知") +
          " · 创建：" +
          datetime(item.created_at) +
          " · 最近使用：" +
          (item.last_used_at ? datetime(item.last_used_at) : "未使用") +
          "</p></article>"
      )
      .join("");
    setApp(
      '<p class="page-lede">管理用于登录 StudyPulse 的 Passkey。私钥始终保存在你的设备或密码管理器中。</p>' +
        '<section class="section"><h2 class="section-title">Passkey</h2>' +
        '<div class="form-grid"><div class="field"><label>设备名称</label><input id="passkeyName" maxlength="80" placeholder="例如：我的 iPhone"></div><div class="field passkey-actions"><button class="btn btn-primary" id="addPasskey" onclick="addPasskey()">添加 Passkey</button></div></div>' +
        '<p id="securityMessage" class="msg" role="status"></p>' +
        '<div style="margin-top:20px">' +
        (rows || '<p class="section-copy">暂未绑定 Passkey。</p>') +
        "</div></section>"
    );
  } catch (error) {
    setError(error);
  }
}

async function loadFeedback() {
  activateNav();
  $("pageTitle").textContent = "Feedback";
  try {
    const dashboard = (await api("/api/user/dashboard")).data;
    applyAccountChrome(dashboard.user, dashboard.subscription);
    const items = (await api("/api/user/feedback")).data.tickets || [];
    const priority = { normal: "普通", urgent: "紧急", top: "顶级" };
    const status = { pending: "待处理", processed: "已处理" };
    const tickets = items.length
      ? items
          .map(
            (t) =>
              '<article class="history-item"><div class="kv" style="padding-top:0"><strong>' +
              esc(t.subject) +
              "</strong><span>" +
              esc(status[t.status] || t.status) +
              '</span></div><p class="section-copy">' +
              datetime(t.created_at) +
              " · " +
              (priority[t.priority] || t.priority) +
              '</p><p style="white-space:pre-wrap;line-height:1.7">' +
              esc(t.content) +
              "</p>" +
              (t.admin_reply ? '<div class="reply-box"><strong>处理回复</strong><br>' + esc(t.admin_reply) + "</div>" : "") +
              "</article>"
          )
          .join("")
      : '<p class="section-copy">暂无异常反馈记录</p>';
    setApp(
      '<p class="page-lede">提交使用中遇到的问题，并跟踪处理进度。</p>' +
        '<div class="two"><section class="section"><h2 class="section-title">提交反馈</h2>' +
        '<form onsubmit="submitFeedback(event)"><div class="field"><label>主题</label><input name="subject" maxlength="120" required placeholder="例如：对话页面无法加载"></div><div class="form-grid"><div class="field"><label>优先级</label><select name="priority"><option value="normal">普通</option><option value="urgent">紧急</option><option value="top">顶级 · Pro 专享</option></select></div><div class="field"><label>账号</label><input value="' +
        esc(dashboard.user.email) +
        '" disabled></div></div><div class="field"><label>反馈内容</label><textarea name="content" maxlength="5000" required placeholder="请描述遇到的异常..."></textarea></div><div class="actions"><button class="btn btn-primary">提交反馈</button><span id="feedbackMsg" class="msg"></span></div></form></section>' +
        '<section class="section"><h2 class="section-title">反馈记录</h2><p class="section-copy">处理完成后会在这里显示回复内容。</p><div>' +
        tickets +
        "</div></section></div>"
    );
  } catch (e) {
    setError(e);
  }
}
async function submitFeedback(e) {
  e.preventDefault();
  const form = e.target;
  const msg = $("feedbackMsg");
  try {
    await api("/api/user/feedback", {
      method: "POST",
      body: JSON.stringify({ subject: form.subject.value, content: form.content.value, priority: form.priority.value }),
    });
    form.reset();
    msg.textContent = "反馈已提交，等待处理";
    msg.style.color = "var(--success)";
    loadFeedback();
  } catch (error) {
    msg.textContent = error.message;
    msg.style.color = "var(--danger)";
  }
}

activateNav();
if (PAGE === "/contributions") loadContributions();
else if (PAGE === "/security") loadSecurity();
else if (PAGE === "/feedback") loadFeedback();
else loadDashboard();
