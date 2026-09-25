'use strict';

/**
 * 家谱图核心逻辑（纯函数，不依赖 Node API，便于测试）。
 *
 * 关系模型：每条边 parent -> child（父母 → 子女）。
 * parentsOf[child] = [parentA, parentB]，每名子女至多两位父母。
 * 每个连通结构必须是有向无环图（DAG），即沿父母链向上永远不会回到自身。
 */

const MAX_PARENTS_PER_CHILD = 2;
const MAX_MEMBERS = 30;
const MAX_BATCH_EDGES = 100;

/** 创建一个空的家谱状态对象 */
function createState(maxMembers = MAX_MEMBERS) {
  return {
    maxMembers,
    members: [], // [{ id, name }]
    parentsOf: {}, // memberId -> [parentId, ...]
  };
}

function getMember(state, id) {
  return state.members.find((m) => m.id === id) || null;
}

function hasMember(state, id) {
  return state.members.some((m) => m.id === id);
}

/**
 * 判断从 from 出发沿“父母链”向上是否能到达 to（含 from === to）。
 * parentsOf 是一个 DAG（外部保证），此处用栈式 DFS。
 */
function isReachableUp(state, from, to) {
  if (from === to) return true;
  const stack = [...(state.parentsOf[from] || [])];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of state.parentsOf[cur] || []) stack.push(p);
  }
  return false;
}

/**
 * 校验并尝试添加一条 parent -> child 边。
 * 返回 { error: string } 或 { error: null }。
 * 不修改 state（由调用方在校验通过后写入）。
 */
function validateEdge(state, parentId, childId) {
  if (!hasMember(state, parentId)) return { error: '父母成员不存在' };
  if (!hasMember(state, childId)) return { error: '子女成员不存在' };

  if (parentId === childId) {
    return { error: '拒绝自指关系：不能成为自己的父母' };
  }

  const parents = state.parentsOf[childId] || [];
  if (parents.includes(parentId)) {
    return { error: '拒绝重复边：该父母→子女关系已存在' };
  }
  if (parents.length >= MAX_PARENTS_PER_CHILD) {
    return {
      error: `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母，该成员已有 ${parents.length} 位父母`,
    };
  }

  // 祖先环路检测：若 parent 沿父母链向上能到达 child，
  // 再加 child 成为 parent 的祖先，则 child 会成为自己的祖先。
  if (isReachableUp(state, parentId, childId)) {
    return { error: '拒绝祖先环路：该父母已是此子女的后代，添加后将形成循环祖先关系' };
  }

  return { error: null };
}

/**
 * 批量校验待添加的父母→子女草稿（纯函数，不修改 state）。
 *
 * 校验基准是「当前已有关系 + 整批草稿」合并后的完整结果，而不是逐条顺序处理：
 * 因此先入草稿在判定中不会“生效”，草稿顺序如何排列都不影响任何一条的结论。
 *
 * 每条草稿可能同时命中多个错误，errors 为全部命中项：
 *   - 父母/子女成员不存在（或格式非法）
 *   - 自指
 *   - 批内重复（同一对父母→子女在草稿中出现多次）
 *   - 与已有关系重复
 *   - 合并后该子女父母超过两位（计数只含已有关系 + 批内去重后的边）
 *   - 祖先环路（在合并后的图上检测，任一条边使合并图成环都会被标记）
 *
 * 返回 { valid, error: string|null, items: [{ index, parentId, childId, errors }] }。
 * valid 仅在非空且每条草稿都无错误时为 true；任何一条无效，整批都不可提交。
 */
