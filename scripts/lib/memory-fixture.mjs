import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const originalImplementation = `export function importInvoices(existing, incoming) {
  const seen = new Set(existing.map(row => row.invoice_number));
  const result = [...existing];
  for (const row of incoming) {
    if (!seen.has(row.invoice_number)) { result.push({...row}); seen.add(row.invoice_number); }
  }
  return result;
}\n`;

export const originalTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import {importInvoices} from './importer.mjs';
test('retains invoices belonging to different customers',()=>{
  const rows=[{customer_id:'a',invoice_number:'7',amount_cents:1234},{customer_id:'b',invoice_number:'7',amount_cents:5678}];
  assert.deepEqual(importInvoices([],rows),rows);
});
test('repeat imports remain idempotent and preserve integer cents',()=>{
  const rows=[{customer_id:'a',invoice_number:'7',amount_cents:1234}];
  assert.deepEqual(importInvoices(rows,rows),rows);
  assert.equal(Number.isInteger(importInvoices([],rows)[0].amount_cents),true);
});
test('composite identities do not collide when identifiers contain separators',()=>{
  const rows=[{customer_id:'a:b',invoice_number:'c',amount_cents:1},{customer_id:'a',invoice_number:'b:c',amount_cents:2}];
  assert.deepEqual(importInvoices([],rows),rows);
});\n`;

export async function writeMemoryFixture(root, directory) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  await writeFile(join(root, 'importer.mjs'), originalImplementation);
  await writeFile(join(root, 'importer.test.mjs'), originalTests);
  const acceptancePath = join(directory, 'original-acceptance.test.mjs');
  await writeFile(acceptancePath, originalTests.replace("'./importer.mjs'", JSON.stringify(pathToFileURL(join(root, 'importer.mjs')).href)));
  await writeFile(join(root, 'README.md'), 'Invoice import fixture. Run `npm test` to check behaviour.\n');
  return { originalImplementation, acceptancePath };
}
