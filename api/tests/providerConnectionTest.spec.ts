import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { testProviderConnection } from '../src/services/providerConnectionTest';

test('Ollama connection probe stores success/failure and rejects stale results', async () => {
  const url = process.env.PGSTAT_PROVIDER_TEST_URL;
  assert.ok(url, 'PGSTAT_PROVIDER_TEST_URL must be a new disposable database');
  const db = new Pool({ connectionString: url });
  let mode: 'ok' | 'rate' | 'delayed' = 'ok';
  let releaseDelayed: (() => void) | undefined;
  const called: { path: string; body: unknown }[] = [];
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    called.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    if (mode === 'delayed') await new Promise<void>(resolve => { releaseDelayed = resolve; });
    res.setHeader('content-type', 'application/json');
    if (mode === 'rate') { res.statusCode = 429; res.end(JSON.stringify({ error: 'quota' })); }
    else res.end(JSON.stringify({ message: { content: 'READY' } }));
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await db.query('create schema control');
    await db.query('create table control.instance_inventory (instance_pk bigint primary key)');
    await db.query(await readFile('../db/migrations/V120__ai_investigation_and_telemetry_improvement.sql', 'utf8'));
    await db.query(await readFile('../db/migrations/V121__ai_provider_connection.sql', 'utf8'));
    await db.query(`insert into agent.provider_connection (provider, model_name, base_url)
      values ('ollama', 'fixture-model', $1)`, [`http://127.0.0.1:${address.port}`]);
    const good = await testProviderConnection(db, 'ollama');
    assert.equal(good.status, 'success');
    assert.equal((await db.query("select last_test_status from agent.provider_connection where provider='ollama'"))
      .rows[0].last_test_status, 'success');
    assert.equal(called[0].path, '/api/chat');
    assert.equal((called[0].body as any).messages[0].content, 'Reply with the single word READY.');
    mode = 'rate';
    const limited = await testProviderConnection(db, 'ollama');
    assert.deepEqual({ status: limited.status, error_code: limited.error_code },
      { status: 'failed', error_code: 'RATE_LIMITED' });
    mode = 'delayed';
    const pending = testProviderConnection(db, 'ollama');
    while (!releaseDelayed) await new Promise(resolve => setTimeout(resolve, 10));
    await db.query("update agent.provider_connection set model_name='changed-model', updated_at=now()+interval '1 second' where provider='ollama'");
    releaseDelayed();
    assert.deepEqual(await pending, { status: 'superseded' });
    const row = (await db.query("select model_name, last_test_status from agent.provider_connection where provider='ollama'"))
      .rows[0];
    assert.equal(row.model_name, 'changed-model');
    assert.equal(row.last_test_status, 'failed', 'stale result must not make changed config green');
  } finally {
    await db.end();
    await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
  }
});
