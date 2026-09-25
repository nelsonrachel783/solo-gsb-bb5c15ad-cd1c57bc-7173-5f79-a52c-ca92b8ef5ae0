'use strict';

/* 家谱关系核对 —— 原生前端逻辑 */

const state = {
  version: 0,
  maxMembers: 30,
  members: [],
  edges: [], // { parentId, childId }
  undo: null, // 最近一次可撤销操作：{ label, time, version } | null
};

// 批量录入草稿：{ key, parentId, childId }，key 仅用于前端定位，不参与判定
let draftSeq = 0;
const drafts = [];
// 最近一次预检结果：{ version, valid, error, byKey: Map<key, { errors, parentName, childName }> }
// 仅当 version 与当前家谱版本一致且草稿未被改动时有效
let preview = null;
let previewStale = false; // 预检后家谱/草稿是否已变化

// 记住下拉框的选择，数据刷新后尽量保持
const selection = {
  edgeParent: '',
  edgeChild: '',
  queryA: '',
  queryB: '',
  genFilter: '',
  mergeKeep: '',
  mergeRemove: '',
};

let queryStale = false; // 关系被修改后，共同祖先查询结果标记为过期
let genStale = false; // 成员或关系被修改后，辈分矛盾核查结果标记为过期

// 最近一次合并预览：{ version, keepId, mergeId, valid, ...服务端返回 }
// 仅当 version 与当前家谱版本一致且两人选择未改变时有效
let mergePreview = null;
let mergeStale = false;
let mergeStaleReason = '';

const $ = (id) => document.getElementById(id);

/** 安全创建 DOM 元素，避免 innerHTML 注入 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const nameOf = (id) => {
  const m = state.members.find((x) => x.id === id);
  return m ? m.name : '（已删除）';
};

/* ---------------- 网络请求 ---------------- */

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function refresh() {
  const data = await api('/api/state');
  const versionChanged = data.version !== state.version;
  state.version = data.version;
  state.maxMembers = data.maxMembers;
  state.members = data.members;
  state.edges = data.edges;
  state.undo = data.undo || null;
  reconcileSelection();
  if (versionChanged && preview && !previewStale) invalidatePreview('家谱已变化，请重新预检');
  if (versionChanged && mergePreview && !mergeStale) invalidateMergePreview('家谱已刷新，请重新预览合并');
  render();
}

function applyStateAndRender(data) {
  const versionChanged = data.version !== state.version;
  state.version = data.version;
  state.maxMembers = data.maxMembers;
  state.members = data.members;
  state.edges = data.edges;
  state.undo = data.undo || null;
  reconcileSelection();
  if (versionChanged && preview && !previewStale) invalidatePreview('家谱已变化，请重新预检');
  if (versionChanged && mergePreview && !mergeStale) invalidateMergePreview('家谱已变化，请重新预览合并');
  render();
}

function reconcileSelection() {
  const ids = new Set(state.members.map((m) => m.id));
  for (const key of Object.keys(selection)) {
    if (!ids.has(selection[key])) selection[key] = '';
  }
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(message, isError = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = isError ? 'toast error' : 'toast';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
}

/* ---------------- 渲染 ---------------- */

function render() {
  renderMembers();
  renderEdges();
  renderSelects();
  renderDrafts();
  renderMerge();
  renderStaleBanner();
  renderUndo();
}

/* ---------------- 最近操作与撤销 ---------------- */

function formatUndoTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return d.toISOString();
  }
}

function renderUndo() {
  const info = $('undo-info');
  const btn = $('undo-button');
  if (!state.undo) {
    info.textContent = '暂无可撤销的操作：成功添加/修改/删除成员、建立/删除关系、批量提交或合并成员后，此处会显示最近一次操作。';
    btn.disabled = true;
    btn.textContent = '撤销这次操作';
    return;
  }
  const time = formatUndoTime(state.undo.time);
  info.replaceChildren(
    el('strong', { text: state.undo.label }),
    document.createTextNode(time ? `（${time}，家谱版本 ${state.undo.version}）` : `（家谱版本 ${state.undo.version}）`),
  );
  btn.disabled = false;
  btn.textContent = `撤销：${state.undo.label}`;
}

