import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';
import { Agentbase } from '../dist/service.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentbase-skills-'));
  const root = join(dir, 'project'); await mkdir(root);
  const store = new Store(join(dir, 'state'));
  const service = new Agentbase(store);
  const project = await service.call('project_open', { root });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, store, service, project,
    write: (name, args = {}) => service.call(name, { project_id: project.id, actor: 'skill-test', request_id: randomUUID(), ...args }),
    call: (name, args = {}) => service.call(name, { project_id: project.id, ...args }),
  };
}

const skill = (extra = {}) => ({ title: 'Spreadsheet import', description: 'Analyze workbook exports and preserve provenance.',
  triggers: ['spreadsheet exports'], tags: ['csv', 'xlsx'], applies_to: ['data analysis'], source: '/project/skills/spreadsheet/SKILL.md', ...extra });

test('skill catalog creates, searches, revises with versions, and filters disabled entries', async t => {
  const f = await fixture(t);
  const created = await f.write('skill_save', skill({ category: 'Data' }));
  assert.equal(created.kind, 'skill');
  assert.equal(created.body.category, 'Data');
  const found = await f.call('skill_list', { query: 'SPREADSHEET' });
  assert.equal(found.total, 1);
  assert.equal(found.records[0].id, created.id);

  const updated = await f.write('skill_save', skill({ id: created.id, expected_version: created.version, category: 'Data', status: 'disabled' }));
  assert.equal(updated.version, 2);
  assert.equal(updated.body.category, 'Data');
  await assert.rejects(f.write('skill_save', skill({ id: created.id, expected_version: created.version })), /changed/);
  assert.equal((await f.call('skill_list')).total, 0);
  assert.equal((await f.call('skill_list', { status: 'all' })).total, 1);
});

test('recommendations rank explainable metadata and remain project scoped', async t => {
  const f = await fixture(t);
  const high = await f.write('skill_save', skill());
  await f.write('skill_save', skill({ title: 'CSV helper', description: 'CSV tips.', triggers: [], tags: ['csv'], applies_to: [] }));
  await f.write('skill_save', skill({ title: 'Unrelated', description: 'No match.', triggers: ['network deployment'], tags: [], applies_to: [] }));
  const task = await f.write('task_create', { title: 'Analyze spreadsheet exports', description: 'Review CSV and XLSX data for a data analysis report.', acceptance: ['Preserve workbook provenance.'] });
  const result = await f.call('skill_recommend', { task_id: task.id });
  assert.deepEqual(result.recommendations.map(item => item.title), ['Spreadsheet import', 'CSV helper']);
  assert.equal(result.recommendations[0].id, high.id);
  assert.ok(result.recommendations[0].score > result.recommendations[1].score);
  assert.match(result.recommendations[0].reasons.join(' '), /trigger/);
  assert.equal(Object.hasOwn(result.recommendations[0], 'content'), false);
  assert.match(result.note, /host decides/);

  const otherRoot = join(f.dir, 'other'); await mkdir(otherRoot);
  const other = await f.service.call('project_open', { root: otherRoot });
  const isolated = await f.service.call('skill_recommend', { project_id: other.id, query: 'spreadsheet exports csv xlsx' });
  assert.deepEqual(isolated.recommendations, []);
});

test('recommendation limit is bounded and unsupported source schemes are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.write('skill_save', skill({ source: 'javascript:alert(1)' })));
  await assert.rejects(f.call('skill_recommend', { query: 'csv', limit: 21 }));
});
