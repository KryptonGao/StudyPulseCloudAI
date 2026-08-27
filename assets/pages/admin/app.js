// ── State ──
let authToken = "";
let csrfToken = "";
let hasCfAccess = false;
const TREND_RANGES = ["1D", "3D", "1W", "2W", "1M", "3M", "6M", "1Y"];
const trendRangeState = { calls: "1D", tokens: "1D" };

// ── Init (错误保护：任何异常都降级到登录表单) ──
(function init() {
  try {
    authToken = sessionStorage.getItem("admin_token") || "";
    csrfToken = document.querySelector('meta[name="csrf-token"]').content;
    hasCfAccess = document.querySelector('meta[name="has-cf-access"]').content === "1";
  } catch (e) {
    console.error("Admin init error:", e);
  }

  // Tabs
  try {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
  } catch (e) {}

  // 尝试自动认证
  try {
    if (hasCfAccess || authToken) {
      initApp();
    } else {
      showLogin();
    }
  } catch (e) {
    console.error("Admin auth flow error:", e);
    showLogin(); // 降级：显示登录表单
  }
})();

// ── Auth ──
function showLogin() {
  document.getElementById("loadingOverlay").style.display = "none";
  document.getElementById("loginOverlay").style.display = "flex";
}

// 兜底：5 秒后如果还在 loading 就显示登录
setTimeout(() => {
  var lo = document.getElementById("loadingOverlay");
  if (lo && lo.style.display !== "none") showLogin();
}, 5000);

function doLogin() {
  const token = document.getElementById("loginToken").value.trim();
  if (!token) return;
  authToken = token;
  document.getElementById("loginOverlay").style.display = "none";
  document.getElementById("loadingOverlay").style.display = "flex";
  document.getElementById("loginError").style.display = "none";
  apiCall("GET", "/api/admin/stats").then(r => {
    if (r.ok) {
      sessionStorage.setItem("admin_token", token);
      initApp();
    } else {
      authToken = "";
      document.getElementById("loadingOverlay").style.display = "none";
      document.getElementById("loginOverlay").style.display = "flex";
      document.getElementById("loginError").textContent = "Token 无效";
      document.getElementById("loginError").style.display = "block";
    }
  }).catch(e => {
    authToken = "";
    document.getElementById("loadingOverlay").style.display = "none";
    document.getElementById("loginOverlay").style.display = "flex";
    document.getElementById("loginError").textContent = "网络错误: " + (e.message || "请检查连接");
    document.getElementById("loginError").style.display = "block";
  });
}

function doLogout() {
  sessionStorage.removeItem("admin_token");
  authToken = "";
  hasCfAccess = false;
  document.getElementById("mainNav").style.display = "none";
  document.querySelectorAll(".tab-content").forEach(c => c.style.display = "none");
  showLogin();
}

async function initApp() {
  document.getElementById("loadingOverlay").style.display = "none";
  document.getElementById("loginOverlay").style.display = "none";
  document.getElementById("mainNav").style.display = "flex";
  document.querySelectorAll(".tab-content").forEach(c => c.style.display = "");
  document.getElementById("tab-dashboard").classList.add("active");
  updateLoginStatus(true);
  loadDashboard();
}

function updateLoginStatus(online) {
  const el = document.getElementById("loginStatus");
  const btn = document.getElementById("btnLogout");
  const topbar = document.getElementById("topbarStatus");
  if (!el || !btn) return;
  if (online) {
    el.textContent = hasCfAccess ? "Cloudflare Access" : "已连接";
    el.style.color = "var(--success)";
    if (topbar) topbar.textContent = hasCfAccess ? "Cloudflare Access" : "安全连接";
    btn.style.display = "";
  }
}

// ── API ──
async function apiCall(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  // CSRF token from meta tag
  headers["X-CSRF-Token"] = csrfToken;
  if (authToken) headers["Authorization"] = "Bearer " + authToken;

  // 确保 header 值仅含 Latin-1（浏览器 fetch 不允许以外字符）
  for (const k of Object.keys(headers)) {
    const v = String(headers[k]);
    let safe = "";
    for (let i = 0; i < v.length; i++) {
      if (v.charCodeAt(i) <= 0xFF) safe += v[i];
    }
    headers[k] = safe;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  if (res.status === 401) {
    if (authToken) {
      sessionStorage.removeItem("admin_token");
      authToken = "";
    }
    if (!hasCfAccess) showLogin();
  }
  return res;
}

async function apiJson(method, path, body) {
  const res = await apiCall(method, path, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Tabs ──
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === "tab-" + name));
  const titles = { dashboard: "仪表盘", keys: "Key 管理", users: "用户管理", blacklist: "封禁用户", appeals: "申诉管理", tickets: "反馈工单", "ticket-archive": "已处理归档", contributions: "代码贡献审核", logs: "请求日志" };
  const title = document.getElementById("pageTitle");
  if (title) title.textContent = titles[name] || "管理后台";
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.remove("open");
  if (name === "dashboard") loadDashboard();
  else if (name === "keys") loadKeys();
  else if (name === "users") loadUsers();
  else if (name === "blacklist") loadBlacklist();
  else if (name === "appeals") loadAppeals();
  else if (name === "tickets") loadTickets();
  else if (name === "ticket-archive") loadTicketArchive();
  else if (name === "contributions") loadContributions();
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.toggle("open");
}

// ── Dashboard ──
async function loadDashboard() {
  try {
    const { data } = await apiJson("GET", "/api/admin/stats");
    const cards = document.querySelectorAll(".stat-value");
    cards[0].textContent = data.totalKeys;
    cards[1].textContent = data.enabledKeys;
    cards[2].textContent = data.totalRequests;
    cards[3].textContent = data.totalUsers ?? "-";
    cards.forEach(c => c.classList.remove("skeleton"));
    const rate = data.totalKeys ? Math.round((data.enabledKeys / data.totalKeys) * 100) : 0;
    const rateEl = document.getElementById("enabledRate");
    const fill = document.getElementById("healthMeterFill");
    const pill = document.getElementById("healthPill");
    const headline = document.getElementById("healthHeadline");
    const detail = document.getElementById("healthDetail");
    if (rateEl) rateEl.textContent = rate + "%";
    if (fill) fill.style.width = rate + "%";
    if (pill) {
      pill.textContent = data.exceededQuotaKeys ? data.exceededQuotaKeys + " 个需关注" : "运行良好";
      pill.style.background = data.exceededQuotaKeys ? "#fff7ed" : "#f0fdf4";
      pill.style.color = data.exceededQuotaKeys ? "#c2410c" : "var(--success)";
    }
    if (headline) headline.textContent = data.exceededQuotaKeys ? "有 Key 达到用量上限" : "所有资源运行正常";
    if (detail) detail.textContent = data.exceededQuotaKeys ? data.exceededQuotaKeys + " 个 Key 需要检查" : rate + "% 的 Key 处于启用状态";
    renderTrendRangeSwitches();
    await Promise.all([loadTrend("calls"), loadTrend("tokens")]);
  } catch (e) {
    showToast("加载仪表盘失败: " + e.message, "error");
  }
}

