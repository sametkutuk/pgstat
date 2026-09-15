import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { contextFromEnvironment, requestEvidence, type EvidenceContext, type EvidenceTool } from './apiEvidenceClient.js';

function output(context: EvidenceContext, tool: EvidenceTool,
                args: Parameters<typeof requestEvidence>[2] = {}) {
  return requestEvidence(context, tool, args)
    .then(body => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] }))
    .catch(error => ({ isError: true, content: [{ type: 'text' as const,
      text: error instanceof Error ? error.message : 'Kanıt API çağrısı başarısız' }] }));
}

/** One process, one investigation. No DB client, SQL tool, or arbitrary URL tool. */
export function createEvidenceMcp(context: EvidenceContext): McpServer {
  const server = new McpServer({ name: 'pgstat-evidence', version: '1.0.0' });
  server.registerTool('find_instance', { description: 'Bu araştırmanın tek yetkili instance kimliği ve PG sürümünü getir.',
    inputSchema: z.object({}).strict() }, async () => output(context, 'find_instance'));
  server.registerTool('get_telemetry_coverage', { description: 'Araştırma penceresinde kaynak başına gözlenen örnekleme kapsamını getir.',
    inputSchema: z.object({}).strict() }, async () => output(context, 'telemetry_coverage'));
  server.registerTool('get_autovacuum_overview', { description: 'Autovacuum ayarları, vacuum sayacı ve worker gözlemlerini ayrı kanıtlarla getir.',
    inputSchema: z.object({}).strict() }, async () => output(context, 'autovacuum_overview'));
  server.registerTool('find_tables_needing_vacuum_attention', { description: 'Sabit sıralama ölçütüne göre sınırlı tablo adaylarını getir; sıralama tanı değildir.',
    inputSchema: z.object({
      dbid: z.number().int().min(0).max(4294967295).optional(),
      ordering: z.enum(['dead_vs_threshold', 'dead_tuples', 'vacuum_age']).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }).strict() }, async args => output(context, 'vacuum_candidates', args));
  server.registerTool('get_table_vacuum_evidence', { description: 'Tek tablo için instance+dbid+relid kimliğiyle sınırlı vacuum kanıtı getir.',
    inputSchema: z.object({
      dbid: z.number().int().min(0).max(4294967295),
      relid: z.number().int().min(0).max(4294967295),
      max_points: z.number().int().min(1).max(200).optional(),
    }).strict() }, async args => output(context, 'table_vacuum_evidence', args));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void serveStdio(() => createEvidenceMcp(contextFromEnvironment()));
}
