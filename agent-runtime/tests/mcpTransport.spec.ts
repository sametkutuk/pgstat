import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('real MCP stdio transport exposes only fixed evidence paths and validates arguments', async () => {
  const seen: string[] = [];
  const api = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer disposable-scoped-evidence-token');
    seen.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schema_version: '1.0.0', capability: 'test', status: 'no_data',
      data: null, coverage: [], limitations: ['Fixture returns no data'], gap_candidates: [] }));
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const from = '2026-09-14T00:00:00.000Z';
  const to = '2026-09-15T00:00:00.000Z';
  const client = new Client({ name: 'pgstat-transport-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    env: { ...process.env,
      PGSTAT_AGENT_API_URL: `http://127.0.0.1:${address.port}`,
      PGSTAT_AGENT_EVIDENCE_TOKEN: 'disposable-scoped-evidence-token',
      PGSTAT_AGENT_INSTANCE_PK: '12',
      PGSTAT_AGENT_TIME_FROM: from,
      PGSTAT_AGENT_TIME_TO: to,
    } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'find_instance', 'find_tables_needing_vacuum_attention', 'get_autovacuum_overview',
      'get_table_vacuum_evidence', 'get_telemetry_coverage',
    ].sort());
    assert.ok(!tools.some(tool => /sql|query_table|write/i.test(tool.name)));
    const overview = await client.callTool({ name: 'get_autovacuum_overview', arguments: {} });
    assert.equal(overview.isError, undefined);
    const block = overview.content[0];
    assert.ok(block && block.type === 'text');
    assert.equal(JSON.parse(block.text).status, 'no_data');
    assert.equal(seen.length, 1);
    const path = new URL(seen[0], `http://127.0.0.1:${address.port}`);
    assert.equal(path.pathname, '/api/agent-evidence/12/autovacuum-overview');
    assert.equal(path.searchParams.get('from'), from);
    assert.equal(path.searchParams.get('to'), to);

    const invalid = await client.callTool({ name: 'find_tables_needing_vacuum_attention',
      arguments: { ordering: 'drop table' } });
    assert.equal(invalid.isError, true);
    assert.equal(seen.length, 1, 'invalid schema must not reach API');
    const table = await client.callTool({ name: 'get_table_vacuum_evidence', arguments: { dbid: 5, relid: 6 } });
    assert.equal(table.isError, undefined);
    const tableUrl = new URL(seen[1], `http://127.0.0.1:${address.port}`);
    assert.equal(tableUrl.pathname, '/api/agent-evidence/12/table-vacuum-evidence');
    assert.equal(tableUrl.searchParams.get('dbid'), '5');
    assert.equal(tableUrl.searchParams.get('relid'), '6');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
});