function renderTrendRangeSwitches() {
  document.querySelectorAll(".range-switch").forEach((switcher) => {
    const type = switcher.dataset.trend;
    switcher.innerHTML = TREND_RANGES.map((range) => '<button type="button" class="' + (trendRangeState[type] === range ? "active" : "") + '" onclick="changeTrendRange(\'' + type + '\',\'' + range + '\')">' + range + '</button>').join("");
  });
}

async function changeTrendRange(type, range) {
  trendRangeState[type] = range;
  renderTrendRangeSwitches();
  await loadTrend(type);
}

async function loadTrend(type) {
  const container = document.getElementById(type === "calls" ? "callsTrend" : "tokensTrend");
  if (!container) return;
  container.innerHTML = '<div class="trend-empty">加载中...</div>';
  try {
    const { data } = await apiJson("GET", "/api/admin/usage-trend?range=" + trendRangeState[type]);
    renderTrend(container, data.points || [], type, data.range);
  } catch (e) {
    container.innerHTML = '<div class="trend-empty error-text">加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderTrend(container, points, type, range) {
  const key = type === "calls" ? "calls" : "tokens";
  const values = points.map((point) => Number(point[key]) || 0);
  if (!values.length || values.every((value) => value === 0)) {
    container.innerHTML = '<div class="trend-empty">该时间范围暂无数据</div>';
    return;
  }
  const width = 720, height = 220, left = 42, right = 12, top = 12, bottom = 30;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(...values, 1), step = values.length > 1 ? plotWidth / (values.length - 1) : plotWidth;
  const coords = values.map((value, index) => [left + (values.length === 1 ? plotWidth / 2 : index * step), top + plotHeight - (value / max) * plotHeight]);
  const path = coords.map((point, index) => (index ? "L" : "M") + point[0].toFixed(1) + " " + point[1].toFixed(1)).join(" ");
  const area = path + " L " + coords[coords.length - 1][0].toFixed(1) + " " + (top + plotHeight) + " L " + coords[0][0].toFixed(1) + " " + (top + plotHeight) + " Z";
  const color = type === "calls" ? "#2563eb" : "#7c3aed";
  const grid = [0, .5, 1].map((ratio) => { const y = top + plotHeight * ratio; const label = Math.round(max * (1 - ratio)).toLocaleString(); return '<line x1="' + left + '" y1="' + y + '" x2="' + (width - right) + '" y2="' + y + '" stroke="#e5e7eb" stroke-dasharray="3 4"/><text x="' + (left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="#9ca3af" font-size="10">' + label + '</text>'; }).join("");
  const middle = Math.floor((points.length - 1) / 2);
  const labels = [0, middle, points.length - 1].map((pointIndex, index) => '<text x="' + coords[pointIndex][0] + '" y="' + (height - 8) + '" text-anchor="' + (index === 0 ? "start" : index === 2 ? "end" : "middle") + '" fill="#9ca3af" font-size="10">' + formatTrendBucket(points[pointIndex].bucket, range) + '</text>').join("");
  const dots = coords.map((point, index) => '<circle cx="' + point[0] + '" cy="' + point[1] + '" r="3.5" fill="#fff" stroke="' + color + '" stroke-width="2"><title>' + formatTrendBucket(points[index].bucket, range) + ' · ' + values[index].toLocaleString() + (type === "calls" ? " 次" : " tokens") + '</title></circle>').join("");
  container.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + (type === "calls" ? "调用次数" : "Token 用量") + '">' + grid + '<path d="' + area + '" fill="' + color + '" opacity=".08"/><path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' + dots + labels + '</svg><div class="trend-meta"><span>纵轴：' + (type === "calls" ? "调用次数" : "Token 数量") + '</span><span>数据点：' + points.length + '</span></div>';
}

function formatTrendBucket(bucket, range) {
  if (!bucket) return "";
  if (range === "1D") return bucket.slice(11, 16);
  if (range === "1Y") return bucket.slice(0, 7);
  return bucket.slice(5, 10);
}

// ── Keys ──
async function loadKeys() {
  const container = document.getElementById("keysTableContainer");
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const { data } = await apiJson("GET", "/api/admin/keys");
    if (data.length === 0) {
      container.innerHTML = '<p class="empty-state">暂无 API Key</p>';
      return;
    }
    container.innerHTML = renderKeysTable(data);
  } catch (e) {
    container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>';
  }
}

function renderKeysTable(keys) {
  // 将 key 数据存入全局映射，避免在 onclick 中拼 JSON
  window._keyData = {};
  keys.forEach(k => { window._keyData[k.id] = k; });

  const rows = keys.map(k => {
    const enabled = k.enabled === 1;
    const limitType = k.limit_type || "count";
    const currentUsage = limitType === "tokens" ? (k.token_count ?? 0) : (k.request_count ?? 0);
    const exceeded = k.request_limit !== null && currentUsage >= k.request_limit;
    let statusHtml = enabled
      ? '<span class="status-badge status-enabled">启用</span>'
      : '<span class="status-badge status-disabled">停用</span>';
    if (exceeded) statusHtml += ' <span class="status-badge status-exceeded">超额</span>';
    if (limitType === "tokens") statusHtml += ' <span class="status-badge" style="background:#e0e7ff;color:#3730a3">Token制</span>';

    const usageLabel = limitType === "tokens"
      ? k.token_count + ' tokens / ' + (k.request_limit != null ? k.request_limit + ' tokens' : '\u221e')
      : k.request_count + '次 / ' + (k.request_limit != null ? k.request_limit + '次' : '\u221e');
    const usagePercent = k.request_limit != null ? Math.min(100, Math.round((currentUsage / k.request_limit) * 100)) : 0;
    const usageHtml = '<div class="usage-cell"><div class="usage-label"><span>' + usageLabel + '</span>' + (k.request_limit != null ? '<b>' + usagePercent + '%</b>' : '') + '</div>' + (k.request_limit != null ? '<div class="usage-bar"><span style="width:' + usagePercent + '%"></span></div>' : '<div class="usage-unlimited">不限量</div>') + '</div>';

    return '<tr>' +
      '<td>' + k.id + '</td>' +
      '<td>' + escapeHtml(k.name) + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td>' + usageHtml + '</td>' +
      '<td>' + (k.expires_at ? formatDate(k.expires_at) : '-') + '</td>' +
      '<td>' + formatDate(k.created_at) + '</td>' +
      '<td>' + (k.last_used_at ? formatDate(k.last_used_at) : '\u4ece\u672a\u4f7f\u7528') + '</td>' +
      '<td>' + escapeHtml(k.notes || '-') + '</td>' +
      '<td class="actions-cell">' +
        '<button class="btn btn-sm btn-outline" onclick="showEditModal(' + k.id + ')">编辑</button>' +
        '<button class="btn btn-sm btn-outline" onclick="confirmResetQuota(' + k.id + ', \'' + escapeHtml(k.name) + '\')">重置配额</button>' +
        '<button class="btn btn-sm btn-danger" onclick="confirmDelete(' + k.id + ', \'' + escapeHtml(k.name) + '\')">删除</button>' +
      '</td>' +
    '</tr>';
  }).join("");

  return '<table><thead><tr>' +
    '<th>ID</th><th>名称</th><th>状态</th><th>用量</th>' +
    '<th>过期时间</th><th>创建时间</th><th>最后使用</th><th>备注</th><th>操作</th>' +
  '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Create Key ──
function showCreateModal() {
  document.getElementById("formCreate").reset();
  document.getElementById("createResult").style.display = "none";
  document.getElementById("formCreate").style.display = "";
  document.getElementById("modal-create").style.display = "flex";
}

async function handleCreate(e) {
  e.preventDefault();
  const form = e.target;
  const userId = form.user_id.value.trim();
  if (!userId) { showToast("请输入用户 ID", "error"); return; }
  const body = { name: form.name.value.trim(), user_id: userId };
  body.limit_type = form.limit_type.value;
  const limit = form.request_limit.value.trim();
  if (limit) body.request_limit = parseInt(limit);
  if (form.notes.value.trim()) body.notes = form.notes.value.trim();
  if (form.expires_at.value) body.expires_at = new Date(form.expires_at.value).toISOString();

  try {
    const { data } = await apiJson("POST", "/api/admin/keys/create", body);
    form.style.display = "none";
    const resultDiv = document.getElementById("createResult");
    resultDiv.innerHTML =
      '<div class="key-display">' +
        '<strong>API Key 创建成功 (ID: ' + data.id + ')</strong>' +
        '<code id="newKey">' + data.rawKey + '</code>' +
        '<button class="btn btn-sm btn-outline" onclick="copyKey()">复制</button>' +
        '<span id="copyMsg" class="copy-success" style="display:none">已复制</span>' +
        '<p class="key-warning">此 Key 仅显示一次，请立即复制并安全保存。关闭后无法找回。</p>' +
      '</div>' +
      '<div style="margin-top:12px">' +
        '<button class="btn btn-primary" onclick="closeModal(\'modal-create\'); loadKeys();">完成</button>' +
      '</div>';
    resultDiv.style.display = "block";
  } catch (e) {
    showToast("创建失败: " + e.message, "error");
  }
}

function copyKey() {
  const code = document.getElementById("newKey");
  navigator.clipboard.writeText(code.textContent).then(() => {
    document.getElementById("copyMsg").style.display = "inline";
    setTimeout(() => { document.getElementById("copyMsg").style.display = "none"; }, 2000);
  });
}

// ── Edit Key ──
function showEditModal(id) {
  const key = window._keyData && window._keyData[id];
  if (!key) return;
  const form = document.getElementById("formEdit");
  form.id.value = key.id;
  form.name.value = key.name;
  form.enabled.value = key.enabled;
  form.request_limit.value = key.request_limit != null ? key.request_limit : "";
  form.limit_type.value = key.limit_type || "count";
  form.notes.value = key.notes || "";
  form.expires_at.value = key.expires_at ? key.expires_at.slice(0, 16) : "";
  document.getElementById("modal-edit").style.display = "flex";
}

async function handleEdit(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    id: parseInt(form.id.value),
    name: form.name.value.trim(),
    enabled: parseInt(form.enabled.value),
  };
  const limit = form.request_limit.value.trim();
  body.request_limit = limit ? parseInt(limit) : null;
  body.limit_type = form.limit_type.value;
  body.notes = form.notes.value.trim() || null;
  body.expires_at = form.expires_at.value ? new Date(form.expires_at.value).toISOString() : null;

  try {
    await apiJson("POST", "/api/admin/keys/update", body);
    closeModal("modal-edit");
    loadKeys();
    showToast("更新成功", "success");
  } catch (e) {
    showToast("更新失败: " + e.message, "error");
  }
}

// ── Delete Key ──
function confirmDelete(id, name) {
  showConfirm("删除 API Key", '确定要删除 Key "' + name + '" (ID: ' + id + ') 吗？此操作不可撤销，关联的请求日志将被同时删除。', async () => {
    try {
      await apiJson("POST", "/api/admin/keys/delete", { id: id });
      closeModal("modal-confirm");
      loadKeys();
      showToast("已删除", "success");
    } catch (e) {
      showToast("删除失败: " + e.message, "error");
    }
  });
}

// ── Reset Quota ──
function confirmResetQuota(id, name) {
  showConfirm("重置配额", '确定要将 Key "' + name + '" (ID: ' + id + ') 的请求计数重置为 0 吗？', async () => {
    try {
      await apiJson("POST", "/api/admin/keys/reset-quota", { id: id });
      closeModal("modal-confirm");
      loadKeys();
      showToast("配额已重置", "success");
    } catch (e) {
      showToast("重置失败: " + e.message, "error");
    }
  });
}

// ── Logs ──
async function loadLogs() {
  const container = document.getElementById("logsTableContainer");
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const keyId = document.getElementById("logFilterKeyId").value.trim();
    const userId = document.getElementById("logFilterUserId").value.trim();
    const callMethod = document.getElementById("logFilterCallMethod").value;
    const status = document.getElementById("logFilterStatus").value;
    const params = new URLSearchParams();
    if (keyId) params.set("api_key_id", keyId);
    if (userId) params.set("user_id", userId);
    if (callMethod) params.set("call_method", callMethod);
    if (status) params.set("status", status);
    const { data } = await apiJson("GET", "/api/admin/logs?" + params.toString());
    if (data.length === 0) {
      container.innerHTML = '<p class="empty-state">暂无日志</p>';
      return;
    }
    container.innerHTML = renderLogsTable(data);
  } catch (e) {
    container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>';
  }
}

function renderLogsTable(logs) {
  const rows = logs.map(l => {
    const statusClass = l.status >= 200 && l.status < 300 ? "status-enabled" : "status-disabled";
    const callMethodLabel = l.call_method === "api_key"
      ? '<span class="status-badge" style="background:#dbeafe;color:#1e40af">API Key</span>'
      : '<span class="status-badge" style="background:#fef3c7;color:#92400e">Session</span>';
    return '<tr>' +
      '<td>' + l.id + '</td>' +
      '<td>' + callMethodLabel + '</td>' +
      '<td>' + l.api_key_id + ' (' + escapeHtml(l.key_name || '-') + ')</td>' +
      '<td>' + escapeHtml(l.user_email || (l.user_id ? l.user_id.slice(0, 8) + '...' : '-')) + '</td>' +
      '<td>' + formatDate(l.request_time) + '</td>' +
      '<td>' + (l.model || '-') + '</td>' +
      '<td><span class="status-badge ' + statusClass + '">' + l.status + '</span></td>' +
      '<td>' + (l.latency_ms != null ? l.latency_ms + 'ms' : '-') + '</td>' +
      '<td>' + (l.prompt_tokens != null ? l.prompt_tokens : '-') + ' / ' + (l.completion_tokens != null ? l.completion_tokens : '-') + ' / ' + (l.total_tokens != null ? l.total_tokens : '-') + '</td>' +
      '<td>' + escapeHtml((l.user_agent || '').slice(0, 60)) + '</td>' +
      '<td>' + escapeHtml((l.error_message || '').slice(0, 80)) + '</td>' +
    '</tr>';
  }).join("");

  return '<table><thead><tr>' +
    '<th>ID</th><th>方式</th><th>Key</th><th>用户</th><th>时间</th><th>模型</th>' +
    '<th>状态</th><th>延迟</th><th>Tokens (P/C/T)</th>' +
    '<th>客户端</th><th>错误</th>' +
  '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── User Management ──
async function loadUsers() {
  const container = document.getElementById("usersTableContainer");
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const search = document.getElementById("userSearch").value.trim();
    const role = document.getElementById("userRoleFilter").value;
    const membership = document.getElementById("userMemberFilter").value;
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (role) params.set("role", role);
    if (membership) params.set("membership", membership);
    const { data } = await apiJson("GET", "/api/admin/users?" + params.toString());
    if (data.length === 0) {
      container.innerHTML = '<p class="empty-state">暂无用户</p>';
      return;
    }
    window._userData = {};
    data.forEach(u => { window._userData[u.id] = u; });
    container.innerHTML = renderUsersTable(data);
  } catch (e) {
    container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>';
  }
}

function renderUsersTable(users) {
  const rows = users.map(u => {
    const roleBadge = u.role === "admin"
      ? '<span class="status-badge" style="background:#fef3c7;color:#92400e">管理员</span>'
      : '<span class="status-badge" style="background:#e0e7ff;color:#3730a3">用户</span>';
    const verified = u.email_verified === 1
      ? '<span class="status-badge status-enabled">已验证</span>'
      : '<span class="status-badge status-disabled">未验证</span>';
    const githubBound = u.github_bound === 1
      ? '<span class="status-badge status-enabled">已绑定</span>'
      : '<span class="status-badge status-disabled">未绑定</span>';
    const passwordSet = u.password_set === 1
      ? '<span class="status-badge status-enabled">已设置</span>'
      : '<span class="status-badge status-disabled">未设置</span>';
    const passkeyBound = u.passkey_bound === 1
      ? '<span class="status-badge status-enabled">已绑定</span>'
      : '<span class="status-badge status-disabled">未绑定</span>';
    const memberLabels = { free: "Free", plus: "Plus", pro: "Pro" };
    const memberBadge = u.membership_type === "pro"
      ? '<span class="status-badge" style="background:#d1fae5;color:#065f46">Pro</span>'
      : u.membership_type === "plus"
        ? '<span class="status-badge" style="background:#dbeafe;color:#1e40af">Plus</span>'
        : '<span class="status-badge" style="background:#f1f5f9;color:#64748b">Free</span>';

    return '<tr>' +
      '<td>' + escapeHtml(u.id.slice(0,8)) + '...</td>' +
      '<td>' + escapeHtml(u.email) + '</td>' +
      '<td>' + verified + '</td>' +
      '<td>' + githubBound + '</td>' +
      '<td>' + passwordSet + '</td>' +
      '<td>' + passkeyBound + (u.passkey_count > 0 ? ' <small>(' + u.passkey_count + ')</small>' : '') + '</td>' +
      '<td>' + roleBadge + '</td>' +
      '<td>' + memberBadge + '</td>' +
      '<td>' + (u.membership_expires_at ? formatDate(u.membership_expires_at) : "-") + '</td>' +
      '<td>' + formatDate(u.created_at) + '</td>' +
      '<td class="actions-cell">' +
        '<button class="btn btn-sm btn-outline" onclick="showUserDetail(\'' + u.id + '\')">详情</button>' +
      '</td>' +
    '</tr>';
  }).join("");

  return '<table><thead><tr>' +
    '<th>ID</th><th>邮箱</th><th>验证</th><th>GitHub</th><th>密码</th><th>Passkey</th><th>角色</th><th>会员</th>' +
    '<th>到期时间</th><th>注册时间</th><th>操作</th>' +
  '</tr></thead><tbody>' + rows + '</tbody></table>';
}

async function showUserDetail(userId) {
  document.getElementById("userDetailContent").innerHTML = '<p class="empty-state">加载中...</p>';
  document.getElementById("modal-user").style.display = "flex";
  try {
    const userPath = "/api/admin/users/" + encodeURIComponent(userId);
    const { data: user } = await apiJson("GET", userPath);
    const { data: keys } = await apiJson("GET", userPath + "/keys");
    let sessions = [];
    try {
      ({ data: sessions } = await apiJson("GET", userPath + "/sessions"));
    } catch (sessionError) {
      // Session 列表不是用户详情的核心数据，兼容旧数据库/部署时不阻断详情加载。
      console.warn("Failed to load user sessions", sessionError);
    }
    const { data: stats } = await apiJson("GET", userPath + "/stats");

    const roleBadge = user.role === "admin" ? "管理员" : "用户";
    const memberLabels = { free: "Free", plus: "Plus", pro: "Pro" };

    let keysHtml = '<p class="text-muted" style="margin-top:12px">API Keys (' + (keys ? keys.length : 0) + '个)</p>';
    if (keys && keys.length > 0) {
      keysHtml += '<div class="table-container"><table><thead><tr><th>ID</th><th>名称</th><th>状态</th><th>用量</th><th>操作</th></tr></thead><tbody>';
      keys.forEach(k => {
        const enabled = k.enabled === 1 ? '<span class="status-badge status-enabled">启用</span>' : '<span class="status-badge status-disabled">停用</span>';
        keysHtml += '<tr><td>' + k.id + '</td><td>' + escapeHtml(k.name) + '</td><td>' + enabled + '</td><td>' + k.request_count + '次</td>' +
          '<td class="actions-cell">' +
            '<button class="btn btn-sm btn-outline" onclick="disableKey(' + k.id + ')">' + (k.enabled ? '禁用' : '启用') + '</button>' +
            '<button class="btn btn-sm btn-danger" onclick="confirmDeleteKey(' + k.id + ', \'' + escapeHtml(k.name) + '\')">删除</button>' +
          '</td></tr>';
      });
      keysHtml += '</tbody></table></div>';
    }

    const activeSessions = (sessions || []).filter(s => !s.revoked_at && new Date(s.expires_at).getTime() > Date.now());
    let sessionsHtml = '<div class="detail-section-heading"><span>登录设备 (' + activeSessions.length + '个在线)</span>' +
      (activeSessions.length > 0 ? '<button class="btn btn-sm btn-danger" onclick="revokeUserSessions(\'' + userId + '\')">踢下线（全部设备）</button>' : '') +
      '</div>';
    if (activeSessions.length > 0) {
      sessionsHtml += '<div class="table-container"><table><thead><tr><th>设备</th><th>最近使用</th><th>登录时间</th><th>过期时间</th></tr></thead><tbody>';
      activeSessions.forEach(s => {
        sessionsHtml += '<tr><td>' + escapeHtml(s.device_name || s.user_agent || '未知设备') + '</td>' +
          '<td>' + formatDate(s.last_used_at || s.created_at) + '</td>' +
          '<td>' + formatDate(s.created_at) + '</td><td>' + formatDate(s.expires_at) + '</td></tr>';
      });
      sessionsHtml += '</tbody></table></div>';
    } else {
      sessionsHtml += '<p class="text-muted">当前没有在线设备</p>';
    }

    document.getElementById("userDetailContent").innerHTML =
      '<div class="user-info-grid">' +
        '<div><strong>邮箱</strong><p>' + escapeHtml(user.email) + '</p></div>' +
        '<div><strong>验证状态</strong><p>' + (user.email_verified ? "已验证" : "未验证") + '</p></div>' +
        '<div><strong>GitHub 绑定</strong><p>' + (user.github_bound ? "已绑定" : "未绑定") + '</p></div>' +
        '<div><strong>密码设置</strong><p>' + (user.password_set ? "已设置" : "未设置") + '</p></div>' +
        '<div><strong>Passkey</strong><p>' + (user.passkey_bound ? "已绑定（" + user.passkey_count + " 个）" : "未绑定") + '</p></div>' +
        '<div><strong>角色</strong><p><select id="editRole" class="input-sm" onchange="updateUserField(\'' + userId + '\', \'role\', this.value)"><option value="user"' + (user.role==="user"?" selected":"") + '>用户</option><option value="admin"' + (user.role==="admin"?" selected":"") + '>管理员</option></select></p></div>' +
        '<div><strong>会员</strong><p><select id="editMember" class="input-sm" onchange="updateUserField(\'' + userId + '\', \'membership_type\', this.value)"><option value="free"' + (user.membership_type==="free"?" selected":"") + '>Free</option><option value="plus"' + (user.membership_type==="plus"?" selected":"") + '>Plus</option><option value="pro"' + (user.membership_type==="pro"?" selected":"") + '>Pro</option></select></p></div>' +
        '<div><strong>到期时间</strong><div class="expire-edit"><input type="datetime-local" id="editExpires" class="input-sm" value="' + escapeHtml(toDatetimeLocalShanghai(user.membership_expires_at)) + '" onchange="updateMembershipExpires(\'' + userId + '\', this.value)"><button type="button" class="btn btn-sm btn-outline" onclick="clearMembershipExpires(\'' + userId + '\')">永久</button></div><p class="text-muted" style="font-size:11px">北京时间，空值表示永久有效</p></div>' +
        '<div><strong>注册时间</strong><p>' + formatDate(user.created_at) + '</p></div>' +
        '<div><strong>今日请求</strong><p>' + (stats ? stats.dailyRequests : "-") + '</p></div>' +
        '<div><strong>月Token</strong><p>' + (stats ? stats.monthlyTokens.toLocaleString() : "-") + '</p></div>' +
        '<div><strong>Passkey 最近使用</strong><p>' + formatDate(user.passkey_last_used_at) + '</p></div>' +
      '</div>' +
      '<button class="btn btn-primary" style="margin-top:12px" onclick="showUserKeyModal(\'' + userId + '\')">+ 为新 Key</button>' +
      (user.status === "banned" ? '<span class="status-badge status-disabled" style="margin:12px 0 0 8px">已封禁</span>' : '<button class="btn btn-sm btn-danger" style="margin:12px 0 0 8px" onclick="banUser(\'' + userId + '\')">封禁账号</button>') +
      (user.role !== "admin" ? '<button class="btn btn-sm btn-danger" style="margin:12px 0 0 8px" data-email="' + escapeHtml(user.email) + '" onclick="deleteUser(\'' + userId + '\', this.dataset.email)">删除账户</button>' : '') +
      keysHtml +
      '<div class="user-sessions">' + sessionsHtml + '</div>' +
      '';
  } catch (e) {
    document.getElementById("userDetailContent").innerHTML = '<p class="error-text">加载失败: ' + escapeHtml(e.message) + '</p>';
  }
}

async function banUser(userId) {
  const reason = prompt("请输入封禁原因");
  if (!reason || reason.trim().length < 3) return;
  try { const result = await apiJson("POST", "/api/admin/bans/create", { user_id: userId, reason: reason.trim() }); showToast(result.data?.emailSent ? "账号已封禁，通知邮件已发送" : "账号已封禁，但通知邮件发送失败: " + (result.data?.emailError || "未知错误"), result.data?.emailSent ? "success" : "error"); await showUserDetail(userId); } catch (e) { showToast("封禁失败: " + e.message, "error"); }
}

async function deleteUser(userId, email) {
  if (!confirm('确定删除账户 "' + email + '" 吗？此操作会永久删除账户、登录会话、API Key 和关联数据，且无法恢复。')) return;
  try {
    const result = await apiJson("POST", "/api/admin/users/delete", { user_id: userId });
    closeModal("modal-user");
    loadUsers();
    showToast(result.data?.emailSent ? "账户已删除，通知邮件已发送" : "账户已删除，但通知邮件发送失败: " + (result.data?.emailError || "未知错误"), result.data?.emailSent ? "success" : "error");
  } catch (e) {
    showToast("删除失败: " + e.message, "error");
  }
}

async function revokeUserSessions(userId) {
  if (!confirm("确定踢出该账号的全部登录设备吗？用户需要重新登录。")) return;
  try {
    const { data } = await apiJson("POST", "/api/admin/users/revoke-sessions", { user_id: userId });
    showToast("已踢下线 " + (data.revoked_count || 0) + " 个设备", "success");
    await showUserDetail(userId);
  } catch (e) {
    showToast("操作失败: " + e.message, "error");
  }
}

async function updateUserField(userId, field, value) {
  try {
    const body = { id: userId };
    body[field] = value;
    await apiJson("POST", "/api/admin/users/update", body);
    showToast("更新成功", "success");
    loadUsers();
  } catch (e) {
    showToast("更新失败: " + e.message, "error");
  }
}

async function updateMembershipExpires(userId, value) {
  const iso = datetimeLocalShanghaiToIso(value);
  if (value && !iso) {
    showToast("到期时间格式无效", "error");
    return;
  }
  await updateUserField(userId, "membership_expires_at", iso);
}

async function clearMembershipExpires(userId) {
  const input = document.getElementById("editExpires");
  if (input) input.value = "";
  await updateUserField(userId, "membership_expires_at", null);
}

function showUserKeyModal(userId) {
  document.getElementById("formUserKey").reset();
  document.getElementById("formUserKey").user_id.value = userId;
  document.getElementById("formUserKey").style.display = "";
  document.getElementById("userKeyResult").style.display = "none";
  document.getElementById("modal-user-key").style.display = "flex";
}

async function handleUserKeyCreate(e) {
  e.preventDefault();
  const form = e.target;
  const body = { name: form.name.value.trim(), user_id: form.user_id.value };
  body.limit_type = form.limit_type.value;
  const limit = form.request_limit.value.trim();
  if (limit) body.request_limit = parseInt(limit);
  if (form.notes.value.trim()) body.notes = form.notes.value.trim();
  try {
    const { data } = await apiJson("POST", "/api/admin/keys/create", body);
    form.style.display = "none";
    const resultDiv = document.getElementById("userKeyResult");
    resultDiv.innerHTML =
      '<div class="key-display">' +
        '<strong>Key 创建成功 (ID: ' + data.id + ')</strong>' +
        '<code id="newUserKey">' + data.rawKey + '</code>' +
        '<button class="btn btn-sm btn-outline" onclick="copyUserKey()">复制</button>' +
        '<span id="copyUserKeyMsg" class="copy-success" style="display:none">已复制</span>' +
        '<p class="key-warning">此 Key 仅显示一次，请立即复制并安全保存。</p>' +
      '</div>' +
      '<div style="margin-top:12px">' +
        '<button class="btn btn-primary" onclick="closeModal(\'modal-user-key\'); showUserDetail(\'' + body.user_id + '\')">完成</button>' +
      '</div>';
    resultDiv.style.display = "block";
  } catch (e) {
    showToast("创建失败: " + e.message, "error");
  }
}

function copyUserKey() {
  const code = document.getElementById("newUserKey");
  navigator.clipboard.writeText(code.textContent).then(() => {
    document.getElementById("copyUserKeyMsg").style.display = "inline";
    setTimeout(() => { document.getElementById("copyUserKeyMsg").style.display = "none"; }, 2000);
  });
}

function showCreateUserModal() {
  document.getElementById("formCreateUser").reset();
  document.getElementById("formCreateUser").style.display = "";
  document.getElementById("createUserResult").style.display = "none";
  document.getElementById("modal-create-user").style.display = "flex";
}

async function handleCreateUserSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    email: form.email.value.trim(),
    role: form.role.value,
    membership_type: form.membership_type.value,
  };
  try {
    const { data: user } = await apiJson("POST", "/api/admin/users/create", body);
    form.style.display = "none";
    const resultDiv = document.getElementById("createUserResult");
    resultDiv.innerHTML =
      '<div class="key-display">' +
        '<strong>用户创建成功</strong>' +
        '<p>邮箱: ' + escapeHtml(user.email) + '</p>' +
        '<p>ID: <code>' + user.id + '</code></p>' +
        '<p style="color:var(--success);margin-top:4px">已默认认证，可直接登录使用。</p>' +
      '</div>' +
      '<div style="margin-top:12px">' +
        '<button class="btn btn-primary" onclick="closeModal(\'modal-create-user\'); loadUsers()">完成</button>' +
        '<button class="btn btn-outline" style="margin-left:8px" onclick="closeModal(\'modal-create-user\'); showUserDetail(\'' + user.id + '\')">查看详情</button>' +
      '</div>';
    resultDiv.style.display = "block";
  } catch (e) {
    showToast("创建失败: " + e.message, "error");
  }
}