/** 撤销最近一次成功写入：携带所见版本；其他标签页改动过家谱则被 409 拒绝且数据不变 */
async function undoLastChange() {
  if (!state.undo) { toast('没有可撤销的操作', true); return; }
  const label = state.undo.label;
  if (!confirm(`确定撤销「${label}」？\n家谱将恢复为该操作之前的成员 ID、姓名与全部关系，且撤销后不能再次撤销。`)) return;
  const btn = $('undo-button');
  btn.disabled = true;
  try {
    const data = await api('/api/undo', {
      method: 'POST',
      body: JSON.stringify({ version: state.version }),
    });
    applyStateAndRender(data);
    markStale(); // 恢复后让已有共同祖先查询结果失效
    toast(`已撤销：${data.undone || label}`);
  } catch (err) {
    // 409：其他标签页已修改家谱（版本不符），或快照已不存在——拉取最新状态与最近操作
    if (err.status === 409) refresh().catch(() => {});
    toast(err.message, true);
  } finally {
    btn.disabled = !state.undo;
  }
}

$('undo-button').addEventListener('click', undoLastChange);

function renderMembers() {
  $('member-count').textContent = `${state.members.length}/${state.maxMembers}`;
  const list = $('member-list');
  list.replaceChildren();

  if (state.members.length === 0) {
    list.appendChild(el('li', { class: 'empty-hint', text: '尚未添加成员，请先在上方录入。' }));
    return;
  }

  // 父母计数，便于展示
  const parentCount = new Map();
  const childCount = new Map();
  for (const e of state.edges) {
    parentCount.set(e.parentId, (parentCount.get(e.parentId) || 0) + 1);
    childCount.set(e.childId, (childCount.get(e.childId) || 0) + 1);
  }

  for (const m of state.members) {
    const li = el('li');
    li.appendChild(el('span', { class: 'name', text: m.name }));
    li.appendChild(
      el('span', {
        class: 'sub',
        text: `子女 ${parentCount.get(m.id) || 0} · 父母 ${childCount.get(m.id) || 0}`,
      })
    );
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '重命名',
      onClick: () => startRename(li, m),
    }));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '删除',
      onClick: () => removeMember(m),
    }));
    list.appendChild(li);
  }
}