function validateEdgeBatch(state, rawEdges) {
  if (!Array.isArray(rawEdges)) {
    return { valid: false, error: '草稿必须是数组', items: [] };
  }
  if (rawEdges.length === 0) {
    return { valid: false, error: '草稿为空：请至少添加一条父母→子女关系', items: [] };
  }
  if (rawEdges.length > MAX_BATCH_EDGES) {
    return {
      valid: false,
      error: `单批最多 ${MAX_BATCH_EDGES} 条草稿，当前 ${rawEdges.length} 条`,
      items: [],
    };
  }

  // 第一阶段：结构校验（成员存在、自指），同时按「无序对 child|parent」找批内重复。
  // 结构不合法的条目不参与后续计数与环路检测。
  const items = rawEdges.map((raw, index) => {
    const parentId =
      raw && typeof raw.parentId === 'string' ? raw.parentId.trim() : '';
    const childId =
      raw && typeof raw.childId === 'string' ? raw.childId.trim() : '';
    const errors = [];
    let structurallyValid = true;

    if (!parentId || !hasMember(state, parentId)) {
      errors.push('父母成员不存在');
      structurallyValid = false;
    }
    if (!childId || !hasMember(state, childId)) {
      errors.push('子女成员不存在');
      structurallyValid = false;
    }
    if (parentId && childId && parentId === childId) {
      errors.push('拒绝自指关系：不能成为自己的父母');
      structurallyValid = false;
    }

    return { index, parentId: parentId || null, childId: childId || null, errors, structurallyValid };
  });

  // 批内重复：同一条父母→子女在草稿中出现多次（所有副本一起标记）
  const keyOf = (parentId, childId) => `${childId}|${parentId}`;
  const groups = new Map();
  for (const item of items) {
    if (!item.structurallyValid) continue;
    const key = keyOf(item.parentId, item.childId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      for (const item of group) item.errors.push('批内重复：该父母→子女关系在草稿中出现多次');
    }
  }

  // 第二阶段：合并结果上的去重边集（已有关系 + 批内去重后的结构合法边）。
  // 与已有重复、超父母上限的边同样纳入合并图做环路检测：
  // 环路是整批合并结果的性质，与“哪些边最终能写入”无关，且判定不依赖顺序。
  const existingByChild = new Map();
  for (const e of edgesFromState(state)) {
    if (!existingByChild.has(e.childId)) existingByChild.set(e.childId, new Set());
    existingByChild.get(e.childId).add(e.parentId);
  }

  const merged = new Map(); // childId -> Set<parentId>（已有关系为底）
  for (const [childId, parents] of existingByChild) {
    merged.set(childId, new Set(parents));
  }

  const duplicateFreeCandidates = new Map(); // childId -> Set<parentId>，仅批内去重后
  const newCandidates = new Map(); // childId -> Set<parentId>，批内去重且不与已有重复
  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    if (!duplicateFreeCandidates.has(item.childId)) duplicateFreeCandidates.set(item.childId, new Set());
    duplicateFreeCandidates.get(item.childId).add(item.parentId);
    const isExistingDup = !!(existingByChild.get(item.childId) && existingByChild.get(item.childId).has(item.parentId));
    if (!isExistingDup) {
      if (!newCandidates.has(item.childId)) newCandidates.set(item.childId, new Set());
      newCandidates.get(item.childId).add(item.parentId);
    }
    if (!merged.has(item.childId)) merged.set(item.childId, new Set());
    merged.get(item.childId).add(item.parentId);
  }

  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    const existing = existingByChild.get(item.childId);
    if (existing && existing.has(item.parentId)) {
      item.errors.push('拒绝重复边：该父母→子女关系已存在');
    }
  }

  // 每名子女至多两位父母：合并后总父母数 = 现有父母 + 草稿中新引入的父母（去重）。
  // 与已有重复的边不会引入新父母，因此不参与计数；超限则该子女下全部新边都标记。
  for (const [childId, incoming] of newCandidates) {
    const existingCount = existingByChild.has(childId) ? existingByChild.get(childId).size : 0;
    const total = existingCount + incoming.size;
    if (total > MAX_PARENTS_PER_CHILD) {
      for (const parentId of incoming) {
        for (const item of items) {
          if (
            item.childId === childId &&
            item.parentId === parentId &&
            item.structurallyValid &&
            groups.get(keyOf(parentId, childId)).length === 1
          ) {
            item.errors.push(
              `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母：合并草稿后该子女将有 ${total} 位父母（现有 ${existingCount} 位）`,
            );
          }
        }
      }
    }
  }

  // 祖先环路：在合并后的图上，对每条候选边检查 parent 是否沿父母链向上可达 child。
  // 可达性基于最终合并图（而非逐条累加），故结论与草稿顺序无关。
  const mergedState = {
    ...state,
    parentsOf: Object.fromEntries(
      [...merged.entries()].map(([childId, parents]) => [childId, [...parents]]),
    ),
  };
  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    if (isReachableUp(mergedState, item.parentId, item.childId)) {
      item.errors.push('拒绝祖先环路：合并该批草稿后将形成循环祖先关系');
    }
  }

  const valid = items.every((item) => item.errors.length === 0);
  return {
    valid,
    error: valid
      ? null
      : `草稿中有 ${items.filter((i) => i.errors.length > 0).length} 条关系不合法，整批不可提交`,
    items: items.map(({ index, parentId, childId, errors }) => ({ index, parentId, childId, errors })),
  };
}

