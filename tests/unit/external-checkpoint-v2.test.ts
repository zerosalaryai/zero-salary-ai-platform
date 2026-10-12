import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const inbound = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260930120000_0341_external_runtime_checkpoint_v2.sql',
  'utf8',
);
const baseline = readFileSync('supabase/baseline.sql', 'utf8');

describe('external runtime v2 checkpoint orchestration', () => {
  it('external turns skip published-agent auxiliary model calls but retain deterministic gates', () => {
    expect(inbound).toContain('if (!usesExternalRuntime && deps.knobs.compaction !== undefined)');
    expect(inbound).toContain('!usesExternalRuntime && deps.knobs.stageClassifier !== undefined');
    expect(inbound).toContain(
      '!usesExternalRuntime && camadaLigada(camadas.jailbreak, deps.knobs.jailbreak !== undefined)',
    );
    expect(inbound).toContain('const semanticClassifier = !usesExternalRuntime && camadaLigada(');
    expect(inbound).toContain('let chain = await runBeforeSend(beforeSendArgs)');
  });

  it('persists only a response recovered from an accepted ledger intention', () => {
    const recovery = inbound.indexOf('const acceptedRaw = await loadAcceptedExternalResponse');
    const checkpoint = inbound.indexOf('await insertCheckpoint(pool, {', recovery);
    const capture = inbound.indexOf('await persistStructuredLeadCapture({', checkpoint);
    expect(recovery).toBeGreaterThan(0);
    expect(checkpoint).toBeGreaterThan(recovery);
    expect(capture).toBeGreaterThan(checkpoint);
  });

  it('stops before regeneration while a bound external delivery is still ambiguous', () => {
    const binding = inbound.indexOf('const storedBinding = await loadExternalResponseBinding');
    const pending = inbound.indexOf('storedBinding?.kind === "pending"', binding);
    const generation = inbound.indexOf(': await executeExternalGeneration({', pending);
    expect(binding).toBeGreaterThan(0);
    expect(pending).toBeGreaterThan(binding);
    expect(generation).toBeGreaterThan(pending);
    expect(inbound).toContain('const queued = outcomes.find((outcome) => outcome.kind === "queued")');
    expect(inbound).toContain('entrega externa ainda em voo — turno reagendado');
  });

  it('installs the job uniqueness invariant only after preserving historical duplicates', () => {
    for (const sql of [migration, baseline]) {
      const repair = sql.indexOf('set job_id = null');
      const verification = sql.indexOf('lead_checkpoints still has duplicate');
      const uniqueIndex = sql.indexOf('create unique index if not exists uq_lead_checkpoints_org_job');
      expect(repair).toBeGreaterThan(0);
      expect(verification).toBeGreaterThan(repair);
      expect(uniqueIndex).toBeGreaterThan(verification);
      expect(sql).toContain('where job_id is not null');
    }
    expect(inbound).toContain(
      'on conflict (organization_id, job_id) where job_id is not null do nothing',
    );
  });
});