async function disableKey(id) {
  try {
    await apiJson("POST", "/api/admin/keys/update", { id: id, enabled: 0 });
    showToast("Key 已禁用", "success");
    // refresh user detail - find current userId
    loadUsers();
    closeModal("modal-user");
  } catch (e) {
    showToast("操作失败: " + e.message, "error");
  }
}

async function confirmDeleteKey(id, name) {
  showConfirm("删除 API Key", '确定要删除 Key "' + name + '" (ID: ' + id + ') 吗？', async () => {
    try {
      await apiJson("POST", "/api/admin/keys/delete", { id: id });
      closeModal("modal-confirm");
      showToast("已删除", "success");
      loadUsers();
      closeModal("modal-user");
    } catch (e) {
      showToast("删除失败: " + e.message, "error");
    }
  });
}

// ── Blacklist Management ──
async function loadBlacklist() {
  const container = document.getElementById("blacklistTableContainer");
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const { data } = await apiJson("GET", "/api/admin/blacklist");
    if (data.length === 0) {
      container.innerHTML = '<p class="empty-state">暂无封禁用户</p>';
      return;
    }
    container.innerHTML = renderBlacklistTable(data);
  } catch (e) {
    container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>';
  }
}

async function loadAppeals() {
  const container = document.getElementById("appealsTableContainer");
  if (!container) return;
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const status = document.getElementById("appealStatusFilter").value;
    const { data } = await apiJson("GET", "/api/admin/appeals" + (status ? "?status=" + encodeURIComponent(status) : ""));
    if (!data.length) { container.innerHTML = '<p class="empty-state">暂无申诉工单</p>'; return; }
    container.innerHTML = '<table><thead><tr><th>用户邮箱</th><th>封禁原因</th><th>申诉内容</th><th>提交时间</th><th>状态</th><th>操作</th></tr></thead><tbody>' + data.map(a => '<tr><td>' + escapeHtml(a.email) + '</td><td>' + escapeHtml(a.reason) + '</td><td style="white-space:normal;min-width:260px">' + escapeHtml(a.content) + '</td><td>' + formatDate(a.created_at) + '</td><td><span class="status-badge ' + (a.status === "pending" ? "status-exceeded" : a.status === "approved" ? "status-enabled" : "status-disabled") + '">' + escapeHtml(a.status) + '</span></td><td>' + (a.status === "pending" ? '<button class="btn btn-sm btn-primary" onclick="reviewAppeal(\'' + a.id + '\',\'approved\')">通过</button> <button class="btn btn-sm btn-danger" onclick="reviewAppeal(\'' + a.id + '\',\'rejected\')">拒绝</button>' : '-') + '</td></tr>').join("") + '</tbody></table>';
  } catch (e) { container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>'; }
}