/**
 * 合并重复成员预检（纯函数，不修改 state）。
 *
 * 把被合并成员 mergeId 在「全部父母 → 子女关系」中的 ID 替换为保留成员 keepId，
 * 替换后完全相同的关系去重，再在合并结果上统一检查三类冲突：
 *   - 自指：替换后某条关系的父母与子女变成同一人
 *     （例如已有 A→B，把 B 并入 A 后会得到 A→A）；
 *   - 超过两位父母：去重后任一子女仍有超过 MAX_PARENTS_PER_CHILD 位父母；
 *   - 祖先环路：合并图中某条边的父母沿父母链向上可以到达其子女。
 * 冲突可同时命中多项，全部列入 conflicts；只要存在冲突 valid 即为 false。
 *
 * 返回：
 *   结构非法（成员不存在 / 两人相同）：{ error: string }
 *   正常：{
 *     valid, error, keepId, mergeId,
 *     originalEdgeCount,      // 合并前关系总数
 *     affectedEdgeCount,      // 其中端点涉及被合并成员的关系数
 *     removedDuplicateCount,  // ID 替换后去重掉的重复关系数
 *     edges: [{ parentId, childId, replaced }],  // 合并去重后的关系；
 *                                                // replaced 表示是否源自涉及被合并成员的关系
 *     conflicts: [{ type, ... }],
 *   }
 */
function previewMergeMembers(state, keepId, mergeId) {
  if (!hasMember(state, keepId)) return { error: '保留成员不存在' };
  if (!hasMember(state, mergeId)) return { error: '被合并成员不存在' };
  if (keepId === mergeId) return { error: '保留成员与被合并成员不能是同一人' };

  const original = edgesFromState(state);
  const substitute = (id) => (id === mergeId ? keepId : id);

  const conflicts = [];
  // 自指关系不参与去重与后续图校验，单独作为冲突报告
  const mergedByKey = new Map(); // child|parent -> { parentId, childId, replaced }
  let affectedEdgeCount = 0;
  let removedDuplicateCount = 0;

  for (const e of original) {
    const touched = e.parentId === mergeId || e.childId === mergeId;
    if (touched) affectedEdgeCount += 1;
    const nextParent = substitute(e.parentId);
    const nextChild = substitute(e.childId);

    if (nextParent === nextChild) {
      conflicts.push({
        type: 'self',
        parentId: nextParent,
        childId: nextChild,
        originParentId: e.parentId,
        originChildId: e.childId,
      });
      continue;
    }

    const key = `${nextChild}|${nextParent}`;
    const existing = mergedByKey.get(key);
    if (existing) {
      removedDuplicateCount += 1;
      if (touched) existing.replaced = true;
    } else {
      mergedByKey.set(key, { parentId: nextParent, childId: nextChild, replaced: touched });
    }
  }

  const edges = [...mergedByKey.values()].sort((a, b) => {
    if (a.childId !== b.childId) return a.childId.localeCompare(b.childId);
    return a.parentId.localeCompare(b.parentId);
  });

  // 合并后的父母邻接表
  const parentsByChild = new Map();
  for (const e of edges) {
    if (!parentsByChild.has(e.childId)) parentsByChild.set(e.childId, []);
    parentsByChild.get(e.childId).push(e.parentId);
  }

  // 冲突一：子女超过两位父母
  for (const childId of [...parentsByChild.keys()].sort()) {
    const parentIds = parentsByChild.get(childId);
    if (parentIds.length > MAX_PARENTS_PER_CHILD) {
      conflicts.push({
        type: 'too-many-parents',
        childId,
        parentIds: [...parentIds],
        count: parentIds.length,
      });
    }
  }

  // 冲突二：祖先环路（自指边已剔除，from===to 的平凡情况不会出现）
  const mergedState = {
    ...state,
    parentsOf: Object.fromEntries(
      [...parentsByChild.entries()].map(([childId, parentIds]) => [childId, [...parentIds]]),
    ),
  };
  for (const e of edges) {
    if (isReachableUp(mergedState, e.parentId, e.childId)) {
      conflicts.push({ type: 'cycle', parentId: e.parentId, childId: e.childId });
    }
  }

  const valid = conflicts.length === 0;
  return {
    valid,
    error: valid
      ? null
      : `合并预览存在 ${conflicts.length} 项冲突，已禁止提交`,
    keepId,
    mergeId,
    originalEdgeCount: original.length,
    affectedEdgeCount,
    removedDuplicateCount,
    edges,
    conflicts,
  };
}

