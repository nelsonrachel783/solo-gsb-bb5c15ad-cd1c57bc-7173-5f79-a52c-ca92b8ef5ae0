'use strict';

/**
 * JSON 文件持久化：启动时读取，每次变更后同步写入（先写临时文件再 rename）。
 *
 * 家谱版本 version：每次成功变更（成员增删改、关系增删/批量提交、合并、撤销）单调 +1，
 * 并随数据落盘。批量预检返回当时的 version，提交时必须原样带回；
 * 预检与提交之间家谱若被其他操作改动，version 不匹配则整批拒绝。
 *
 * 撤销（仅一级，不能重复撤销）：
 * 每次成功写入前，先把「变更前的完整家谱」（含成员 ID/姓名、全部关系与当时版本）
 * 作为唯一可撤销快照 undo，与新状态、新版本在同一次写盘里原子持久化；
 * 因此重启后仍可撤销。撤销本身也是一次成功写入：恢复快照后 version 继续 +1、
 * 快照清空并落盘，之后不能再次撤销（redo 不存在），直到下一次成功写入产生新快照。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  previewMergeMembers,
  previewEdgeImpact,
  isReachableUp,
  MAX_MEMBERS,
} = require('./familyGraph');

function createStore(filePath) {
  const loaded = loadState(filePath);
  let state = loaded.state;
  let version = loaded.version;
  // 唯一可撤销快照：{ label, time, version, family } | null
  let undo = loaded.undo;

  /** 把当前内存状态序列化为边表格式的纯数据（深拷贝，与落盘格式一致） */
  function serializeFamily() {
    return {
      maxMembers: state.maxMembers,
      members: state.members.map((m) => ({ id: m.id, name: m.name })),
      edges: edgesList(state),
    };
  }

  /**
   * 所有成功写入的统一入口：
   * 先抓取「变更前的完整家谱」作为唯一可撤销快照（覆盖旧快照），
   * 再应用 mutate 对内存状态做修改，随后版本 +1，把新状态、新版本与撤销快照
   * 写入同一个 JSON 文件（临时文件 + rename，原子落盘）。
   * 校验必须在调用本函数之前完成，mutate 不应再返回错误。
   */
  function commit(label, mutate) {
    const snapshot = {
      label,
      time: new Date().toISOString(),
      version,
      family: serializeFamily(),
    };
    mutate();
    version += 1;
    undo = snapshot;
    writeFile(filePath, version, state, undo);
  }

  /**
   * 撤销最近一次成功写入：恢复快照中的完整家谱（成员 ID、姓名与关系原貌），
   * 撤销本身推进版本且清空快照，与新状态原子落盘；重启后同样可用。
   * 携带的 expectedVersion 必须等于当前版本（乐观锁，与批量/合并提交一致）：
   * 其他标签页已修改家谱（版本不符）时返回 409 且数据保持不变。
   */
  function undoLast(expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请刷新页面后再撤销', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱已被其他操作修改，无法撤销旧版本，请刷新后查看最近操作',
        status: 409,
        currentVersion: version,
      };
    }
    if (!undo) {
      return { error: '没有可撤销的最近操作', status: 409, currentVersion: version };
    }
    const restored = familyToState(undo.family);
    const label = undo.label;
    // 一次写入：恢复状态、推进版本、清空快照
    state = restored;
    version += 1;
    undo = null;
    writeFile(filePath, version, state, undo);
    return { error: null, label };
  }

  /** 对外状态：附最近操作（撤销入口所需元数据，不含家谱副本） */
  function list() {
    return {
      version,
      maxMembers: state.maxMembers,
      members: state.members.map((m) => ({ id: m.id, name: m.name })),
      edges: edgesList(state),
      undo: undo
        ? { label: undo.label, time: undo.time, version: undo.version }
        : null,
    };
  }

  function addMember(rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    if (state.members.length >= state.maxMembers) {
      return { error: `成员数量上限为 ${state.maxMembers} 人，无法继续添加` };
    }
    const member = { id: crypto.randomUUID(), name };
    commit(`添加成员「${name}」`, () => {
      state.members.push(member);
      state.parentsOf[member.id] = [];
    });
    return { error: null, member };
  }

  function renameMember(id, rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在' };
    const previousName = member.name;
    commit(`重命名成员「${previousName}」→「${name}」`, () => {
      member.name = name;
    });
    return { error: null, member };
  }

  /** 删除成员：同时移除以其为父母或子女的全部边（级联） */
  function deleteMember(id) {
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在' };
    commit(`删除成员「${member.name}」及其关系`, () => {
      state.members = state.members.filter((m) => m.id !== id);
      delete state.parentsOf[id];
      for (const childId of Object.keys(state.parentsOf)) {
        state.parentsOf[childId] = state.parentsOf[childId].filter((p) => p !== id);
      }
    });
    return { error: null };
  }

  function addEdge(parentId, childId) {
    const check = validateEdge(state, parentId, childId);
    if (check.error) return check;
    commit(`建立关系「${memberName(parentId)} → ${memberName(childId)}」`, () => {
      state.parentsOf[childId].push(parentId);
    });
    return { error: null };
  }

  function deleteEdge(parentId, childId) {
    const parents = state.parentsOf[childId];
    if (!parents || !parents.includes(parentId)) {
      return { error: '关系不存在' };
    }
    commit(`删除关系「${memberName(parentId)} → ${memberName(childId)}」`, () => {
      state.parentsOf[childId] = parents.filter((p) => p !== parentId);
    });
    return { error: null };
  }

  function memberName(id) {
    const m = state.members.find((x) => x.id === id);
    return m ? m.name : '（已删除）';
  }

  /**
   * 整批原子提交父母→子女关系。
   * 先比对家谱版本（乐观锁），再在「当前关系 + 整批草稿」的合并结果上重跑
   * 与预检完全一致的校验；任何一条无效或版本已变化，都不写入任何一条。
   * 全部合法时一次性写入、一次落盘（只产生一个新版本与一份撤销快照）。
   */
  function commitEdges(edges, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先预检后再提交', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱在预检后已被修改，请重新预检后再提交',
        status: 409,
        currentVersion: version,
      };
    }

    const result = validateEdgeBatch(state, edges);
    if (result.error) {
      return { error: result.error, status: 400, result };
    }

    // 全部合法：按批内去重后的边一次写入（校验已保证与现有关系不重复）
    const seen = new Set();
    const toAdd = [];
    for (const item of result.items) {
      const key = `${item.childId} ${item.parentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toAdd.push(item);
    }
    commit(`批量建立 ${toAdd.length} 条关系`, () => {
      for (const item of toAdd) state.parentsOf[item.childId].push(item.parentId);
    });
    return { error: null };
  }

  /**
   * 合并成员预检：把 mergeId 在全部关系中的 ID 替换为 keepId 后去重、检测冲突。
   * 纯只读，不写入任何数据。
   */
  function previewMerge(keepId, mergeId) {
    return previewMergeMembers(state, keepId, mergeId);
  }

  /**
   * 变更影响预览：以当前家谱构造假设图（新增/移除一条父母→子女关系），
   * 对比假设图与当前家谱的辈分矛盾。纯只读，不写入任何数据、不推进版本。
   */
  function previewImpact(action, parentId, childId) {
    return previewEdgeImpact(state, action, parentId, childId);
  }

  /**
   * 合并成员提交（乐观锁 + 服务端重算）。
   * 先比对家谱版本，再按与预检完全相同的规则重新计算：
   * 版本变化（409）或仍有冲突（400）时整单拒绝、不修改任何数据；
   * 合法时保留保留成员的姓名，以合并后的边集整体替换关系，删除被合并成员，
   * 一次落盘且版本只加一（同时产生一份撤销快照）。
   */
  function commitMerge(keepId, mergeId, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先预览后再提交', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱在预览后已被修改，请重新预览后再提交',
        status: 409,
        currentVersion: version,
      };
    }

    const result = previewMergeMembers(state, keepId, mergeId);
    if (result.error) {
      // 结构非法（成员不存在 / 同一人）属于请求错误
      if (result.valid === undefined) return { error: result.error, status: 400 };
      // 合并冲突：整单拒绝、零写入
      return { error: result.error, status: 400, result };
    }

    const keepName = memberName(keepId);
    const mergeName = memberName(mergeId);
    const mergedEdges = result.edges.map((e) => ({ parentId: e.parentId, childId: e.childId }));
    commit(`合并成员「${mergeName}」到「${keepName}」`, () => {
      // 一次应用：重建父母邻接表 + 删除被合并成员（保留成员姓名不动）
      state.members = state.members.filter((m) => m.id !== mergeId);
      for (const childId of Object.keys(state.parentsOf)) delete state.parentsOf[childId];
      for (const m of state.members) state.parentsOf[m.id] = [];
      for (const e of mergedEdges) {
        state.parentsOf[e.childId].push(e.parentId);
      }
    });
    return { error: null };
  }

  return {
    list,
    addMember,
    renameMember,
    deleteMember,
    addEdge,
    deleteEdge,
    commitEdges,
    validateEdgeBatch: (edges) => validateEdgeBatch(state, edges),
    previewMerge,
    previewImpact,
    commitMerge,
    undoLast,
    getState: () => state,
    getVersion: () => version,
  };
}

/** 统一落盘：新状态 + 新版本 + 唯一撤销快照写入同一文件（临时文件 + rename） */
function writeFile(filePath, version, state, undo) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const snapshot = {
    version,
    maxMembers: state.maxMembers,
    members: state.members.map((m) => ({ id: m.id, name: m.name })),
    edges: edgesList(state),
    undo: undo
      ? {
          label: undo.label,
          time: undo.time,
          version: undo.version,
          family: undo.family,
        }
      : null,
  };
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function edgesList(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf)) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

/** 把序列化的家谱（成员 + 边表）重建为运行时状态，复用与启动加载相同的净化规则 */
function familyToState(family) {
  return buildState({
    maxMembers: family.maxMembers,
    members: family.members,
    edges: family.edges,
  });
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { state: createState(MAX_MEMBERS), version: 0, undo: null };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`无法解析数据文件 ${filePath}: ${err.message}`);
  }

  const state = buildState(raw);
  const version = Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0;

  // 撤销快照同样落盘：重启后仍可撤销。快照是写盘时抓取的自身旧状态，
  // 仍走一遍净化规则，防止数据文件被手工改坏。
  let undo = null;
  const u = raw.undo;
  if (u && typeof u === 'object' && u.family && typeof u.family === 'object') {
    const label = typeof u.label === 'string' && u.label.trim() ? u.label.slice(0, 100) : '最近一次变更';
    const time = typeof u.time === 'string' ? u.time : new Date(0).toISOString();
    const snapshotVersion = Number.isInteger(u.version) && u.version >= 0 ? u.version : 0;
    undo = { label, time, version: snapshotVersion, family: serializeFamilyFromRaw(u.family) };
  }

  return { state, version, undo };
}

/** 从落盘 JSON（含兼容的 parentsOf 邻接表格式）构建净化后的运行时状态 */
function buildState(raw) {
  const state = createState(Number.isInteger(raw && raw.maxMembers) ? raw.maxMembers : MAX_MEMBERS);

  if (raw && Array.isArray(raw.members)) {
    for (const m of raw.members) {
      if (m && typeof m.id === 'string' && typeof m.name === 'string') {
        state.members.push({ id: m.id, name: m.name });
      }
    }
  }
  const ids = new Set(state.members.map((m) => m.id));
  if (raw && Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (e && ids.has(e.parentId) && ids.has(e.childId) && e.parentId !== e.childId) {
        (state.parentsOf[e.childId] ||= []).push(e.parentId);
      }
    }
  } else if (raw && raw.parentsOf && typeof raw.parentsOf === 'object') {
    // 兼容早期版本落盘的 parentsOf 邻接表格式
    for (const [childId, parents] of Object.entries(raw.parentsOf)) {
      if (!ids.has(childId) || !Array.isArray(parents)) continue;
      for (const parentId of parents) {
        if (ids.has(parentId) && parentId !== childId) {
          (state.parentsOf[childId] ||= []).push(parentId);
        }
      }
    }
  }
  for (const m of state.members) {
    const ps = state.parentsOf[m.id] || [];
    state.parentsOf[m.id] = [...new Set(ps)].slice(0, 2);
  }
  // 手工编辑数据文件可能引入环路（正常 API 路径已在写入前拦截）。
  // 按成员出现顺序做拓扑净化：丢弃会让父母链重新回到已处理成员的边，
  // 保证加载后的图一定是 DAG，避免查询时死循环。
  for (const child of state.members) {
    state.parentsOf[child.id] = state.parentsOf[child.id].filter(
      (parentId) => !isReachableUp(state, parentId, child.id),
    );
  }
  return state;
}

/** 净化撤销快照中保存的家谱，返回与序列化格式一致的纯数据 */
function serializeFamilyFromRaw(rawFamily) {
  const restored = buildState(rawFamily);
  return {
    maxMembers: restored.maxMembers,
    members: restored.members.map((m) => ({ id: m.id, name: m.name })),
    edges: edgesList(restored),
  };
}

module.exports = { createStore };