async function reviewAppeal(id, decision) {
  const reply = prompt("审核回复（可选）", decision === "approved" ? "申诉已通过，账号访问权限已恢复。" : "经审核，账号封禁状态维持不变。");
  if (reply === null) return;
  try { await apiJson("POST", "/api/admin/appeals/review", { id, decision, admin_reply: reply }); showToast("工单已处理", "success"); loadAppeals(); } catch (e) { showToast("处理失败: " + e.message, "error"); }
}

async function loadTickets() {
  const container = document.getElementById("ticketsTableContainer"); if (!container) return;
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const { data } = await apiJson("GET", "/api/admin/tickets");
    if (!data.length) { container.innerHTML = '<p class="empty-state">暂无待处理工单</p>'; return; }
    container.innerHTML = '<table><thead><tr><th>优先级</th><th>用户</th><th>主题 / 内容</th><th>提交时间</th><th>操作</th></tr></thead><tbody>' + data.map(t => '<tr><td><span class="status-badge ' + (t.priority === "top" ? "status-disabled" : t.priority === "urgent" ? "status-exceeded" : "status-enabled") + '">' + ({normal:"普通",urgent:"紧急",top:"顶级"}[t.priority]) + '</span></td><td>' + escapeHtml(t.email) + '<br><small>' + escapeHtml((t.membership_type || "free").toUpperCase()) + '</small></td><td style="white-space:normal;min-width:300px"><strong>' + escapeHtml(t.subject) + '</strong><br>' + escapeHtml(t.content) + '</td><td>' + formatDate(t.created_at) + '</td><td><button class="btn btn-sm btn-primary" data-ticket-id="' + t.id + '" onclick="processTicket(this.dataset.ticketId)">处理</button></td></tr>').join("") + '</tbody></table>';
  } catch (e) { container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>'; }
}