/** 从状态导出边表（与 store 内的 edgesList 保持一致的最小实现） */
function edgesFromState(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf || {})) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

/**
 * BFS 沿父母链向上，返回从 start 到其全部祖先（含自身）的“全部最短路径”。
 *
 * 返回 Map: ancestorId -> {
 *   gen: number,                 // 最短代数（向上步数）：自身 0、父母 1、祖父母 2……
 *   paths: Array<Array<id>>,     // 所有长度等于 gen 的路径，方向 start → ... → ancestor
 * }
 *
 * 同代数的不同路径全部保留（例如同时通过父系与母系到达同一祖父母）。
 */
function allShortestPathsUp(state, start) {
  const result = new Map();
  result.set(start, { gen: 0, paths: [[start]] });
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const curInfo = result.get(cur);
    for (const p of state.parentsOf[cur] || []) {
      const nextGen = curInfo.gen + 1;
      if (!result.has(p)) {
        // 首次以 BFS 到达 p，nextGen 即最短代数
        result.set(p, {
          gen: nextGen,
          paths: curInfo.paths.map((path) => [...path, p]),
        });
        queue.push(p);
      } else if (result.get(p).gen === nextGen) {
        // 同一最短代数经另一条路径再次到达 → 保留该路径
        const info = result.get(p);
        for (const path of curInfo.paths) info.paths.push([...path, p]);
      }
      // result.get(p).gen < nextGen：更长路径，丢弃
    }
  }
  return result;
}

/**
 * 查询两人的共同祖先。
 * 返回 {
 *   samePerson: boolean,
 *   minTotalGen: number,
 *   ancestors: [{ id, genA, genB, pathsA: [[id]], pathsB: [[id]] }]
 * }
 * minTotalGen 为所有共同祖先中 genA + genB 的最小值；
 * 只返回达到该最小值的全部共同祖先；没有共同祖先时 ancestors 为空。
 */
function findCommonAncestors(state, idA, idB) {
  if (!hasMember(state, idA) || !hasMember(state, idB)) {
    return { error: '成员不存在' };
  }

  if (idA === idB) {
    const self = allShortestPathsUp(state, idA).get(idA);
    return {
      samePerson: true,
      minTotalGen: 0,
      ancestors: [
        {
          id: idA,
          genA: 0,
          genB: 0,
          totalGen: 0,
          pathsA: self.paths,
          pathsB: self.paths,
        },
      ],
    };
  }

  const upA = allShortestPathsUp(state, idA);
  const upB = allShortestPathsUp(state, idB);

  const common = [];
  let minTotalGen = Infinity;
  for (const [ancestorId, infoA] of upA) {
    const infoB = upB.get(ancestorId);
    if (!infoB) continue;
    const totalGen = infoA.gen + infoB.gen;
    if (totalGen < minTotalGen) minTotalGen = totalGen;
    common.push({
      id: ancestorId,
      genA: infoA.gen,
      genB: infoB.gen,
      totalGen,
      pathsA: infoA.paths,
      pathsB: infoB.paths,
    });
  }

  const nearest = common
    .filter((c) => c.totalGen === minTotalGen)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    samePerson: false,
    minTotalGen: minTotalGen === Infinity ? null : minTotalGen,
    ancestors: nearest,
  };
}

/**
 * 辈分矛盾核查（纯函数，不修改 state、不写入任何数据）。
 *
 * 对每一对存在祖先关系的成员（祖先 ancestor、后代 descendant，两人不同），
 * 沿「父母 → 子女」关系（后代向上）分别求：
 *   - 最少代数 minGen：BFS 首达步数，以及其中一条完整最短成员链；
 *   - 最多代数 maxGen：DAG 上的最长路（记忆化 DFS），以及一条完整最长成员链。
 * 只有 minGen < maxGen（同一对人在不同路径上代际跨度不一致）才列为矛盾；
 * 同代不同路径（minGen === maxGen，例如经父系、母系两条 2 代路径到同一祖父母）
 * 不报警。每一对祖先/后代只枚举一次（以后代为起点遍历其全部祖先）。
 *
 * filterId 可选：仅返回该成员作为祖先或后代参与的矛盾；
 * 但 total 仍为过滤前的矛盾总数，便于界面提示“全部 N 对、其中包含该成员 M 对”。
 * filterId 指向不存在的成员时返回 { error: '成员不存在' }。
 *
 * 返回 {
 *   total,      // 全部矛盾条数（过滤前）
 *   filtered,   // 是否使用了成员筛选
 *   conflicts: [{
 *     ancestorId, descendantId,
 *     minGen, maxGen, diff,           // diff = maxGen - minGen（代数差）
 *     shortestPath: [ancestorId, ..., descendantId],  // 祖先→子女→…→后代
 *     longestPath:  [ancestorId, ..., descendantId],
 *   }]
 * }
 */
