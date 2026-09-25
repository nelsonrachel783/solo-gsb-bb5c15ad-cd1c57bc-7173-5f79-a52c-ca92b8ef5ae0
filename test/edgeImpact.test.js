'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createState,
  validateEdge,
  previewEdgeImpact,
} = require('../server/familyGraph');
const { createStore } = require('../server/store');

/** 测试辅助：批量建成员（成员 id 与姓名相同） */
function makeState(names, existing = []) {
  const state = createState();
  for (const name of names) {
    state.members.push({ id: name, name });
    state.parentsOf[name] = [];
  }
  for (const [p, c] of existing) {
    const r = validateEdge(state, p, c);
    assert.equal(r.error, null, `准备数据失败 ${p} -> ${c}: ${r.error}`);
    state.parentsOf[c].push(p);
  }
  return state;
}

function edgeCount(state) {
  return Object.values(state.parentsOf).reduce((n, ps) => n + ps.length, 0);
}

test('影响预览：新增合法边产生新矛盾时按成员对列入 added，并给出最短/最长链', () => {
  // A -> B -> C -> Z 为单链，原本没有矛盾；新增 A -> Z 后 (A,Z) 1 代 vs 3 代
  const state = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'Z'],
  ]);
  const r = previewEdgeImpact(state, 'add', 'A', 'Z');
  assert.equal(r.error, null);
  assert.equal(r.action, 'add');
  assert.equal(r.beforeTotal, 0);
  assert.equal(r.afterTotal, 1);
  assert.equal(r.added.length, 1);
  assert.equal(r.removed.length, 0);
  assert.equal(r.changed.length, 0);
  assert.equal(r.unchangedCount, 0);

  const c = r.added[0];
  assert.equal(c.ancestorId, 'A');
  assert.equal(c.descendantId, 'Z');
  assert.equal(c.minGen, 1);
  assert.equal(c.maxGen, 3);
  assert.equal(c.diff, 2);
  assert.deepEqual(c.shortestPath, ['A', 'Z']);
  assert.deepEqual(c.longestPath, ['A', 'B', 'C', 'Z']);
});

test('影响预览：新增沿用成员存在、重复、父母上限、自指与祖先环路校验', () => {
  const state = makeState(['A', 'B', 'C', 'X', 'Y'], [
    ['A', 'B'],
    ['B', 'C'],
    ['X', 'A'],
    ['Y', 'A'], // A 已有两位父母
  ]);

  assert.match(previewEdgeImpact(state, 'add', '幽灵', 'A').error, /父母成员不存在/);
  assert.match(previewEdgeImpact(state, 'add', 'A', '幽灵').error, /子女成员不存在/);
  assert.match(previewEdgeImpact(state, 'add', 'A', 'A').error, /自指/);
  assert.match(previewEdgeImpact(state, 'add', 'A', 'B').error, /重复/);
  assert.match(previewEdgeImpact(state, 'add', 'C', 'A').error, /父母|至多/);
  assert.match(previewEdgeImpact(state, 'add', 'C', 'A').error, /至多 2/);
  // 祖先环路：已有 A->B->C，再加 C->A 会成环
  assert.match(previewEdgeImpact(state, 'add', 'C', 'B').error, /环路/);
  assert.equal(previewEdgeImpact(state, 'bogus', 'A', 'B').error.includes('add'), true);

  // 任何校验失败都不得修改原状态
  assert.equal(edgeCount(state), 4);
});

test('影响预览：移除边使矛盾消失时按成员对列入 removed，附变更前的链', () => {
  // A -> B -> C -> Z 且 A -> Z：(A,Z) 1 代 vs 3 代矛盾；移除 A -> Z 后为单链
  const state = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'Z'],
    ['A', 'Z'],
  ]);
  const r = previewEdgeImpact(state, 'remove', 'A', 'Z');
  assert.equal(r.error, null);
  assert.equal(r.beforeTotal, 1);
  assert.equal(r.afterTotal, 0);
  assert.equal(r.removed.length, 1);
  assert.equal(r.added.length, 0);
  assert.equal(r.changed.length, 0);

  const c = r.removed[0];
  assert.equal(c.ancestorId, 'A');
  assert.equal(c.descendantId, 'Z');
  assert.equal(c.minGen, 1);
  assert.equal(c.maxGen, 3);
  assert.deepEqual(c.shortestPath, ['A', 'Z']);
  assert.deepEqual(c.longestPath, ['A', 'B', 'C', 'Z']);
});

test('影响预览：移除不存在的关系或成员时报错', () => {
  const state = makeState(['A', 'B'], [['A', 'B']]);
  assert.match(previewEdgeImpact(state, 'remove', 'B', 'A').error, /关系不存在/);
  assert.match(previewEdgeImpact(state, 'remove', '幽灵', 'A').error, /成员不存在/);
  assert.match(previewEdgeImpact(state, 'remove', 'A', '幽灵').error, /成员不存在/);
});