async function processTicket(id) {
  const reply = prompt("请输入处理内容（会显示给用户）"); if (reply === null || !reply.trim()) return;
  try { await apiJson("POST", "/api/admin/tickets/process", { id, admin_reply: reply }); showToast("工单已处理", "success"); loadTickets(); } catch (e) { showToast("处理失败: " + e.message, "error"); }
}

async function loadTicketArchive() {
  const container = document.getElementById("ticketArchiveContainer"); if (!container) return;
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const q = document.getElementById("ticketArchiveSearch").value.trim();
    const { data } = await apiJson("GET", "/api/admin/tickets?archive=1&search=" + encodeURIComponent(q));
    if (!data.length) { container.innerHTML = '<p class="empty-state">没有匹配的归档工单</p>'; return; }
    container.innerHTML = '<table><thead><tr><th>优先级</th><th>用户</th><th>主题</th><th>处理内容</th><th>处理时间</th></tr></thead><tbody>' + data.map(t => '<tr><td>' + ({normal:"普通",urgent:"紧急",top:"顶级"}[t.priority]) + '</td><td>' + escapeHtml(t.email) + '</td><td style="white-space:normal">' + escapeHtml(t.subject) + '<br><small>' + escapeHtml(t.content) + '</small></td><td style="white-space:normal;min-width:260px">' + escapeHtml(t.admin_reply || "-") + '</td><td>' + formatDate(t.processed_at) + '</td></tr>').join("") + '</tbody></table>';
  } catch (e) { container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>'; }
}