function findGenerationConflicts(state, filterId = null) {
  if (filterId !== null && filterId !== undefined && !hasMember(state, filterId)) {
    return { error: '成员不存在' };
  }
  const filtered = !!filterId;

  // 子女邻接表：childrenOf[parent] = [child, ...]（沿父母→子女向下）
  const childrenOf = {};
  for (const member of state.members) childrenOf[member.id] = [];
  for (const childId of Object.keys(state.parentsOf || {})) {
    for (const parentId of state.parentsOf[childId] || []) {
      if (childrenOf[parentId]) childrenOf[parentId].push(childId);
    }
  }

  const all = [];

  for (const descendant of state.members) {
    const start = descendant.id;

    // BFS 向上：最少代数；shortestPrev 记录首达前驱（其子女），便于重建一条最短链
    const minGenOf = new Map([[start, 0]]);
    const shortestPrev = new Map([[start, null]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const p of state.parentsOf[cur] || []) {
        if (!minGenOf.has(p)) {
          minGenOf.set(p, minGenOf.get(cur) + 1);
          shortestPrev.set(p, cur);
          queue.push(p);
        }
      }
    }
    if (minGenOf.size <= 1) continue; // 该成员没有任何祖先

    // 最多代数：在「start 经父母链可达」的祖先子图（DAG）上做记忆化 DFS。
    // 向上走的图中边为 子女 → 父母，因此到达祖先 v 的最后一步来自 v 的某个
    // 同样可达的子女 c：longest(v) = max(longest(c) + 1)，base 为 start = 0。
    // parentsOf 保证整图为 DAG，递归必然收敛；不可达的子女不参与取 max。
    const memo = new Map([[start, 0]]);
    const longestPrev = new Map([[start, null]]);
    const longest = (v) => {
      if (memo.has(v)) return memo.get(v);
      let best = -Infinity;
      let bestChild = null;
      for (const c of childrenOf[v] || []) {
        if (!minGenOf.has(c)) continue; // 不在 start 可达祖先子图内
        const candidate = longest(c) + 1;
        if (candidate > best) {
          best = candidate;
          bestChild = c;
        }
      }
      memo.set(v, best);
      longestPrev.set(v, bestChild);
      return best;
    };

    // 沿前驱表重建 祖先 → 子女 → … → 后代 的完整成员链
    const rebuildPath = (prev, ancestorId) => {
      const path = [ancestorId];
      let cur = ancestorId;
      while (cur !== start) {
        cur = prev.get(cur);
        path.push(cur);
      }
      return path;
    };

    for (const ancestorId of minGenOf.keys()) {
      if (ancestorId === start) continue;
      const minGen = minGenOf.get(ancestorId);
      const maxGen = longest(ancestorId);
      if (maxGen <= minGen) continue; // 同代不同路径不算矛盾
      all.push({
        ancestorId,
        descendantId: start,
        minGen,
        maxGen,
        diff: maxGen - minGen,
        shortestPath: rebuildPath(shortestPrev, ancestorId),
        longestPath: rebuildPath(longestPrev, ancestorId),
      });
    }
  }

  all.sort((a, b) => {
    if (b.diff !== a.diff) return b.diff - a.diff;
    if (b.maxGen !== a.maxGen) return b.maxGen - a.maxGen;
    if (a.ancestorId !== b.ancestorId) return a.ancestorId.localeCompare(b.ancestorId);
    return a.descendantId.localeCompare(b.descendantId);
  });

  const conflicts = filtered
    ? all.filter((c) => c.ancestorId === filterId || c.descendantId === filterId)
    : all;

  return { total: all.length, filtered, conflicts };
}

module.exports = {
  MAX_PARENTS_PER_CHILD,
  MAX_MEMBERS,
  MAX_BATCH_EDGES,
  createState,
  getMember,
  isReachableUp,
  validateEdge,
  validateEdgeBatch,
  previewMergeMembers,
  allShortestPathsUp,
  findCommonAncestors,
  findGenerationConflicts,
};
