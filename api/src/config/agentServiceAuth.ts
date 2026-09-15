import { timingSafeEqual } from 'node:crypto';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { pool } from './database';
import { verifyAccessToken } from './auth';

export const AGENT_EVIDENCE_TOOLS = [
  'find_instance', 'telemetry_coverage', 'autovacuum_overview',
  'vacuum_candidates', 'table_vacuum_evidence',
] as const;

interface EvidenceClaim extends JwtPayload {
  kind: 'agent_evidence';
  investigation_id: string;
  instance_pk: string;
  claimed_by: string;
  time_from: string;
  time_to: string;
  dbid: number | null;
  allowed_tools: string[];
}

function configuredSecret(): string | null {
  const value = process.env.PGSTAT_AGENT_SERVICE_SECRET;
  return value && value.length >= 32 ? value : null;
}

export function requireAgentService(req: Request, res: Response, next: NextFunction): void {
  const secret = configuredSecret();
  if (!secret) { res.status(503).json({ error: 'AI servisi yapılandırılmadı' }); return; }
  const supplied = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Servis yetkisi gerekli' }); return;
  }
  next();
}

export function signEvidenceClaim(input: {
  investigation_id: string; instance_pk: string; claimed_by: string;
  time_from: string; time_to: string; dbid: number | null;
}): string {
  const secret = configuredSecret();
  if (!secret) throw new Error('AI servisi yapılandırılmadı');
  return sign({ ...input, kind: 'agent_evidence', allowed_tools: [...AGENT_EVIDENCE_TOOLS] }, secret,
    { expiresIn: '10m', issuer: 'pgstat-api', audience: 'pgstat-agent-evidence', algorithm: 'HS256' });
}

function parseClaim(token: string): EvidenceClaim | null {
  const secret = configuredSecret();
  if (!secret) return null;
  try {
    const claim = verify(token, secret, { issuer: 'pgstat-api', audience: 'pgstat-agent-evidence', algorithms: ['HS256'] });
    if (typeof claim === 'string' || claim.kind !== 'agent_evidence'
        || !/^[1-9]\d{0,18}$/.test(String(claim.investigation_id))
        || !/^[1-9]\d{0,18}$/.test(String(claim.instance_pk))
        || typeof claim.claimed_by !== 'string' || !Array.isArray(claim.allowed_tools)) return null;
    return claim as EvidenceClaim;
  } catch { return null; }
}

const TOOL_FROM_SUFFIX: Record<string, string> = {
  'telemetry-coverage': 'telemetry_coverage',
  'autovacuum-overview': 'autovacuum_overview',
  'vacuum-candidates': 'vacuum_candidates',
  'table-vacuum-evidence': 'table_vacuum_evidence',
};

/** Admin JWT or active, row-bound agent claim. The MCP never sees DB credentials. */
export async function requireEvidenceAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) { res.status(401).json({ error: 'Yetkilendirme gerekli' }); return; }
  if (verifyAccessToken(token)) { next(); return; }
  const claim = parseClaim(token);
  if (!claim) { res.status(401).json({ error: 'Geçersiz kanıt yetkisi' }); return; }
  const isInstances = req.path === '/instances';
  const segments = req.path.split('/').filter(Boolean);
  const tool = isInstances ? 'find_instance' : TOOL_FROM_SUFFIX[segments[1] ?? ''];
  if (!tool || !claim.allowed_tools.includes(tool)
      || (!isInstances && segments[0] !== claim.instance_pk)) {
    res.status(403).json({ error: 'Kanıt yetkisi bu hedefi veya aracı kapsamıyor' }); return;
  }
  if (!isInstances) {
    const from = req.query.from;
    const to = req.query.to;
    if (typeof from !== 'string' || typeof to !== 'string'
        || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))
        || Date.parse(from) !== Date.parse(claim.time_from)
        || Date.parse(to) !== Date.parse(claim.time_to)) {
      res.status(403).json({ error: 'Kanıt yetkisi bu zaman aralığını kapsamıyor' }); return;
    }
    if (claim.dbid !== null && ['vacuum_candidates', 'table_vacuum_evidence'].includes(tool)
        && String(req.query.dbid) !== String(claim.dbid)) {
      res.status(403).json({ error: 'Kanıt yetkisi bu veritabanını kapsamıyor' }); return;
    }
  }
  try {
    const row = await pool.query(
      `select 1 from agent.investigation where investigation_id = $1 and instance_pk = $2
         and claimed_by = $3 and status in ('planning', 'collecting_evidence', 'interpreting')
         and time_from = $4::timestamptz and time_to = $5::timestamptz`,
      [claim.investigation_id, claim.instance_pk, claim.claimed_by, claim.time_from, claim.time_to]);
    if (!row.rowCount) { res.status(403).json({ error: 'Araştırma artık etkin değil' }); return; }
    // The instances endpoint may reveal only the scope's one instance.
    if (isInstances) res.locals.agent_instance_pk = claim.instance_pk;
    next();
  } catch (error) { next(error); }
}