async function loadContributions() {
  const container = document.getElementById("contributionsTableContainer"); if (!container) return;
  const status = document.getElementById("contributionStatusFilter").value;
  container.innerHTML = '<p class="empty-state">加载中...</p>';
  try {
    const { data } = await apiJson("GET", "/api/admin/contributions?status=" + encodeURIComponent(status));
    if (!data.length) { container.innerHTML = '<p class="empty-state">暂无贡献记录</p>'; return; }
    const typeName = { fork: "Fork", issue: "Issue", pull_request: "Pull Request", other: "其他" };
    container.innerHTML = '<table><thead><tr><th>用户</th><th>贡献</th><th>说明</th><th>提交时间</th><th>状态</th><th>操作</th></tr></thead><tbody>' + data.map(c => '<tr><td>' + escapeHtml(c.email) + '</td><td><strong>' + escapeHtml(typeName[c.contribution_type] || "其他") + '</strong><br><a href="' + escapeHtml(c.contribution_url) + '" target="_blank" rel="noopener">查看链接</a></td><td style="white-space:normal;min-width:220px">' + escapeHtml(c.description || "-") + '</td><td>' + formatDate(c.created_at) + '</td><td>' + escapeHtml(c.status === "pending" ? "待审核" : c.status === "approved" ? "已通过" : "已打回") + (c.awarded_membership ? '<br><small>' + escapeHtml(c.awarded_membership.toUpperCase()) + '</small>' : '') + '</td><td>' + (c.status === "pending" ? '<button class="btn btn-sm btn-primary" onclick="reviewContribution(\'' + c.id + '\',\'approved\')">通过</button> <button class="btn btn-sm btn-danger" onclick="reviewContribution(\'' + c.id + '\',\'rejected\')">打回</button>' : escapeHtml(c.admin_reply || "-")) + '</td></tr>').join("") + '</tbody></table>';
  } catch (e) { container.innerHTML = '<p class="empty-state error-text">加载失败: ' + escapeHtml(e.message) + '</p>'; }
}

