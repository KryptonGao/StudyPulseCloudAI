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
function beginRefresh() {
  const button = $("refreshButton");
  const status = $("lastUpdated");
  if (button) {
    button.disabled = true;
    button.classList.add("is-loading");
  }
  if (status) status.textContent = "正在更新…";
}
function finishRefresh(ok = true) {
  const button = $("refreshButton");
  const status = $("lastUpdated");
  if (button) {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
  if (status) {
    status.textContent = ok
      ? "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      : "更新失败";
  }
}
function setApp(html) {
  $("app").className = "";
  $("app").innerHTML = html;
  finishRefresh();
}
function setError(error) {
  $("app").className = "loading error-text";
  $("app").innerHTML = esc(error.message || "加载失败");
  finishRefresh(false);
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
function planLabel(s) {
  if (!s) return "";
  return s.plan || (s.effective_type || s.type || "Free").toUpperCase();
}
function kv(label, value, extra) {
  return '<div class="kv"><span>' + label + "</span><strong" + (extra ? ' class="' + extra + '"' : "") + ">" + value + "</strong></div>";
}
function trendMarkup(rawPoints) {
  const all = Array.isArray(rawPoints) ? rawPoints.slice(-14) : [];
  const points = all.slice(-7);
  const previous = all.slice(-14, -7).reduce((sum, point) => sum + Number(point.tokens || 0), 0);
  const current = points.reduce((sum, point) => sum + Number(point.tokens || 0), 0);
  const peak = Math.max(1, ...points.map((point) => Number(point.tokens || 0)));
  let compare = "近两周暂无用量";
  let compareClass = "";
  if (previous > 0) {
    const change = Math.round(((current - previous) / previous) * 100);
    compare = "较前 7 天 " + (change > 0 ? "+" : "") + change + "%";
    compareClass = change > 0 ? "up" : change < 0 ? "down" : "";
  } else if (current > 0) {
    compare = "前 7 天无用量";
  }
  const columns = points
    .map((point) => {
      const tokens = Number(point.tokens || 0);
      const height = tokens ? Math.max(4, (tokens / peak) * 100) : 2;
      const label = String(point.day || "").slice(5).replace("-", "/");
      return (
        '<div class="trend-column" title="' + esc(point.day) + " · " + num(tokens) + ' Token">' +
        '<div class="trend-bar-track"><i class="trend-bar" style="height:' + height + '%"></i></div>' +
        '<span class="trend-day">' + esc(label) + "</span></div>"
      );
    })
    .join("");
  return (
    '<div class="usage-trend"><div class="trend-head"><span class="trend-title">近 7 天 Token · ' + num(current) + "</span>" +
    '<span class="trend-compare ' + compareClass + '">' + compare + "</span></div>" +
    '<div class="trend-chart" role="img" aria-label="近 7 天 Token 用量趋势">' + columns + "</div></div>"
  );
}
function quotaMarkup(label, used, limit, note) {
  const amount = Number(used || 0);
  if (limit == null) {
    return '<div class="quota-item"><span class="quota-label">' + label + '</span><div class="quota-value">不限</div><div class="quota-meta">已用 ' + num(amount) + " · " + note + "</div></div>";
  }
  const total = Number(limit);
  const remaining = Math.max(0, total - amount);
  const exceeded = amount > total;
  const value = exceeded ? "已超出 " + num(amount - total) : "剩余 " + num(remaining);
  return (
    '<div class="quota-item"><span class="quota-label">' + label + '</span><div class="quota-value' + (exceeded ? " danger" : "") + '">' + value + "</div>" +
    '<div class="quota-meta">共 ' + num(total) + " · 已用 " + num(amount) + " · " + note + "</div>" +
    '<div class="meter' + (exceeded ? " exceeded" : "") + '"><span style="width:' + quotaPct(amount, total) + '%"></span></div></div>'
  );
}

async function loadDashboard() {
  activateNav();
  beginRefresh();
  $("pageTitle").textContent = "概览";
  try {
    const d = (await api("/api/user/dashboard")).data;
    const u = d.user;
    const s = d.subscription;
    const t = d.usage;
    const quota = t.quota || { day: { requests: t.today.requests }, month: { tokens: t.month.tokens } };
    applyAccountChrome(u, s);
    const inTok = Number(t.month.input_tokens || 0);
    const outTok = Number(t.month.output_tokens || 0);
    const splitTotal = inTok + outTok;
    const inPct = splitTotal ? (inTok / splitTotal) * 100 : 0;
    const outPct = splitTotal ? (outTok / splitTotal) * 100 : 0;
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
              '"><span class="status-text"><i class="status-dot ' +
              (ok ? "success" : "danger") +
              '"></i>' +
              (ok ? "成功" : "失败") +
              "</span></td></tr>"
            );
          })
          .join("")
      : '<tr><td class="empty" colspan="6">暂无调用记录</td></tr>';
    const transitionNote = s.status === "expired" ? "自 " + day(quota.month.starts_at) + " 起按 Free 额度统计" : "北京时间自然月";
    const currentPlan = esc(s.plan || (s.effective_type || "free").toUpperCase());
    const planState = s.status === "expired"
      ? '<span class="status-text"><i class="status-dot danger"></i>原 ' + esc((s.type || "pro").toUpperCase()) + " 权益已于 " + day(s.expire_time) + " 到期</span>"
      : s.expire_time
        ? "有效期至 " + day(s.expire_time)
        : "基础额度 · 无到期时间";
    const accountActive = !u.status || u.status === "active";
    setApp(
      '<section class="dashboard-section"><div class="section-heading"><h2 class="section-title">用量概览</h2><p class="section-note">北京时间 · 本月累计</p></div>' +
        '<div class="usage-overview"><div class="usage-primary"><span class="metric-label">本月 Token</span><div class="metric">' +
        num(t.month.tokens) +
        '</div><div class="metric-secondary">' + num(t.month.requests) + " 次请求</div></div>" +
        trendMarkup(t.trend) +
        '</div><div class="token-mix"><span class="token-mix-title">Token 构成</span><div><div class="token-mix-bar" aria-label="输入与输出 Token 比例"><i style="width:' +
        inPct +
        '%"></i><b style="width:' +
        outPct +
        '%"></b></div><div class="token-mix-legend"><span>输入 <strong>' +
        num(inTok) +
        " · " + Math.round(inPct) +
        '%</strong></span><span>输出 <strong>' +
        num(outTok) +
        " · " + Math.round(outPct) +
        "%</strong></span></div></div></div></section>" +
        '<section class="dashboard-section"><div class="section-heading"><h2 class="section-title">当前额度</h2><p class="section-note">' +
        currentPlan +
        " 套餐</p></div><div class=\"limits-grid\">" +
        quotaMarkup("每日请求额度", quota.day.requests, s.daily_request_limit, "每日 00:00 重置") +
        quotaMarkup("月度 Token 额度", quota.month.tokens, s.monthly_token_limit, transitionNote) +
        "</div></section>" +
        '<section class="dashboard-section settings-section"><div class="section-heading"><h2 class="section-title">套餐</h2></div><div class="plan-summary"><div><div class="plan-name">' +
        currentPlan +
        '</div><div class="detail-status"><span class="status-text"><i class="status-dot success"></i>当前生效</span></div></div><p class="plan-description">' +
        planState +
        "</p></div></section>" +
        '<section class="dashboard-section settings-section"><div class="section-heading"><h2 class="section-title">账户</h2></div><div class="detail-list"><div><span class="detail-label">邮箱</span><span class="detail-value">' +
        esc(u.email) +
        '</span><span class="detail-status status-text"><i class="status-dot ' +
        (u.email_verified ? "success" : "danger") +
        '"></i>' +
        (u.email_verified ? "已验证" : "未验证") +
        '</span></div><div><span class="detail-label">注册时间</span><span class="detail-value">' +
        day(u.created_at) +
        '</span></div><div><span class="detail-label">账户状态</span><span class="detail-value status-text"><i class="status-dot ' +
        (accountActive ? "success" : "danger") +
        '"></i>' +
        (accountActive ? "正常" : esc(u.status)) +
        "</span></div></div></section>" +
        '<section class="dashboard-section recent-section"><div class="section-heading"><h2 class="section-title">最近调用</h2><p class="section-note">最近 8 条</p></div>' +
        '<div class="tablewrap"><table><thead><tr><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>总计</th><th>状态</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div></section>"
    );
  } catch (e) {
    setError(e);
  }
}

async function loadContributions() {
  activateNav();
  beginRefresh();
  $("pageTitle").textContent = "贡献";
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
  beginRefresh();
  $("pageTitle").textContent = "安全";
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
  beginRefresh();
  $("pageTitle").textContent = "反馈";
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
