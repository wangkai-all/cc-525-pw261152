'use strict';

// ---------- tiny framework ----------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const state = {
  sessionId: localStorage.getItem('sid') || null,
  user: null,
  view: 'reports',
  users: [],
  reports: [],
  revisions: [],
  tasks: [],
  notifications: [],
  detailReportId: null,
  filters: { revisionStatus: '', taskStatus: '' },
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.sessionId) headers['x-session-id'] = state.sessionId;
  if (opts.body) headers['content-type'] = 'application/json';
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = payload?.error?.message || `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return payload;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
function tag(status) {
  const labelMap = {
    DRAFT: '草稿', SUBMITTED: '待复核', APPROVED: '已批准', PUBLISHED: '已发布',
    REJECTED: '已驳回', CANCELLED: '已撤销', PENDING: '待处理',
  };
  return `<span class="tag tag-${status}">${labelMap[status] || status}</span>`;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-host').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
function can(...roles) {
  return state.user && roles.includes(state.user.role);
}
function openModal(html) {
  $('#modal-host').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal-host').innerHTML = '';
}
$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});

// ---------- auth ----------
async function showLogin() {
  const users = await api('/users');
  state.users = users;
  $('#login-users').innerHTML = users.map((u) => `
    <div class="login-card" data-uid="${u.id}">
      <div><strong>${esc(u.name)}</strong><div class="role">${esc(u.roleLabel)} · ${esc(u.email)}</div></div>
      <span class="tag tag-SENT">登录</span>
    </div>`).join('');
  $('#login-overlay').classList.remove('hidden');
}
document.addEventListener('click', async (e) => {
  const card = e.target.closest('.login-card');
  if (!card || $('#login-overlay').classList.contains('hidden')) return;
  const payload = await api('/sessions', { method: 'POST', body: { userId: card.dataset.uid } });
  state.sessionId = payload.sessionId;
  state.user = payload.user;
  localStorage.setItem('sid', payload.sessionId);
  localStorage.setItem('user', JSON.stringify(payload.user));
  $('#login-overlay').classList.add('hidden');
  renderUserChip();
  await refresh();
});
async function logout() {
  try { await api('/sessions', { method: 'DELETE' }); } catch { /* ignore */ }
  state.sessionId = null;
  state.user = null;
  localStorage.removeItem('sid');
  location.reload();
}
$('#logout-btn').addEventListener('click', logout);

function renderUserChip() {
  const chip = $('#user-chip');
  chip.textContent = `${state.user.name}（${state.user.roleLabel}）`;
  chip.classList.remove('hidden');
  $('#logout-btn').classList.remove('hidden');
  $('#nav-audit').hidden = state.user.role !== 'admin';
}

// ---------- navigation ----------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    state.detailReportId = null;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
});

async function refresh() {
  if (!state.user) return;
  const [reports, revisions, tasks, notifications] = await Promise.all([
    api('/reports'),
    api('/revisions'),
    api('/review-tasks'),
    api('/notifications'),
  ]);
  state.reports = reports;
  state.revisions = revisions;
  state.tasks = tasks;
  state.notifications = notifications;
  updateBadges();
  render();
}

function updateBadges() {
  const pendingTasks = state.tasks.filter((t) => t.status === 'PENDING').length;
  const tb = $('#task-badge');
  tb.textContent = pendingTasks;
  tb.classList.toggle('hidden', pendingTasks === 0);
  const nb = $('#ntf-badge');
  nb.textContent = state.notifications.length;
  nb.classList.toggle('hidden', state.notifications.length === 0);
}

function render() {
  if (!state.user) return;
  if (state.detailReportId) return renderReportDetail();
  switch (state.view) {
    case 'reports': return renderReports();
    case 'revisions': return renderRevisions();
    case 'tasks': return renderTasks();
    case 'notifications': return renderNotifications();
    case 'audit': return renderAudit();
    default: return renderReports();
  }
}

// ---------- view: reports ----------
function renderReports() {
  const editable = can('admin', 'analyst');
  app.innerHTML = `
    <div class="section-title">
      <h2 style="margin:0">报表清单与发布状态</h2>
      ${editable ? '<button class="btn btn-primary" id="new-change-btn">+ 发起指标/数据变更</button>' : ''}
    </div>
    <div class="grid grid-3">
      ${state.reports.map((r) => `
        <div class="stat">
          <div class="label">${esc(r.name)}</div>
          <div class="value">V${r.latestVersionNo ?? '—'}</div>
          <div class="muted" style="margin:6px 0 10px">
            修订 ${r.revisionCount} · 进行中 ${r.openRevisionCount} · 待复核 ${r.pendingTaskCount}
          </div>
          <button class="btn btn-sm" data-report="${r.id}">查看时间线与明细</button>
        </div>`).join('')}
    </div>
    <div class="panel" style="margin-top:18px">
      <h3>报表定义</h3>
      <table>
        <thead><tr><th>报表</th><th>指标</th><th>期间</th><th class="num">修订总数</th><th class="num">进行中</th></tr></thead>
        <tbody>
          ${state.reports.map((r) => `
            <tr>
              <td>${esc(r.name)}<div class="muted" style="font-size:12px">${r.id}</div></td>
              <td>${r.metricIds.map((m) => `<span class="metric-chip">${esc(m)}</span>`).join('')}</td>
              <td>${r.periods.map(esc).join(' / ')}</td>
              <td class="num">${r.revisionCount}</td>
              <td class="num">${r.openRevisionCount}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  document.querySelectorAll('[data-report]').forEach((b) =>
    b.addEventListener('click', () => { state.detailReportId = b.dataset.report; render(); }));
  const nc = $('#new-change-btn');
  if (nc) nc.addEventListener('click', openChangeWizard);
}

// ---------- view: report detail (timeline / versions / rollback) ----------
async function renderReportDetail() {
  const detail = await api(`/reports/${state.detailReportId}`);
  const r = detail.report;
  const metricName = Object.fromEntries((await api('/metrics')).map((m) => [m.id, `${m.name}（${m.code}）`]));
  app.innerHTML = `
    <button class="btn btn-sm" id="back-btn">← 返回报表列表</button>
    <div class="panel" style="margin-top:12px">
      <div class="section-title">
        <h2 style="margin:0">${esc(r.name)} <span class="muted" style="font-size:13px">${r.id}</span></h2>
        ${can('admin') ? '<button class="btn btn-danger btn-sm" id="rollback-btn">回滚到历史版本</button>' : ''}
      </div>
      <div class="grid grid-3">
        <div class="stat"><div class="label">已发布版本</div><div class="value">${detail.summary.versionCount}</div></div>
        <div class="stat"><div class="label">修订总数</div><div class="value">${detail.summary.revisionCount}</div></div>
        <div class="stat"><div class="label">待处理复核</div><div class="value">${detail.summary.pendingTaskCount}</div></div>
      </div>
    </div>

    <div class="panel">
      <h3>版本时间线</h3>
      <div class="timeline">
        ${detail.timeline.map((t) => `
          <div class="tl-item ${t.kind}">
            <div><strong>${esc(t.label)}</strong> ${t.kind === 'REVISION' ? tag(t.status) : ''}</div>
            <div class="tl-ts">${fmtTs(t.ts)} · 操作人 ${esc(t.actor)}</div>
            <div class="tl-reason">原因：${esc(t.reason || '—')}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="panel">
      <h3>当前已发布版本明细（V${detail.latestVersion?.versionNo ?? '—'}）
        <span class="muted" style="font-size:12px">所有权限角色看到的该明细完全一致</span></h3>
      <table>
        <thead><tr><th>指标</th><th>期间</th><th class="num">原始值</th><th class="num">报表值</th></tr></thead>
        <tbody>
          ${detail.latestCells.map((c) => `
            <tr>
              <td>${esc(metricName[c.metricId] || c.metricId)}</td>
              <td>${esc(c.period)}</td>
              <td class="num">${fmtNum(c.rawValue)}</td>
              <td class="num">${fmtNum(c.value)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h3>历史版本与影响对象</h3>
      <table>
        <thead><tr><th>版本</th><th>来源</th><th>原因</th><th>关联修订</th><th>发布时间</th><th></th></tr></thead>
        <tbody>
          ${detail.versions.map((v) => `
            <tr>
              <td>V${v.versionNo}</td>
              <td>${v.source === 'ROLLBACK' ? `<span class="tag tag-ROLLBACK">回滚自 ${esc(v.rolledBackFrom)}</span>` : '正常发布'}</td>
              <td>${esc(v.reason)}</td>
              <td>${esc(v.revisionId || '—')}</td>
              <td>${fmtTs(v.createdAt)}</td>
              <td><button class="btn btn-sm" data-version="${v.id}">查看快照</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h3>复核与发布记录（修订）</h3>
      ${detail.revisions.length === 0 ? '<div class="empty">暂无修订记录</div>' : `
      <table>
        <thead><tr><th>修订</th><th>类型</th><th>状态</th><th>原因</th><th class="num">差异单元格</th><th>复核</th><th>通知</th></tr></thead>
        <tbody>
          ${detail.revisions.map((rv) => `
            <tr>
              <td>${rv.id}</td>
              <td>${rv.changeType === 'METRIC_CALIBER' ? '指标口径' : '源数据'}</td>
              <td>${tag(rv.status)}</td>
              <td>${esc(rv.reason)}</td>
              <td class="num">${rv.diffSummary.changedCells}</td>
              <td>${rv.tasks.map((t) => tag(t.status)).join(' ') || '—'}</td>
              <td>${rv.notificationState.total} 条 · 重复抑制 ${rv.notificationState.suppressedDuplicates}</td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;

  $('#back-btn').addEventListener('click', () => { state.detailReportId = null; render(); });
  document.querySelectorAll('[data-version]').forEach((b) =>
    b.addEventListener('click', () => openVersionSnapshot(b.dataset.version, metricName)));
  const rb = $('#rollback-btn');
  if (rb) rb.addEventListener('click', () => openRollback(detail));
}

// detail endpoint embeds all versions; rollback modal reuses them directly.
async function fetchVersionsForReport(reportId) {
  const d = await api(`/reports/${reportId}`);
  return d.versions;
}

async function openVersionSnapshot(versionId, metricName) {
  const v = await api(`/versions/${versionId}`);
  openModal(`
    <div class="close-row"><h2>版本快照 ${esc(v.id)}（V${v.versionNo}）</h2>
      <button class="btn btn-sm" id="m-close">关闭</button></div>
    <p class="muted">${v.source === 'ROLLBACK' ? '回滚发布' : '正常发布'} · 原因：${esc(v.reason)}</p>
    <table>
      <thead><tr><th>指标</th><th>期间</th><th class="num">原始值</th><th class="num">报表值</th></tr></thead>
      <tbody>
        ${v.snapshot.map((c) => `
          <tr><td>${esc(metricName[c.metricId] || c.metricId)}</td><td>${esc(c.period)}</td>
          <td class="num">${fmtNum(c.rawValue)}</td><td class="num">${fmtNum(c.value)}</td></tr>`).join('')}
      </tbody>
    </table>`);
  $('#m-close').addEventListener('click', closeModal);
}

async function openRollback(detail) {
  const versions = await fetchVersionsForReport(detail.report.id);
  const current = detail.latestVersion;
  openModal(`
    <div class="close-row"><h2>回滚报表 ${esc(detail.report.name)}</h2>
      <button class="btn btn-sm" id="m-close">关闭</button></div>
    <p class="muted">回滚不会删除或覆盖任何历史版本，而是把目标快照作为<strong>新的不可变版本</strong>重新发布。</p>
    <label>选择目标历史版本（当前：V${current.versionNo}）</label>
    <select id="rb-version">
      ${versions.filter((v) => v.id !== current.id).map((v) =>
        `<option value="${v.id}">V${v.versionNo} · ${fmtTs(v.ts)} · ${esc(v.reason)}</option>`).join('')}
    </select>
    <label>回滚原因（必填，将记录在版本与审计日志并通知相关人）</label>
    <textarea id="rb-reason" placeholder="例如：发现新口径计算错误，需恢复至上一版数据"></textarea>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="rb-confirm">确认回滚并发布新版本</button>
    </div>`);
  $('#m-close').addEventListener('click', closeModal);
  $('#rb-confirm').addEventListener('click', async () => {
    try {
      const v = await api(`/reports/${detail.report.id}/rollback`, {
        method: 'POST',
        body: { targetVersionId: $('#rb-version').value, reason: $('#rb-reason').value },
      });
      closeModal();
      toast(`已生成新版本 V${v.versionNo}（回滚发布）`, 'success');
      await refresh();
      state.detailReportId = detail.report.id;
      render();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- change wizard: impact list + diff preview ----------
async function openChangeWizard() {
  const [metrics, sourceData] = await Promise.all([api('/metrics'), api('/source-data')]);
  openModal(`
    <div class="close-row"><h2>发起变更（自动影响分析）</h2>
      <button class="btn btn-sm" id="m-close">关闭</button></div>
    <label>变更类型</label>
    <select id="ch-kind">
      <option value="METRIC_CALIBER">指标口径变化</option>
      <option value="SOURCE_DATA">源数据变化</option>
    </select>
    <div id="form-metric">
      <label>指标</label>
      <select id="ch-metric">${metrics.map((m) =>
        `<option value="${m.id}">${esc(m.name)}（${m.code}）当前口径：${esc(m.caliber)}，乘数 ${m.multiplier}</option>`).join('')}</select>
      <label>新口径描述</label><input id="ch-caliber" placeholder="例如：按签收确认收入（不含税）" />
      <label>新乘数（口径换算系数）</label><input id="ch-multiplier" type="number" step="0.0001" value="1" />
    </div>
    <div id="form-data" class="hidden">
      <label>数据源</label>
      <select id="ch-data">${sourceData.map((d) =>
        `<option value="${d.id}">${esc(d.label)}（${d.id}）</option>`).join('')}</select>
      <div id="data-periods"></div>
    </div>
    <label>变更原因（必填，将绑定到每个修订与发布版本）</label>
    <textarea id="ch-reason" placeholder="例如：财务口径调整，收入确认时点由发货改为签收"></textarea>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn" id="ch-preview">生成受影响报表与差异预览</button>
      <button class="btn btn-primary hidden" id="ch-create">确认创建修订草稿</button>
    </div>
    <div id="preview-host" style="margin-top:16px"></div>`);
  $('#m-close').addEventListener('click', closeModal);

  const kindSel = $('#ch-kind');
  function toggleKind() {
    const isMetric = kindSel.value === 'METRIC_CALIBER';
    $('#form-metric').classList.toggle('hidden', !isMetric);
    $('#form-data').classList.toggle('hidden', isMetric);
    if (!isMetric) renderPeriodInputs($('#ch-data').value, sourceData);
  }
  kindSel.addEventListener('change', toggleKind);
  $('#ch-data').addEventListener('change', () => renderPeriodInputs($('#ch-data').value, sourceData));
  toggleKind();

  let lastPreview = null;
  $('#ch-preview').addEventListener('click', async () => {
    try {
      const change = collectChange();
      lastPreview = await api('/changes/preview', { method: 'POST', body: change });
      renderPreview(lastPreview, metrics);
      $('#ch-create').classList.toggle('hidden', lastPreview.impacted.length === 0);
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#ch-create').addEventListener('click', async () => {
    try {
      const revs = await api('/revisions', { method: 'POST', body: collectChange() });
      closeModal();
      toast(`已创建 ${revs.length} 个修订草稿（同组变更 ${revs[0]?.changeGroupId ?? ''}）`, 'success');
      state.view = 'revisions';
      document.querySelectorAll('.nav-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.view === 'revisions'));
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  });

  function collectChange() {
    const reason = $('#ch-reason').value.trim();
    if (kindSel.value === 'METRIC_CALIBER') {
      return {
        kind: 'METRIC_CALIBER',
        metricId: $('#ch-metric').value,
        newCaliber: $('#ch-caliber').value.trim(),
        newMultiplier: Number($('#ch-multiplier').value),
        reason,
      };
    }
    const periodValues = {};
    document.querySelectorAll('.period-input').forEach((inp) => {
      if (inp.value !== '') periodValues[inp.dataset.period] = Number(inp.value);
    });
    return { kind: 'SOURCE_DATA', dataId: $('#ch-data').value, periodValues, reason };
  }
}

function renderPeriodInputs(dataId, sourceData) {
  const d = sourceData.find((x) => x.id === dataId);
  $('#data-periods').innerHTML = Object.entries(d.values).map(([period, val]) => `
    <label>${esc(period)}（当前值 ${fmtNum(val)}）的新值</label>
    <input class="period-input" data-period="${esc(period)}" type="number" step="0.01" placeholder="留空表示不修改" />`).join('');
}

function renderPreview(preview, metrics) {
  const nameOf = (id) => metrics.find((m) => m.id === id)?.name || id;
  const reportName = Object.fromEntries(state.reports.map((r) => [r.id, r.name]));
  if (preview.impacted.length === 0) {
    $('#preview-host').innerHTML = '<div class="empty">该变更不影响任何已发布报表</div>';
    return;
  }
  $('#preview-host').innerHTML = preview.impacted.map((i) => `
    <div class="panel" style="box-shadow:none">
      <h3 style="margin-top:0">${esc(reportName[i.reportId] || i.reportId)}
        <span class="muted" style="font-size:12px">基线 ${i.baseVersionId}</span></h3>
      <table>
        <thead><tr><th>指标</th><th>期间</th><th class="num">原值</th><th class="num">新值</th><th class="num">差异</th><th class="num">变化率</th></tr></thead>
        <tbody>
          ${i.diffPreview.map((d) => `
            <tr>
              <td>${esc(nameOf(d.metricId))}</td><td>${esc(d.period)}</td>
              <td class="num">${fmtNum(d.oldValue)}</td><td class="num">${fmtNum(d.newValue)}</td>
              <td class="num ${d.delta > 0 ? 'diff-up' : 'diff-down'}">${d.delta > 0 ? '+' : ''}${fmtNum(d.delta)}</td>
              <td class="num">${d.pct === null ? '—' : `${d.pct > 0 ? '+' : ''}${fmtNum(d.pct)}%`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');
}

// ---------- view: revisions ----------
function renderRevisions() {
  const statuses = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'PUBLISHED', 'REJECTED', 'CANCELLED'];
  const rows = state.revisions.filter((r) =>
    !state.filters.revisionStatus || r.status === state.filters.revisionStatus);
  const reportName = Object.fromEntries(state.reports.map((r) => [r.id, r.name]));
  app.innerHTML = `
    <div class="section-title">
      <h2 style="margin:0">修订流程</h2>
      <div class="filter-bar">
        <select id="f-status">
          ${statuses.map((s) => `<option value="${s}" ${state.filters.revisionStatus === s ? 'selected' : ''}>${s || '全部状态'}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="panel">
      ${rows.length === 0 ? '<div class="empty">暂无修订</div>' : `
      <table>
        <thead><tr>
          <th>修订</th><th>报表</th><th>类型</th><th>状态</th><th>原因</th>
          <th>影响报表</th><th class="num">差异</th><th>通知状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${r.id}<div class="muted" style="font-size:11px">${r.changeGroupId}</div></td>
              <td>${esc(reportName[r.reportId] || r.reportId)}</td>
              <td>${r.changeType === 'METRIC_CALIBER' ? '指标口径' : '源数据'}</td>
              <td>${tag(r.status)}</td>
              <td style="max-width:200px">${esc(r.reason)}</td>
              <td>${r.impactedReportIds.map((id) => `<span class="metric-chip">${esc(id)}</span>`).join('')}</td>
              <td class="num">${r.diffSummary.changedCells} 格 / Δ ${fmtNum(r.diffSummary.totalDelta)}</td>
              <td>${r.notificationState.total} 条<span class="muted">（抑制重复 ${r.notificationState.suppressedDuplicates}）</span></td>
              <td><div class="row-actions">
                <button class="btn btn-sm" data-detail="${r.id}">详情</button>
                ${r.status === 'DRAFT' && can('admin', 'analyst') ? `<button class="btn btn-sm btn-primary" data-submit="${r.id}">提交复核</button>` : ''}
                ${r.status === 'APPROVED' && can('admin') ? `<button class="btn btn-sm btn-success" data-publish="${r.id}">发布</button>` : ''}
                ${['DRAFT', 'SUBMITTED', 'APPROVED'].includes(r.status) && (can('admin') || r.createdBy === state.user.id)
                  ? `<button class="btn btn-sm btn-danger" data-cancel="${r.id}">撤销</button>` : ''}
                ${r.status === 'SUBMITTED' && can('admin', 'analyst') ? `<button class="btn btn-sm" data-remind="${r.id}">催办</button>` : ''}
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
  $('#f-status').addEventListener('change', (e) => {
    state.filters.revisionStatus = e.target.value; render();
  });
  document.querySelectorAll('[data-detail]').forEach((b) =>
    b.addEventListener('click', () => openRevisionDetail(b.dataset.detail)));
  document.querySelectorAll('[data-submit]').forEach((b) =>
    b.addEventListener('click', () => act(`/revisions/${b.dataset.submit}/submit`, 'POST', '已提交复核，复核任务与通知已生成')));
  document.querySelectorAll('[data-publish]').forEach((b) =>
    b.addEventListener('click', () => act(`/revisions/${b.dataset.publish}/publish`, 'POST', '已发布为新的不可变版本')));
  document.querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const comment = prompt('撤销说明（可选）') || '';
      await act(`/revisions/${b.dataset.cancel}/cancel`, 'POST', '修订已撤销', { comment });
    }));
  document.querySelectorAll('[data-remind]').forEach((b) =>
    b.addEventListener('click', () => act(`/revisions/${b.dataset.remind}/remind`, 'POST', '催办通知已发送（重复通知自动抑制）')));
}

async function act(path, method, okMsg, body) {
  try {
    const r = await api(path, { method, body });
    toast(`${okMsg}${r.suppressedDuplicates ? `，抑制重复 ${r.suppressedDuplicates} 条` : ''}`, 'success');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function openRevisionDetail(id) {
  const r = await api(`/revisions/${id}`);
  const metrics = await api('/metrics');
  const nameOf = (mid) => metrics.find((m) => m.id === mid)?.name || mid;
  openModal(`
    <div class="close-row"><h2>修订 ${esc(r.id)}</h2>
      <button class="btn btn-sm" id="m-close">关闭</button></div>
    <dl class="kv">
      <dt>状态</dt><dd>${tag(r.status)}</dd>
      <dt>变更类型</dt><dd>${r.changeType === 'METRIC_CALIBER' ? '指标口径变化' : '源数据变化'}</dd>
      <dt>绑定原因</dt><dd>${esc(r.reason)}</dd>
      <dt>创建人 / 时间</dt><dd>${esc(r.createdBy)} · ${fmtTs(r.createdAt)}</dd>
      <dt>基线版本</dt><dd>${esc(r.baseVersionId)}（不可变）</dd>
      <dt>同组影响报表</dt><dd>${r.impactedReportIds.map((x) => `<span class="metric-chip">${esc(x)}</span>`).join('')}</dd>
      <dt>审批</dt><dd>${r.approval
        ? `${esc(r.approval.approvedBy)} 于 ${fmtTs(r.approval.approvedAt)} 批准${r.approval.comment ? `（${esc(r.approval.comment)}）` : ''}`
        : '—'}</dd>
    </dl>
    <h3>差异预览（与发布后明细一致）</h3>
    <table>
      <thead><tr><th>指标</th><th>期间</th><th class="num">原值</th><th class="num">新值</th><th class="num">差异</th><th class="num">变化率</th></tr></thead>
      <tbody>
        ${r.diffPreview.map((d) => `
          <tr><td>${esc(nameOf(d.metricId))}</td><td>${esc(d.period)}</td>
          <td class="num">${fmtNum(d.oldValue)}</td><td class="num">${fmtNum(d.newValue)}</td>
          <td class="num ${d.delta > 0 ? 'diff-up' : 'diff-down'}">${d.delta > 0 ? '+' : ''}${fmtNum(d.delta)}</td>
          <td class="num">${d.pct === null ? '—' : `${d.pct > 0 ? '+' : ''}${fmtNum(d.pct)}%`}</td></tr>`).join('')}
      </tbody>
    </table>
    <h3>复核任务</h3>
    ${r.tasks.length === 0 ? '<div class="empty">尚未提交，无复核任务</div>' : `
    <table><thead><tr><th>任务</th><th>角色</th><th>状态</th><th>处理人</th><th>意见</th></tr></thead>
      <tbody>${r.tasks.map((t) => `
        <tr><td>${t.id}</td><td>${esc(t.assigneeRole)}</td><td>${tag(t.status)}</td>
        <td>${esc(t.decidedBy || '—')}</td><td>${esc(t.comment || '—')}</td></tr>`).join('')}</tbody></table>`}
    <h3>通知状态（按事件聚合）</h3>
    <table><thead><tr><th>事件</th><th class="num">通知条数</th><th class="num">被抑制的重复</th><th>最近发送</th></tr></thead>
      <tbody>${r.notificationState.byEvent.map((n) => `
        <tr><td>${esc(n.eventType)}</td><td class="num">${n.count}</td>
        <td class="num">${n.suppressed}</td><td>${fmtTs(n.lastSentAt)}</td></tr>`).join('')}</tbody></table>`);
  $('#m-close').addEventListener('click', closeModal);
}

// ---------- view: review tasks ----------
function renderTasks() {
  const rows = state.tasks.filter((t) => !state.filters.taskStatus || t.status === state.filters.taskStatus);
  const reportName = Object.fromEntries(state.reports.map((r) => [r.id, r.name]));
  const canReview = can('admin', 'reviewer');
  app.innerHTML = `
    <div class="section-title">
      <h2 style="margin:0">复核任务队列</h2>
      <select id="f-task">
        ${['', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) =>
          `<option value="${s}" ${state.filters.taskStatus === s ? 'selected' : ''}>${s || '全部状态'}</option>`).join('')}
      </select>
    </div>
    <div class="panel">
      ${rows.length === 0 ? '<div class="empty">暂无复核任务</div>' : `
      <table>
        <thead><tr><th>任务</th><th>报表</th><th>修订</th><th>指派角色</th><th>状态</th><th>处理人</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.map((t) => `
            <tr>
              <td>${t.id}</td><td>${esc(reportName[t.reportId] || t.reportId)}</td>
              <td>${t.revisionId}</td><td>${esc(t.assigneeRole)}</td><td>${tag(t.status)}</td>
              <td>${esc(t.decidedBy || '—')}</td>
              <td><div class="row-actions">
                <button class="btn btn-sm" data-rev="${t.revisionId}">查看修订与差异</button>
                ${t.status === 'PENDING' && canReview ? `
                  <button class="btn btn-sm btn-success" data-approve="${t.id}">批准</button>
                  <button class="btn btn-sm btn-danger" data-reject="${t.id}">驳回</button>` : ''}
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
  $('#f-task').addEventListener('change', (e) => { state.filters.taskStatus = e.target.value; render(); });
  document.querySelectorAll('[data-rev]').forEach((b) =>
    b.addEventListener('click', () => openRevisionDetail(b.dataset.rev)));
  document.querySelectorAll('[data-approve]').forEach((b) =>
    b.addEventListener('click', () => decide(b.dataset.approve, 'APPROVED')));
  document.querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', () => decide(b.dataset.reject, 'REJECTED')));
}

async function decide(taskId, decision) {
  const comment = prompt(decision === 'REJECTED' ? '驳回意见（建议填写）' : '审批意见（可选）') || undefined;
  try {
    await api(`/review-tasks/${taskId}/decision`, { method: 'POST', body: { decision, comment } });
    toast(decision === 'APPROVED' ? '已批准，修订进入待发布状态' : '已驳回', 'success');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- view: notifications ----------
function renderNotifications() {
  app.innerHTML = `
    <div class="section-title"><h2 style="margin:0">通知中心</h2>
      <span class="muted">相同事件 + 对象 + 接收人 + 渠道的重复通知自动合并计数</span></div>
    <div class="panel">
      ${state.notifications.length === 0 ? '<div class="empty">暂无通知</div>' :
      state.notifications.map((n) => `
        <div class="notif-item">
          <div>
            <strong>${esc(n.title)}</strong>
            <div class="meta">${esc(n.eventType)} · ${esc(n.channel)} · 接收人 ${esc(n.recipient)} · ${fmtTs(n.sentAt)}</div>
          </div>
          ${n.dupCount > 0 ? `<span class="dup-pill">重复抑制 ×${n.dupCount}</span>` : '<span class="tag tag-SENT">已送达</span>'}
        </div>`).join('')}
    </div>`;
}

// ---------- view: audit ----------
async function renderAudit() {
  const rows = await api('/audit');
  app.innerHTML = `
    <div class="section-title"><h2 style="margin:0">审计日志（管理员）</h2></div>
    <div class="panel">
      ${rows.length === 0 ? '<div class="empty">暂无审计事件</div>' : `
      <table>
        <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          ${rows.map((a) => `
            <tr><td>${fmtTs(a.ts)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td>
            <td>${esc(a.entityType)} ${esc(a.entityId)}</td>
            <td><code style="font-size:11px">${esc(JSON.stringify(a.detail))}</code></td></tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
}

// ---------- boot ----------
(async function boot() {
  if (state.sessionId) {
    try {
      const me = await api('/me');
      state.user = me;
      state.users = await api('/users');
      renderUserChip();
      await refresh();
      return;
    } catch {
      localStorage.removeItem('sid');
      localStorage.removeItem('user');
      state.sessionId = null;
      state.user = null;
    }
  }
  showLogin();
})();