async function reviewContribution(id, decision) {
  let membership = null, duration_days = null;
  if (decision === "approved") {
    membership = prompt("发放会员类型：输入 plus 或 pro", "plus");
    if (!["plus", "pro"].includes(membership)) { showToast("会员类型必须是 plus 或 pro", "error"); return; }
    duration_days = prompt("有效天数", "30");
    if (!duration_days || Number(duration_days) < 1) return;
  }
  const reply = prompt("审核回复（会通过邮件反馈给用户）", decision === "approved" ? "感谢您的代码贡献，审核已通过。" : "感谢您的贡献，当前提交暂未满足审核要求，请补充有效链接后再次提交。");
  if (reply === null) return;
  try { const result = await apiJson("POST", "/api/admin/contributions/review", { id, decision, membership, duration_days: Number(duration_days), admin_reply: reply }); showToast(result.data?.emailSent ? "贡献已审核，结果邮件已发送" : "贡献已审核，但邮件发送失败", result.data?.emailSent ? "success" : "error"); loadContributions(); } catch (e) { showToast("审核失败: " + e.message, "error"); }
}

function renderBlacklistTable(list) {
  const rows = list.map(item => {
    return '<tr>' +
      '<td>' + escapeHtml(item.email) + '</td>' +
      '<td>' + escapeHtml(item.reason || '-') + '</td>' +
      '<td>' + formatDate(item.created_at) + '</td>' +
      '<td class="actions-cell">' +
        '<button class="btn btn-sm btn-danger" onclick="confirmRemoveBlacklist(\'' + escapeHtml(item.email) + '\')">解除封禁</button>' +
      '</td>' +
    '</tr>';
  }).join("");

  return '<table><thead><tr>' +
    '<th>邮箱</th><th>原因</th><th>添加时间</th><th>操作</th>' +
  '</tr></thead><tbody>' + rows + '</tbody></table>';
}

