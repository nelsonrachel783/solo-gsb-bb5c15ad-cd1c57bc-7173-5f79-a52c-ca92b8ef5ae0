'use strict';

const path = require('path');
const express = require('express');
const { createStore } = require('./store');
const { findCommonAncestors, findGenerationConflicts, validateEdge } = require('./familyGraph');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'family.json');

const store = createStore(DATA_FILE);
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function sendError(res, status, message) {
  const payload = typeof message === 'string' ? { error: message } : message;
  return res.status(status).json(payload);
}

/** 统一的输入校验：从请求体取非空字符串字段 */
function requireId(body, field) {
  const value = body && typeof body[field] === 'string' ? body[field].trim() : '';
  return value || null;
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 50);
}

/** 获取全部数据：成员 + 关系 */
app.get('/api/state', (req, res) => {
  res.json(store.list());
});

/** 新增成员（最多 30 人） */
app.post('/api/members', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.addMember(name);
  if (result.error) return sendError(res, 400, result.error);
  res.status(201).json(store.list());
});

/** 修改成员姓名（支持修改后重新查询） */
app.patch('/api/members/:id', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.renameMember(req.params.id, name);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/** 删除成员（级联删除相关关系） */
app.delete('/api/members/:id', (req, res) => {
  const result = store.deleteMember(req.params.id);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/**
 * 添加 父母→子女 关系。
 * 服务端拒绝：自指、重复边、超过两位父母、祖先环路。
 */
app.post('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '请选择父母与子女');

  // 双重校验（store.addEdge 内部同样校验，保证单一规则来源）
  const check = validateEdge(store.getState(), parentId, childId);
  if (check.error) return sendError(res, 400, check.error);

  const result = store.addEdge(parentId, childId);
  if (result.error) return sendError(res, 400, result.error);
  res.status(201).json(store.list());
});

/** 删除关系（修改关系 = 删除后重新添加） */
app.delete('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '缺少关系参数');
  const result = store.deleteEdge(parentId, childId);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/** 为预检结果补上成员姓名（成员可能已在预检前被删除） */
function decorateBatchResult(result) {
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  return {
    version: store.getVersion(),
    valid: result.valid,
    error: result.error,
    items: result.items.map((item) => ({
      index: item.index,
      parentId: item.parentId,
      childId: item.childId,
      parentName: item.parentId ? byId.get(item.parentId) || '（已删除）' : '',
      childName: item.childId ? byId.get(item.childId) || '（已删除）' : '',
      errors: item.errors,
    })),
  };
}

/**
 * 批量关系预检：在「当前关系 + 整批草稿」的合并结果上校验
 * 成员存在、自指、批内及已有重复、父母上限与祖先环路。
 * 不写入任何数据，只返回每条草稿的错误、整批可否提交及当前家谱版本。
 * 请求体：{ edges: [{ parentId, childId }, ...] }
 */
app.post('/api/edges/batch/preview', (req, res) => {
  const edges = req.body && req.body.edges;
  const result = store.validateEdgeBatch(edges);
  res.json(decorateBatchResult(result));
});

/**
 * 批量关系提交：必须携带预检返回的家谱版本 version。
 * 服务端重新比对版本并重跑全部校验：版本变化（409）或任何一条非法（400）
 * 都整批拒绝、不写入任何一条；合法时整批一次持久化并返回最新关系列表。
 * 请求体：{ version: number, edges: [...] }
 */
app.post('/api/edges/batch', (req, res) => {
  const edges = req.body && req.body.edges;
  const expectedVersion = req.body && req.body.version;
  const result = store.commitEdges(edges, expectedVersion);
  if (result.error) {
    const payload = { error: result.error };
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    // 非法条目明细一并返回，便于前端展示每条错误
    if (result.result) payload.preview = decorateBatchResult(result.result);
    return sendError(res, result.status || 400, payload);
  }
  res.status(201).json(store.list());
});

/** 为合并预览的结果补上成员姓名与可读冲突信息（不写入数据） */
function decorateMergeResult(result) {
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';

  const conflicts = result.conflicts.map((c) => {
    if (c.type === 'self') {
      return {
        type: c.type,
        memberId: c.parentId,
        memberName: nameOf(c.parentId),
        message:
          `拒绝自指关系：合并后「${nameOf(c.originParentId)}」与「${nameOf(c.originChildId)}」` +
          `变成同一人「${nameOf(c.parentId)}」，将产生其成为自己父母的关系`,
      };
    }
    if (c.type === 'too-many-parents') {
      return {
        type: c.type,
        childId: c.childId,
        childName: nameOf(c.childId),
        count: c.count,
        message:
          `每名子女至多 2 位父母：合并后「${nameOf(c.childId)}」将有 ${c.count} 位父母` +
          `（${c.parentIds.map((id) => `「${nameOf(id)}」`).join('、')}）`,
      };
    }
    // cycle
    return {
      type: c.type,
      parentId: c.parentId,
      parentName: nameOf(c.parentId),
      childId: c.childId,
      childName: nameOf(c.childId),
      message:
        `拒绝祖先环路：合并后「${nameOf(c.parentId)}」将成为「${nameOf(c.childId)}」的后代，` +
        `形成循环祖先关系`,
    };
  });

  return {
    version: store.getVersion(),
    valid: result.valid,
    error: result.error,
    keepId: result.keepId,
    keepName: nameOf(result.keepId),
    mergeId: result.mergeId,
    mergeName: nameOf(result.mergeId),
    originalEdgeCount: result.originalEdgeCount,
    affectedEdgeCount: result.affectedEdgeCount,
    removedDuplicateCount: result.removedDuplicateCount,
    edges: result.edges.map((e) => ({
      parentId: e.parentId,
      childId: e.childId,
      parentName: nameOf(e.parentId),
      childName: nameOf(e.childId),
      replaced: e.replaced,
    })),
    conflicts,
  };
}

/**
 * 合并重复成员预检：选择保留成员与被合并成员。
 * 将被合并成员在全部父母→子女关系中的 ID 替换为保留成员后去重，
 * 返回合并后的关系、去重数量与全部冲突（自指 / 超过两位父母 / 祖先环路）。
 * 预览不修改家谱，仅返回当前家谱版本。
 * 请求体：{ keepId, mergeId }
 */
app.post('/api/members/merge/preview', (req, res) => {
  const keepId = requireId(req.body, 'keepId');
  const mergeId = requireId(req.body, 'mergeId');
  if (!keepId || !mergeId) return sendError(res, 400, '请选择保留成员与被合并成员');

  const result = store.previewMerge(keepId, mergeId);
  if (result.error && result.valid === undefined) {
    return sendError(res, 400, result.error);
  }
  res.json(decorateMergeResult(result));
});

/**
 * 合并重复成员提交：必须携带预览返回的家谱版本 version。
 * 服务端重新比对版本并按同一规则重算：版本变化（409）或仍有冲突（400）
 * 都整单拒绝、不修改任何数据；合法时保留保留成员姓名、去重关系、删除被合并成员，
 * 一次落盘且版本加一。
 * 请求体：{ version: number, keepId, mergeId }
 */
app.post('/api/members/merge', (req, res) => {
  const keepId = requireId(req.body, 'keepId');
  const mergeId = requireId(req.body, 'mergeId');
  if (!keepId || !mergeId) return sendError(res, 400, '请选择保留成员与被合并成员');

  const result = store.commitMerge(keepId, mergeId, req.body && req.body.version);
  if (result.error) {
    const payload = { error: result.error };
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    if (result.result) payload.preview = decorateMergeResult(result.result);
    return sendError(res, result.status || 400, payload);
  }
  res.status(201).json(store.list());
});

/**
 * 撤销最近一次成功写入（成员增删改、单条/批量关系变更、成员合并均覆盖）。
 * 每次成功写入时服务端已把「变更前的完整家谱」作为唯一撤销快照与新状态一起原子落盘，
 * 故重启后仍可撤销。请求必须携带当前所见版本 version：
 * 版本不符（其他标签页/脚本已修改家谱）返回 409 且数据保持不变；
 * 没有可撤销快照（从未变更或已经撤销过）同样返回 409。
 * 撤销成功后家谱版本继续 +1、快照清空（不能重复撤销），返回恢复后的完整 state。
 * 请求体：{ version: number }
 */
app.post('/api/undo', (req, res) => {
  const result = store.undoLast(req.body && req.body.version);
  if (result.error) {
    const payload = { error: result.error };
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    return sendError(res, result.status || 409, payload);
  }
  res.json({ ...store.list(), undone: result.label });
});

/**
 * 查询两人共同祖先：
 * 沿父母链 BFS，找出总代数最少的全部共同祖先，
 * 并返回双方到每个祖先的全部最短亲缘路径（同代数不同路径全部保留）。
 */
app.get('/api/common-ancestors', (req, res) => {
  const { personA, personB } = req.query;
  if (typeof personA !== 'string' || typeof personB !== 'string') {
    return sendError(res, 400, '请选择两位成员');
  }
  const result = findCommonAncestors(store.getState(), personA, personB);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const decoratePath = (p) =>
    p.map((id) => ({ id, name: byId.get(id) || '（已删除）' }));

  res.json({
    samePerson: result.samePerson,
    minTotalGen: result.minTotalGen,
    ancestors: result.ancestors.map((a) => ({
      id: a.id,
      name: byId.get(a.id) || '（已删除）',
      genA: a.genA,
      genB: a.genB,
      totalGen: a.totalGen,
      pathsA: a.pathsA.map(decoratePath),
      pathsB: a.pathsB.map(decoratePath),
    })),
  });
});

/**
 * 辈分矛盾核查（只读，不写入任何数据）：
 * 枚举每一对存在祖先关系的成员，沿父母→子女关系分别求最少与最多代数，
 * 仅当两者不等时列为矛盾（同代不同路径不报警），
 * 每条结果给出代数差及最短、最长各一条完整成员链。
 * 可选查询参数 member=<id>：只返回该成员作为祖先或后代参与的矛盾
 * （total 仍为过滤前总数）。成员或关系变更后重新查询即得到最新结果。
 */
app.get('/api/generation-conflicts', (req, res) => {
  const memberId =
    typeof req.query.member === 'string' && req.query.member.trim()
      ? req.query.member.trim()
      : null;
  const result = findGenerationConflicts(store.getState(), memberId);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const nameOf = (id) => byId.get(id) || '（已删除）';
  const decoratePath = (p) =>
    p.map((id) => ({ id, name: nameOf(id) }));

  res.json({
    version: store.getVersion(),
    total: result.total,
    filtered: result.filtered,
    count: result.conflicts.length,
    conflicts: result.conflicts.map((c) => ({
      ancestorId: c.ancestorId,
      ancestorName: nameOf(c.ancestorId),
      descendantId: c.descendantId,
      descendantName: nameOf(c.descendantId),
      minGen: c.minGen,
      maxGen: c.maxGen,
      diff: c.diff,
      shortestPath: decoratePath(c.shortestPath),
      longestPath: decoratePath(c.longestPath),
    })),
  });
});

/** JSON 解析错误兜底 */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, '请求体不是合法的 JSON');
  }
  return next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`家谱关系核对应用已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
});

module.exports = app;