function startRename(li, member) {
  li.classList.add('renaming');
  li.replaceChildren();
  const input = el('input', {
    type: 'text',
    value: member.name,
    maxlength: '50',
  });
  const saveBtn = el('button', { type: 'button', text: '保存' });
  const cancelBtn = el('button', { type: 'button', text: '取消', class: 'danger-link' });

  const doSave = async () => {
    const name = input.value.trim();
    if (!name) { toast('姓名不能为空', true); return; }
    try {
      const data = await api(`/api/members/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      applyStateAndRender(data);
      markStale();
      toast('已重命名');
    } catch (err) {
      toast(err.message, true);
    }
  };

  saveBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  });
  cancelBtn.addEventListener('click', () => render());
  li.append(input, saveBtn, cancelBtn);
  input.focus();
  input.select();
}

function renderEdges() {
  const list = $('edge-list');
  list.replaceChildren();

  if (state.edges.length === 0) {
    list.appendChild(el('li', {
      class: 'empty-hint',
      text: '尚未建立关系。选择父母与子女后点击「建立关系」。',
    }));
    return;
  }

  // 排序：先按子女姓名，再按父母姓名，便于查看
  const sorted = [...state.edges].sort((a, b) => {
    const ca = nameOf(a.childId), cb = nameOf(b.childId);
    if (ca !== cb) return ca.localeCompare(cb, 'zh');
    return nameOf(a.parentId).localeCompare(nameOf(b.parentId), 'zh');
  });

  for (const e of sorted) {
    const li = el('li');
    li.appendChild(el('span', { class: 'edge-text' }, [
      el('span', { class: 'p-name', text: nameOf(e.parentId) }),
      document.createTextNode(' → '),
      el('span', { class: 'c-name', text: nameOf(e.childId) }),
    ]));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '删除',
      onClick: () => removeEdge(e),
    }));
    list.appendChild(li);
  }
}

function renderSelects() {
  fillSelect($('edge-parent'), selection.edgeParent, '选择父母');
  fillSelect($('edge-child'), selection.edgeChild, '选择子女');
  fillSelect($('query-a'), selection.queryA, '选择成员甲');
  fillSelect($('query-b'), selection.queryB, '选择成员乙');
  fillSelect($('gen-filter'), selection.genFilter, '全部成员（不筛选）');
  fillSelect($('merge-keep'), selection.mergeKeep, '选择保留成员');
  fillSelect($('merge-remove'), selection.mergeRemove, '选择被合并成员');
}

function fillSelect(select, selectedId, placeholder) {
  const current = selectedId || select.value;
  select.replaceChildren();
  if (state.members.length === 0) {
    select.appendChild(el('option', { value: '', text: `（请先添加成员）` }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.appendChild(el('option', { value: '', text: `（${placeholder}）` }));
  for (const m of state.members) {
    const attrs = { value: m.id, text: m.name };
    if (m.id === current) attrs.selected = 'selected';
    select.appendChild(el('option', attrs));
  }
  if (!current) select.value = '';
}

function renderStaleBanner() {
  renderOneStaleBanner(
    $('query-result'),
    queryStale,
    '⚠️ 关系在上次查询后发生过修改，以下结果可能已过期，请重新查询。',
  );
  renderOneStaleBanner(
    $('gen-result'),
    genStale,
    '⚠️ 成员或关系在上次核查后发生过修改，以下结果可能已过期，请重新核查。',
  );
}

function renderOneStaleBanner(box, stale, message) {
  if (!box || !box.dataset.hasResult) return;
  const existing = box.querySelector('.stale-banner');
  if (stale) {
    if (!existing) box.prepend(el('p', { class: 'stale-banner', text: message }));
  } else if (existing) {
    existing.remove();
  }
}

function markStale() {
  queryStale = true;
  genStale = true;
  renderStaleBanner();
}

/* ---------------- 事件处理 ---------------- */

$('member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('member-name');
  const name = input.value.trim();
  if (!name) { toast('姓名不能为空', true); return; }
  try {
    const data = await api('/api/members', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    applyStateAndRender(data);
    input.value = '';
    input.focus();
    toast('成员已添加');
  } catch (err) {
    toast(err.message, true);
  }
});

async function removeMember(member) {
  if (!confirm(`确定删除成员「${member.name}」？\n与之相关的全部父母/子女关系将一并删除。`)) return;
  try {
    const data = await api(`/api/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
    applyStateAndRender(data);
    markStale();
    toast('成员已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

function syncSelectionFromForm() {
  selection.edgeParent = $('edge-parent').value;
  selection.edgeChild = $('edge-child').value;
  selection.queryA = $('query-a').value;
  selection.queryB = $('query-b').value;
  selection.genFilter = $('gen-filter').value;
  selection.mergeKeep = $('merge-keep').value;
  selection.mergeRemove = $('merge-remove').value;
}

$('edge-parent').addEventListener('change', syncSelectionFromForm);
$('edge-child').addEventListener('change', syncSelectionFromForm);
$('query-a').addEventListener('change', syncSelectionFromForm);
$('query-b').addEventListener('change', syncSelectionFromForm);
$('gen-filter').addEventListener('change', syncSelectionFromForm);

// 合并的两个成员一旦改变，旧预览立即失效
$('merge-keep').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateMergePreview('保留成员已改变，请重新预览合并');
});
$('merge-remove').addEventListener('change', () => {
  syncSelectionFromForm();
  invalidateMergePreview('被合并成员已改变，请重新预览合并');
});
$('merge-form').addEventListener('submit', (e) => {
  e.preventDefault();
  previewMerge();
});

$('edge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const parentId = $('edge-parent').value;
  const childId = $('edge-child').value;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  if (parentId === childId) { toast('拒绝自指关系：不能成为自己的父母', true); return; }
  try {
    const data = await api('/api/edges', {
      method: 'POST',
      body: JSON.stringify({ parentId, childId }),
    });
    applyStateAndRender(data);
    markStale();
    toast('关系已建立');
  } catch (err) {
    toast(err.message, true);
  }
});

async function removeEdge(edge) {
  if (!confirm(`确定删除关系「${nameOf(edge.parentId)} → ${nameOf(edge.childId)}」？`)) return;
  try {
    const data = await api('/api/edges', {
      method: 'DELETE',
      body: JSON.stringify({ parentId: edge.parentId, childId: edge.childId }),
    });
    applyStateAndRender(data);
    markStale();
    toast('关系已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 批量关系草稿 ---------------- */

let staleReason = ''; // 预检失效原因（草稿变化或家谱版本变化）

function invalidatePreview(reason) {
  preview = null;
  previewStale = true;
  staleReason = reason;
  renderDrafts();
}

function draftKeys() {
  return drafts.map((d) => d.key);
}

function addDraftFromForm() {
  syncSelectionFromForm();
  const parentId = $('edge-parent').value;
  const childId = $('edge-child').value;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  drafts.push({ key: `d${++draftSeq}`, parentId, childId });
  invalidatePreview('草稿已修改，请重新预检');
  renderDrafts();
}

function removeDraft(key) {
  const idx = drafts.findIndex((d) => d.key === key);
  if (idx >= 0) drafts.splice(idx, 1);
  invalidatePreview('草稿已修改，请重新预检');
  renderDrafts();
}

function clearDrafts() {
  if (drafts.length === 0) return;
  if (!confirm('确定清空全部草稿？（不会影响已有关系）')) return;
  drafts.length = 0;
  invalidatePreview('');
  previewStale = false;
  staleReason = '';
  renderDrafts();
}

/** 预检整批：每条草稿的错误 + 整批可否提交 + 当前家谱版本（不写入数据） */
async function previewBatch() {
  if (drafts.length === 0) { toast('草稿为空，无法预检', true); return; }
  const keys = draftKeys();
  const status = $('batch-status');
  status.hidden = false;
  status.className = 'batch-status info';
  status.textContent = '预检中…';
  try {
    const data = await api('/api/edges/batch/preview', {
      method: 'POST',
      body: JSON.stringify({ edges: drafts.map((d) => ({ parentId: d.parentId, childId: d.childId })) }),
    });
    // 请求往返期间草稿可能已被改动：结果只对当时的草稿快照有效
    if (JSON.stringify(keys) !== JSON.stringify(draftKeys())) {
      invalidatePreview('草稿在预检期间已变化，请重新预检');
      return;
    }
    const byKey = new Map();
    for (const item of data.items) {
      byKey.set(keys[item.index], {
        errors: item.errors,
        parentName: item.parentName,
        childName: item.childName,
      });
    }
    preview = { version: data.version, valid: data.valid, byKey, keys };
    previewStale = false;
    staleReason = '';
    renderDrafts();
  } catch (err) {
    toast(err.message, true);
    renderDrafts();
  }
}

/** 提交整批：必须携带预检返回的版本；任何一条非法或期间家谱变化都会被整批拒绝 */
async function submitBatch() {
  if (!preview || previewStale || !preview.valid) {
    toast('请先预检且整批全部合法后再提交', true);
    return;
  }
  const btn = $('batch-submit');
  btn.disabled = true;
  try {
    const data = await api('/api/edges/batch', {
      method: 'POST',
      body: JSON.stringify({
        version: preview.version,
        edges: drafts.map((d) => ({ parentId: d.parentId, childId: d.childId })),
      }),
    });
    drafts.length = 0;
    preview = null;
    previewStale = false;
    staleReason = '';
    applyStateAndRender(data);
    markStale();
    toast('整批关系已一次写入');
  } catch (err) {
    // 409 版本冲突：服务端家谱已更新，拉取最新状态并要求重新预检
    if (/重新预检/.test(err.message)) {
      invalidatePreview('家谱在预检后已被修改，请重新预检后再提交');
      refresh().catch(() => {});
    }
    toast(err.message, true);
    renderDrafts();
  } finally {
    btn.disabled = false;
  }
}

function renderDrafts() {
  const list = $('draft-list');
  const empty = $('draft-empty');
  const count = $('draft-count');
  const status = $('batch-status');
  const submitBtn = $('batch-submit');
  const previewBtn = $('batch-preview');

  count.textContent = String(drafts.length);
  list.replaceChildren();

  if (drafts.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    status.hidden = true;
    submitBtn.disabled = true;
    previewBtn.disabled = true;
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  previewBtn.disabled = false;

  const currentKeys = JSON.stringify(draftKeys());
  const previewLive = preview && !previewStale && JSON.stringify(preview.keys) === currentKeys;

  for (const [i, d] of drafts.entries()) {
    const info = previewLive ? preview.byKey.get(d.key) : null;
    const rowInvalid = !!(info && info.errors.length > 0);
    const li = el('li', { class: rowInvalid ? 'draft-row invalid' : info ? 'draft-row valid' : 'draft-row' });

    const head = el('div', { class: 'draft-main' });
    head.appendChild(el('span', { class: 'draft-index', text: `#${i + 1}` }));
    head.appendChild(el('span', { class: 'edge-text' }, [
      el('span', { class: 'p-name', text: info ? info.parentName : nameOf(d.parentId) }),
      document.createTextNode(' → '),
      el('span', { class: 'c-name', text: info ? info.childName : nameOf(d.childId) }),
    ]));
    if (info) {
      head.appendChild(el('span', {
        class: rowInvalid ? 'draft-tag bad' : 'draft-tag ok',
        text: rowInvalid ? `✗ ${info.errors.length} 项错误` : '✓ 合法',
      }));
    }
    head.appendChild(el('button', {
      class: 'danger-link',
      text: '移除',
      onClick: () => removeDraft(d.key),
    }));
    li.appendChild(head);

    if (info && rowInvalid) {
      const ul = el('ul', { class: 'draft-errors' });
      for (const msg of info.errors) ul.appendChild(el('li', { text: msg }));
      li.appendChild(ul);
    }
    list.appendChild(li);
  }

  // 整批状态提示
  status.hidden = false;
  if (!previewLive) {
    status.className = 'batch-status warn';
    status.textContent = staleReason || '草稿尚未预检，或预检结果已失效：请点击「预检整批」。';
    submitBtn.disabled = true;
    return;
  }
  if (preview.valid) {
    status.className = 'batch-status ok';
    status.textContent =
      `预检通过：${drafts.length} 条草稿全部合法，整批可以提交。提交将基于家谱版本 ${preview.version} 原子写入；若期间家谱被修改会被拒绝。`;
    submitBtn.disabled = false;
  } else {
    const bad = drafts.filter((d) => (preview.byKey.get(d.key) || { errors: [] }).errors.length > 0).length;
    status.className = 'batch-status error';
    status.textContent =
      `预检未通过：${bad}/${drafts.length} 条草稿存在错误（见各行下方），整批不可提交；修正草稿后请重新预检。`;
    submitBtn.disabled = true;
  }
}

$('draft-add').addEventListener('click', addDraftFromForm);
$('batch-preview').addEventListener('click', previewBatch);
$('batch-submit').addEventListener('click', submitBatch);
$('batch-clear').addEventListener('click', clearDrafts);

/* ---------------- 合并重复成员 ---------------- */

function invalidateMergePreview(reason) {
  mergePreview = null;
  mergeStale = true;
  mergeStaleReason = reason;
  renderMerge();
}

/** 预览是否对应当前两位选择且版本未变 */
function mergePreviewLive() {
  if (!mergePreview || mergeStale) return false;
  if (mergePreview.version !== state.version) return false;
  if (mergePreview.keepId !== selection.mergeKeep) return false;
  if (mergePreview.mergeId !== selection.mergeRemove) return false;
  return true;
}

/** 预览合并：替换 ID、去重、列出冲突；预览不修改家谱 */
async function previewMerge() {
  syncSelectionFromForm();
  const keepId = selection.mergeKeep;
  const mergeId = selection.mergeRemove;
  if (!keepId || !mergeId) { toast('请选择保留成员与被合并成员', true); return; }
  if (keepId === mergeId) { toast('保留成员与被合并成员不能是同一人', true); return; }

  const status = $('merge-status');
  status.hidden = false;
  status.className = 'batch-status info';
  status.textContent = '预览中…（不会修改家谱）';
  try {
    const data = await api('/api/members/merge/preview', {
      method: 'POST',
      body: JSON.stringify({ keepId, mergeId }),
    });
    // 请求往返期间选择可能已被改动：结果只对当时的两人快照有效
    if (keepId !== selection.mergeKeep || mergeId !== selection.mergeRemove) {
      invalidateMergePreview('选择在预览期间已变化，请重新预览合并');
      return;
    }
    mergePreview = data;
    mergeStale = false;
    mergeStaleReason = '';
    renderMerge();
  } catch (err) {
    toast(err.message, true);
    renderMerge();
  }
}

/** 提交合并：携带预览版本；版本变化或仍有冲突时服务端整单拒绝、不改数据 */
async function submitMerge() {
  if (!mergePreviewLive() || !mergePreview.valid) {
    toast('请先预览且不存在冲突后再提交合并', true);
    return;
  }
  const btn = $('merge-submit');
  btn.disabled = true;
  const { keepId, mergeId, keepName, mergeName } = mergePreview;
  try {
    const data = await api('/api/members/merge', {
      method: 'POST',
      body: JSON.stringify({ version: mergePreview.version, keepId, mergeId }),
    });
    mergePreview = null;
    mergeStale = false;
    mergeStaleReason = '';
    selection.mergeKeep = '';
    selection.mergeRemove = '';
    applyStateAndRender(data);
    markStale();
    toast(`已将「${mergeName}」并入「${keepName}」，保留成员「${keepName}」`);
  } catch (err) {
    if (/重新预览/.test(err.message)) {
      invalidateMergePreview('家谱在预览后已被修改，请重新预览后再提交');
      refresh().catch(() => {});
    }
    toast(err.message, true);
    renderMerge();
  } finally {
    btn.disabled = false;
  }
}

$('merge-preview').addEventListener('click', previewMerge);
$('merge-submit').addEventListener('click', submitMerge);

function renderMerge() {
  const empty = $('merge-empty');
  const status = $('merge-status');
  const result = $('merge-result');
  const previewBtn = $('merge-preview');
  const submitBtn = $('merge-submit');
  const form = $('merge-form');

  if (state.members.length < 2) {
    empty.hidden = false;
    form.hidden = true;
    status.hidden = true;
    result.hidden = true;
    previewBtn.disabled = true;
    submitBtn.disabled = true;
    return;
  }
  empty.hidden = true;
  form.hidden = false;
  previewBtn.disabled = false;

  // 同一人时禁止预览/提交
  const sameChosen = !!selection.mergeKeep && selection.mergeKeep === selection.mergeRemove;
  const live = mergePreviewLive();

  if (!live) {
    result.hidden = true;
    status.hidden = false;
    if (sameChosen) {
      status.className = 'batch-status error';
      status.textContent = '保留成员与被合并成员不能是同一人。';
    } else {
      status.className = 'batch-status warn';
      status.textContent = mergeStaleReason || '尚未预览，或预览结果已失效：请点击「预览合并」。';
    }
    submitBtn.disabled = true;
    return;
  }

  status.hidden = false;
  result.hidden = false;
  renderMergeResult(result, mergePreview);

  if (mergePreview.valid) {
    status.className = 'batch-status ok';
    status.textContent =
      `预览通过：合并后保留「${mergePreview.keepName}」、删除「${mergePreview.mergeName}」，` +
      `共 ${mergePreview.edges.length} 条关系（${mergePreview.affectedEdgeCount} 条涉及被合并成员，` +
      `去重移除 ${mergePreview.removedDuplicateCount} 条重复关系）。` +
      `提交基于家谱版本 ${mergePreview.version}，只落盘一次并使版本加一；期间家谱被修改会被拒绝。`;
    submitBtn.disabled = false;
  } else {
    status.className = 'batch-status error';
    status.textContent =
      `预览发现 ${mergePreview.conflicts.length} 项冲突（见下），已禁止提交；` +
      `请调整保留/被合并成员或先修正家谱关系后重新预览。`;
    submitBtn.disabled = true;
  }
}

function renderMergeResult(box, data) {
  box.replaceChildren();

  // 冲突清单
  if (data.conflicts.length > 0) {
    const conf = el('div', { class: 'merge-conflicts' });
    conf.appendChild(el('h4', { text: `冲突（${data.conflicts.length} 项）` }));
    const ul = el('ul');
    for (const c of data.conflicts) {
      ul.appendChild(el('li', { text: c.message }));
    }
    conf.appendChild(ul);
    box.appendChild(conf);
  }

  // 合并后的关系
  const edgeBox = el('div');
  edgeBox.appendChild(el('h4', {
    text: `合并后的关系（${data.edges.length} 条；去重移除 ${data.removedDuplicateCount} 条）`,
  }));
  if (data.edges.length === 0) {
    edgeBox.appendChild(el('p', { class: 'empty-hint', text: '合并后没有任何父母→子女关系。' }));
  } else {
    const list = el('ul', { class: 'edge-list merge-edge-list' });
    for (const e of data.edges) {
      const li = el('li');
      li.appendChild(el('span', { class: 'edge-text' }, [
        el('span', { class: 'p-name', text: e.parentName }),
        document.createTextNode(' → '),
        el('span', { class: 'c-name', text: e.childName }),
      ]));
      if (e.replaced) {
        li.appendChild(el('span', { class: 'merge-tag', text: 'ID 已替换' }));
      }
      list.appendChild(li);
    }
    edgeBox.appendChild(list);
  }
  box.appendChild(edgeBox);
}

/* ---------------- 共同祖先查询结果渲染 ---------------- */

function renderPathLine(path) {
  // path: [{id,name}, ...] 从查询人向上到祖先
  const gen = path.length - 1;
  const frag = document.createDocumentFragment();
  path.forEach((node, idx) => {
    if (idx > 0) frag.appendChild(el('span', { class: 'path-arrow', text: '↑' }));
    frag.appendChild(document.createTextNode(node.name));
  });
  return el('div', { class: 'path-line' }, [
    el('span', { class: 'gen-tag', text: `${gen} 代` }),
    frag,
  ]);
}

function renderAncestorBlock(ancestor, labelA, labelB) {
  const block = el('div', { class: 'ancestor-block' });
  block.appendChild(el('h3', { text: `共同祖先：${ancestor.name}` }));
  block.appendChild(el('p', { class: 'ancestor-meta' }, [
    document.createTextNode(
      `${labelA}到该祖先 ${ancestor.genA} 代，${labelB}到该祖先 ${ancestor.genB} 代，`
    ),
    el('strong', { text: `合计 ${ancestor.totalGen} 代` }),
    document.createTextNode(
      `；${labelA}侧最短路径 ${ancestor.pathsA.length} 条，${labelB}侧 ${ancestor.pathsB.length} 条（同代数不同路径均保留）。`
    ),
  ]));

  const paths = el('div', { class: 'paths' });

  const colA = el('div', { class: 'path-col' }, [
    el('h4', { text: `${labelA} 向上到「${ancestor.name}」` }),
  ]);
  ancestor.pathsA.forEach((p) => colA.appendChild(renderPathLine(p)));

  const colB = el('div', { class: 'path-col' }, [
    el('h4', { text: `${labelB} 向上到「${ancestor.name}」` }),
  ]);
  ancestor.pathsB.forEach((p) => colB.appendChild(renderPathLine(p)));

  paths.append(colA, colB);
  block.appendChild(paths);
  return block;
}

function renderQueryResult(data, nameA, nameB) {
  const box = $('query-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  if (data.samePerson) {
    const a = data.ancestors[0];
    box.appendChild(el('div', { class: 'summary' }, [
      el('div', {}, [el('strong', { text: `两位成员是同一人：「${a.name}」` })]),
      el('div', { text: '其本人即为最近共同祖先，沿父母链向上的总代数为 0 代。' }),
    ]));
    box.appendChild(renderAncestorBlock(a, nameA, nameB));
    return;
  }

  if (data.ancestors.length === 0) {
    box.appendChild(el('div', { class: 'summary no-match' }, [
      el('strong', { text: `「${nameA}」与「${nameB}」没有共同祖先。` }),
      el('div', {
        text: '沿双方父母链向上均找不到同一位成员。若确有亲缘关系，请检查是否漏录了中间世代的父母→子女关系。',
      }),
    ]));
    return;
  }

  box.appendChild(el('div', { class: 'summary' }, [
    el('div', {}, [
      document.createTextNode('「'),
      el('strong', { text: nameA }),
      document.createTextNode('」与「'),
      el('strong', { text: nameB }),
      document.createTextNode('」的 '),
      el('strong', { text: `最少总代数为 ${data.minTotalGen} 代` }),
      document.createTextNode('。'),
    ]),
    el('div', {
      text: `达到该最小值的最近共同祖先共 ${data.ancestors.length} 位（全部列出），双方到各祖先的全部最短亲缘路径如下：`,
    }),
  ]));

  for (const ancestor of data.ancestors) {
    box.appendChild(renderAncestorBlock(ancestor, `「${nameA}」`, `「${nameB}」`));
  }
}

$('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const personA = $('query-a').value;
  const personB = $('query-b').value;
  if (!personA || !personB) { toast('请选择两位成员', true); return; }

  const nameA = nameOf(personA);
  const nameB = nameOf(personB);

  try {
    const params = new URLSearchParams({ personA, personB });
    const data = await api(`/api/common-ancestors?${params.toString()}`);
    queryStale = false;
    renderQueryResult(data, nameA, nameB);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 辈分矛盾核查结果渲染 ---------------- */

/** 渲染一条 祖先 → 子女 → … → 后代 的完整成员链（方向自上而下） */
function renderGenChainLine(path, genTag) {
  const frag = document.createDocumentFragment();
  path.forEach((node, idx) => {
    if (idx > 0) frag.appendChild(el('span', { class: 'path-arrow', text: '↓' }));
    frag.appendChild(document.createTextNode(node.name));
  });
  return el('div', { class: 'path-line' }, [
    el('span', { class: 'gen-tag', text: genTag }),
    frag,
  ]);
}

function renderConflictBlock(c) {
  const block = el('div', { class: 'conflict-block ancestor-block' });
  block.appendChild(el('h3', {}, [
    document.createTextNode('「'),
    el('strong', { text: c.ancestorName }),
    document.createTextNode('」 → … → 「'),
    el('strong', { text: c.descendantName }),
    document.createTextNode('」'),
  ]));
  block.appendChild(el('p', { class: 'ancestor-meta' }, [
    document.createTextNode('最短路径 '),
    el('strong', { text: `${c.minGen} 代` }),
    document.createTextNode('，最长路径 '),
    el('strong', { text: `${c.maxGen} 代` }),
    document.createTextNode('，'),
    el('strong', { class: 'conflict-diff', text: `代数差 ${c.diff} 代` }),
    document.createTextNode('：同一对祖先与后代沿不同关系路径的辈分隔辈数不一致。'),
  ]));

  const paths = el('div', { class: 'paths' });
  const colShort = el('div', { class: 'path-col' }, [
    el('h4', { text: `最短成员链（${c.minGen} 代）` }),
    renderGenChainLine(c.shortestPath, `${c.shortestPath.length - 1} 代`),
  ]);
  const colLong = el('div', { class: 'path-col' }, [
    el('h4', { text: `最长成员链（${c.maxGen} 代）` }),
    renderGenChainLine(c.longestPath, `${c.longestPath.length - 1} 代`),
  ]);
  paths.append(colShort, colLong);
  block.appendChild(paths);
  return block;
}

function renderGenResult(data) {
  const box = $('gen-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  if (data.conflicts.length === 0) {
    const summary = el('div', { class: 'summary no-match' });
    if (data.filtered) {
      summary.appendChild(el('strong', { text: '当前筛选的成员没有参与任何辈分矛盾。' }));
      summary.appendChild(el('div', {
        text: `全家家谱共核查出 ${data.total} 对辈分矛盾（清空成员筛选后可查看全部）；同代不同路径不会报警。`,
      }));
    } else if (data.total === 0) {
      summary.appendChild(el('strong', { text: '未发现辈分矛盾。' }));
      summary.appendChild(el('div', {
        text: '全部存在祖先关系的成员对，沿不同父母→子女路径得到的代数都一致；同代不同路径（如经父系与母系同代到达同一祖先）不属于矛盾。',
      }));
    } else {
      summary.appendChild(el('strong', { text: '当前筛选条件下没有矛盾。' }));
    }
    box.appendChild(summary);
    return;
  }

  const summary = el('div', { class: 'summary' });
  if (data.filtered) {
    summary.appendChild(el('div', {}, [
      document.createTextNode('全家家谱共 '),
      el('strong', { text: `${data.total} 对` }),
      document.createTextNode(' 辈分矛盾，其中与所选成员相关的 '),
      el('strong', { text: `${data.count} 对` }),
      document.createTextNode(' 如下（按代数差从大到小排列）：'),
    ]));
  } else {
    summary.appendChild(el('div', {}, [
      document.createTextNode('共核查出 '),
      el('strong', { text: `${data.total} 对` }),
      document.createTextNode(' 辈分矛盾（同一对祖先与后代的最少、最多代数不一致），按代数差从大到小排列：'),
    ]));
  }
  summary.appendChild(el('div', {
    class: 'empty-hint',
    text: '每条给出两端成员、代数差以及最短、最长各一条完整成员链（祖先 → 子女 → … → 后代）。',
  }));
  box.appendChild(summary);

  for (const c of data.conflicts) box.appendChild(renderConflictBlock(c));
}

$('gen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const memberId = selection.genFilter;
  const params = new URLSearchParams();
  if (memberId) params.set('member', memberId);
  try {
    const url = '/api/generation-conflicts' + (params.toString() ? `?${params.toString()}` : '');
    const data = await api(url);
    genStale = false;
    renderGenResult(data);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 启动 ---------------- */

refresh().catch((err) => toast(`初始化失败：${err.message}`, true));