test('影响预览：代数范围变化但矛盾仍在时列入 changed，总数可以不变（不能只比总数）', () => {
  // A->B->C->Z 且 A->C：
  //   (A,C) 1 代 vs 2 代（矛盾）；(A,Z) 2 代(A->C->Z) vs 3 代(A->B->C->Z)（矛盾）。
  // 新增 A->Z：(A,Z) 变为 1 代 vs 3 代 → changed；(A,C) 不变。
  // 矛盾总数 2 -> 2 不变，但若只比较总数就会漏掉这一变化。
  const state = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['A', 'C'],
    ['C', 'Z'],
  ]);
  const r = previewEdgeImpact(state, 'add', 'A', 'Z');
  assert.equal(r.error, null);
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 2);
  assert.equal(r.added.length, 0);
  assert.equal(r.removed.length, 0);
  assert.equal(r.changed.length, 1);
  assert.equal(r.unchangedCount, 1);

  const c = r.changed[0];
  assert.equal(c.ancestorId, 'A');
  assert.equal(c.descendantId, 'Z');
  assert.equal(c.before.minGen, 2);
  assert.equal(c.before.maxGen, 3);
  assert.equal(c.before.diff, 1);
  assert.deepEqual(c.before.shortestPath, ['A', 'C', 'Z']);
  assert.deepEqual(c.before.longestPath, ['A', 'B', 'C', 'Z']);
  assert.equal(c.after.minGen, 1);
  assert.equal(c.after.maxGen, 3);
  assert.equal(c.after.diff, 2);
  assert.deepEqual(c.after.shortestPath, ['A', 'Z']);
  assert.deepEqual(c.after.longestPath, ['A', 'B', 'C', 'Z']);
});

test('影响预览：移除边也可能只改变代数范围（矛盾不消失）', () => {
  // A->B->C->Z、A->C、A->Z：(A,Z) 1 代 vs 3 代；移除 A->Z 后变为 2 代 vs 3 代，仍是矛盾。
  const state = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['A', 'C'],
    ['C', 'Z'],
    ['A', 'Z'],
  ]);
  const r = previewEdgeImpact(state, 'remove', 'A', 'Z');
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 2);
  assert.equal(r.removed.length, 0);
  assert.equal(r.added.length, 0);
  const c = r.changed.find((x) => x.ancestorId === 'A' && x.descendantId === 'Z');
  assert.ok(c);
  assert.equal(c.before.minGen, 1);
  assert.equal(c.after.minGen, 2);
  assert.equal(c.before.maxGen, 3);
  assert.equal(c.after.maxGen, 3);
});

test('影响预览：新增不会让既有矛盾消失、移除不会产生新矛盾', () => {
  // 构造两对矛盾：(A,Z) 2v3 与 (A,C) 1v2
  const state = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['A', 'C'],
    ['C', 'Z'],
  ]);
  // 新增 B->Z：(B,Z) 新出现 1 vs 2；(A,Z) 仍为 2v3（A->B->Z 也是 2 代）、(A,C) 不变
  const addR = previewEdgeImpact(state, 'add', 'B', 'Z');
  assert.equal(addR.beforeTotal, 2);
  assert.equal(addR.afterTotal, 3);
  assert.equal(addR.removed.length, 0);
  assert.equal(addR.added.length, 1);
  assert.equal(addR.added[0].ancestorId, 'B');
  assert.equal(addR.added[0].descendantId, 'Z');
  assert.equal(addR.changed.length, 0);
  assert.equal(addR.unchangedCount, 2);

  // 逆操作：在含 B->Z 的图上移除 B->Z，应得到完全对称的结论
  const withEdge = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['A', 'C'],
    ['C', 'Z'],
    ['B', 'Z'],
  ]);
  const rmR = previewEdgeImpact(withEdge, 'remove', 'B', 'Z');
  assert.equal(rmR.beforeTotal, 3);
  assert.equal(rmR.afterTotal, 2);
  assert.equal(rmR.added.length, 0);
  assert.equal(rmR.removed.length, 1);
  assert.equal(rmR.removed[0].ancestorId, 'B');
  assert.equal(rmR.removed[0].descendantId, 'Z');
  assert.equal(rmR.changed.length, 0);
  assert.equal(rmR.unchangedCount, 2);
});

test('影响预览：无任何变化时三类列表都为空', () => {
  // 单链家谱上新增一条无关成员之间的关系，不产生矛盾
  const state = makeState(['A', 'B', 'C', 'P'], [
    ['A', 'B'],
    ['B', 'C'],
  ]);
  const r = previewEdgeImpact(state, 'add', 'P', 'A');
  assert.equal(r.beforeTotal, 0);
  assert.equal(r.afterTotal, 0);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.changed, []);
  assert.equal(r.unchangedCount, 0);
});

test('影响预览：构造假设图不修改原状态（不落盘、不改内存）', () => {
  const state = makeState(['A', 'B', 'C', 'Z'], [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'Z'],
  ]);
  const beforeEdges = edgeCount(state);
  previewEdgeImpact(state, 'add', 'A', 'Z');
  previewEdgeImpact(state, 'remove', 'A', 'B');
  assert.equal(edgeCount(state), beforeEdges);
  assert.deepEqual(state.parentsOf['Z'], ['C']);
  assert.deepEqual(state.parentsOf['B'], ['A']);
});

test('影响预览（store）：只读，不推进版本、不产生撤销快照、不落盘新关系', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-'));
  const file = path.join(dir, 'family.json');
  const store = createStore(file);
  const A = store.addMember('A').member;
  const B = store.addMember('B').member;
  const C = store.addMember('C').member;
  const Z = store.addMember('Z').member;
  store.addEdge(A.id, B.id);
  store.addEdge(B.id, C.id);
  store.addEdge(C.id, Z.id);
  const versionBefore = store.getVersion();
  const snapshotMtime = fs.statSync(file).mtimeMs;

  const r = store.previewImpact('add', A.id, Z.id);
  assert.equal(r.error, null);
  assert.equal(r.added.length, 1);

  // 版本不变、关系未写入、无新的撤销快照（最近操作仍是建立关系）
  assert.equal(store.getVersion(), versionBefore);
  assert.equal(store.list().edges.length, 3);
  assert.ok(store.list().undo);
  assert.match(store.list().undo.label, /建立关系/);
  assert.equal(fs.statSync(file).mtimeMs, snapshotMtime);
});
