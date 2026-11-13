import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsView } from '../dist/operations.js';
const now = Date.parse('2026-11-12T01:00:00.000Z');
const at = minutes => new Date(now + minutes * 60000).toISOString();
const task = (id, body = {}, updated = -1, dependencies = []) => ({ id, kind: 'task', project_id: 'p', version: 1, created_at: at(-30), updated_at: at(updated), body: { title: id, status: 'in_progress', priority: 2, ...body }, dependencies });

test('operations distinguishes claimed, quiet and expired work using task updates, not unrelated actor activity', () => {
  const tasks = [task('recent', { owner: 'agent-a', lease_expires_at: at(30), progress: 'Running checks.' }), task('quiet', { owner: 'agent-b', lease_expires_at: at(30) }, -11), task('expired', { owner: 'agent-c', lease_expires_at: at(-1) })];
  const events = [{ actor: 'agent-b', action: 'created', record_id: 'unrelated', at: at(-0.1) }];
  const view = operationsView(tasks, events, now);
  assert.equal(view.agents.find(a => a.actor === 'agent-a').tasks[0].state, 'Claimed');
  assert.equal(view.agents.find(a => a.actor === 'agent-a').tasks[0].progress, 'Running checks.');
  assert.equal(view.agents.find(a => a.actor === 'agent-b').tasks[0].state, 'No update for 10m+');
  assert.equal(view.attention[0].severity, 'expired'); assert.equal(view.attention[1].severity, 'quiet');
  assert.match(view.attention[1].reason, /does not prove a stall/);
  assert.deepEqual(view.ready.map(t => t.id), ['expired']);
});

test('operations explains blockers and excludes blocked dependencies from ready work; done tasks have no alerts', () => {
  const view = operationsView([task('dependent', { status: 'ready' }, -1, [{ id: 'pre', title: 'Import source data', status: 'in_progress' }]), task('blocked', { status: 'blocked', blocked_reason: 'Need the source file.' }), task('done', { status: 'done', owner: 'old', lease_expires_at: at(-1) }), task('high', { status: 'ready', priority: 0 }), task('low', { status: 'ready', priority: 4 })], [], now);
  assert.deepEqual(view.ready.map(t => t.id), ['high', 'low']); assert.equal(view.attention.length, 2);
  assert.ok(view.attention.some(s => s.reason.includes('Import source data')));
  assert.ok(view.attention.some(s => s.reason.includes('Need the source file')));
  assert.equal(view.totals.done, 1); assert.ok(!view.agents.some(a => a.actor === 'old'));
});

test('recent actors without owned work show recorded activity, while historical sessions imply no presence', () => {
  const view = operationsView([], [{ actor: 'recent', action: 'old', record_id: 'r', at: at(-5) }, { actor: 'old', action: 'created', record_id: 'session', at: at(-30) }, { actor: 'recent', action: 'completed', record_id: 'r', at: at(-1) }, { actor: 'future', action: 'created', record_id: 'r', at: at(5) }], now);
  assert.equal(view.agents.length, 1); assert.equal(view.agents[0].actor, 'recent'); assert.equal(view.agents[0].tasks.length, 0); assert.equal(view.agents[0].last_action, 'completed');
  assert.match(view.rules, /do not prove a process is running/);
});

test('operations bounds visible lists while preserving totals and all owned work for an actor', () => {
  const owned = operationsView(Array.from({ length: 8 }, (_, i) => task(`owned${i}`, { owner: 'single-agent', lease_expires_at: at(10) })), [], now);
  assert.equal(owned.agents[0].tasks.length, 6); assert.equal(owned.agents[0].task_count, 8);
  const tasks = Array.from({ length: 35 }, (_, i) => task(`t${i}`, { owner: `agent-${i}`, lease_expires_at: at(-1) }));
  const view = operationsView(tasks, [], now); assert.equal(view.totals.agents, 35); assert.equal(view.agents.length, 30); assert.equal(view.attention.length, 30); assert.equal(view.ready.length, 30); assert.equal(view.totals.attention, 35);
});