async function addBlacklist() {
  const email = document.getElementById("blacklistEmail").value.trim();
  if (!email) { showToast("请输入邮箱地址", "error"); return; }
  const reason = document.getElementById("blacklistReason").value.trim();

  try {
    const { data: result } = await apiJson("POST", "/api/admin/blacklist/add", { email, reason: reason || undefined });
    document.getElementById("blacklistEmail").value = "";
    document.getElementById("blacklistReason").value = "";
    loadBlacklist();
    showToast(result?.emailSent === false ? "已封禁，但封禁邮件发送失败: " + (result.emailError || "未知错误") : "已封禁: " + email, result?.emailSent === false ? "error" : "success");
  } catch (e) {
    showToast("封禁失败: " + e.message, "error");
  }
}

function confirmRemoveBlacklist(email) {
  showConfirm("解除封禁", '确定要解除对 "' + email + '" 的封禁吗？', async () => {
    try {
      await apiJson("POST", "/api/admin/blacklist/remove", { email: email });
      closeModal("modal-confirm");
      loadBlacklist();
      showToast("已解除封禁", "success");
    } catch (e) {
      showToast("操作失败: " + e.message, "error");
    }
  });
}

// ── Modal Helpers ──
function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

function showConfirm(title, message, onOk) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  const okBtn = document.getElementById("confirmOk");
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener("click", onOk);
  document.getElementById("modal-confirm").style.display = "flex";
}

// ── Toast ──
let toastTimer;
function showToast(msg, type) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = "toast toast-" + type;
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = "none"; }, 3000);
}

// ── Utils ──
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseAdminDate(s) {
  if (!s) return null;
  const value = String(s).trim();
  // D1/CURRENT_TIMESTAMP returns a timezone-less UTC timestamp. Add the
  // UTC designator before parsing so the browser does not treat it as local
  // time (the value stored in the database remains unchanged).
  const utcValue = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  const d = new Date(utcValue);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(s) {
  if (!s) return "-";
  const d = parseAdminDate(s);
  if (!d) return s;
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function toDatetimeLocalShanghai(s) {
  const d = parseAdminDate(s);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day") + "T" + get("hour") + ":" + get("minute");
}

function datetimeLocalShanghaiToIso(value) {
  if (!value) return null;
  const normalized = value.length === 16 ? value + ":00" : value;
  const d = new Date(normalized + "+08:00");
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Close modals on overlay click
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-overlay") && e.target.id !== "loginOverlay" && e.target.id !== "loadingOverlay") {
    e.target.style.display = "none";
  }
});
