import { describe, expect, it, vi } from 'vitest';

import type { Queryable } from '../queue/queue';
import {
  loadAcceptedExternalResponse,
  loadExternalResponseBinding,
  sendWithLedger,
} from '../edge/crm/send-ledger';

describe('external accepted response ledger binding', () => {
  it('stores metadata on the existing send intention without creating another send', async () => {
    const acceptedResponse = { schema_version: '2', status: 'reply', checkpoint: { marker: true } };
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => 'ledger-1'),
      find: vi.fn(),
      rotate: vi.fn(),
      message: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => ({ id: 'message-1', status: 'sent' }));

    const outcome = await sendWithLedger(
      store,
      {
        tenantId: 'org',
        leadId: 'contact',
        jobId: 'job',
        seq: 1,
        body: 'Safe reply',
        acceptedResponse,
      },
      send,
    );

    expect(outcome.kind).toBe('sent');
    expect(store.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ acceptedResponse }),
      expect.any(String),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('recovers accepted metadata directly and does not touch the channel', async () => {
    const acceptedResponse = { schema_version: '2', status: 'reply' };
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'ledger-1',
            seq: 1,
            status: 'accepted',
            crm_message_id: 'message-1',
            external_response: acceptedResponse,
          },
        ],
      })),
    } as unknown as Queryable;

    await expect(
      loadAcceptedExternalResponse(db, { tenantId: 'org', jobId: 'job' }),
    ).resolves.toBe(acceptedResponse);
    expect(db.query).toHaveBeenCalledOnce();
  });

  it('reconciles a delivered message after a crash before returning metadata', async () => {
    const acceptedResponse = { schema_version: '2', status: 'reply' };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from send_ledger')) {
        return {
          rows: [
            {
              id: 'ledger-2',
              seq: 2,
              status: 'requested',
              crm_message_id: null,
              external_response: acceptedResponse,
            },
          ],
        };
      }
      if (sql.includes('from messages')) {
        return { rows: [{ id: 'message-2', status: 'delivered' }] };
      }
      return { rows: [] };
    });
    const db = { query } as unknown as Queryable;

    await expect(
      loadAcceptedExternalResponse(db, { tenantId: 'org', jobId: 'job' }),
    ).resolves.toBe(acceptedResponse);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status=$3"))).toBe(true);
  });

  it('rebinds an atomically proven unsent retry so delivered facts belong to candidate B', async () => {
    const candidateA = {
      schema_version: '2',
      status: 'reply',
      checkpoint: { captured_facts: { canonical_name: 'A' } },
    };
    const candidateB = {
      schema_version: '2',
      status: 'reply',
      checkpoint: { captured_facts: { canonical_name: 'B' } },
    };
    let boundResponse: unknown = candidateA;
    let ledgerStatus = 'requested';
    const preflightDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from send_ledger')) {
          return {
            rows: [
              {
                id: 'ledger-1',
                seq: 1,
                status: 'requested',
                crm_message_id: null,
                external_response: candidateA,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Queryable;
    const binding = await loadExternalResponseBinding(preflightDb, {
      tenantId: 'org',
      jobId: 'job',
    });
    expect(binding).toEqual({ kind: 'replaceable', response: candidateA });
    const generateCandidate = vi.fn(() => candidateB);
    const generated = generateCandidate();

    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => {
        throw { code: '23505' };
      }),
      find: vi.fn(async () => ({
        id: 'ledger-1',
        status: 'requested' as const,
        crm_message_id: null,
        external_response: boundResponse,
      })),
      rotate: vi.fn(),
      rebindUnsent: vi.fn(async (input) => {
        boundResponse = input.acceptedResponse;
        return true;
      }),
      message: vi.fn(async () => null),
      update: vi.fn(async (_org, _key, status) => {
        ledgerStatus = status;
      }),
    };
    const send = vi.fn(async () => ({ id: 'message-b', status: 'sent' }));

    await expect(
      sendWithLedger(
        store,
        {
          tenantId: 'org',
          leadId: 'contact',
          jobId: 'job',
          seq: 1,
          body: 'Candidate B',
          acceptedResponse: generated,
        },
        send,
      ),
    ).resolves.toMatchObject({ kind: 'sent', crmMessageId: 'message-b' });

    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'ledger-1',
            seq: 1,
            status: ledgerStatus,
            crm_message_id: 'message-b',
            external_response: boundResponse,
          },
        ],
      })),
    } as unknown as Queryable;
    await expect(
      loadAcceptedExternalResponse(db, { tenantId: 'org', jobId: 'job' }),
    ).resolves.toBe(candidateB);
    expect(boundResponse).toBe(candidateB);
    expect(generateCandidate).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(store.rotate).not.toHaveBeenCalled();
  });

  it('keeps candidate A and does not regenerate or resend while delivery is ambiguous', async () => {
    const candidateA = { schema_version: '2', status: 'reply', checkpoint: { marker: 'A' } };
    const candidateB = { schema_version: '2', status: 'reply', checkpoint: { marker: 'B' } };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from send_ledger')) {
        return {
          rows: [
            {
              id: 'ledger-1',
              seq: 1,
              status: 'requested',
              crm_message_id: 'message-a',
              external_response: candidateA,
            },
          ],
        };
      }
      if (sql.includes('from messages')) {
        return { rows: [{ id: 'message-a', status: 'sending' }] };
      }
      return { rows: [] };
    });
    const binding = await loadExternalResponseBinding(
      { query } as unknown as Queryable,
      { tenantId: 'org', jobId: 'job' },
    );
    expect(binding).toEqual({ kind: 'pending', response: candidateA });
    const generateCandidate = vi.fn(() => candidateB);
    if (binding?.kind !== 'pending') generateCandidate();
    expect(generateCandidate).not.toHaveBeenCalled();

    let boundResponse: unknown = candidateA;
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => {
        throw { code: '23505' };
      }),
      find: vi.fn(async () => ({
        id: 'ledger-1',
        status: 'requested' as const,
        crm_message_id: 'message-a',
        external_response: candidateA,
      })),
      rotate: vi.fn(),
      rebindUnsent: vi.fn(async (input) => {
        boundResponse = input.acceptedResponse;
        return true;
      }),
      message: vi.fn(async () => ({ id: 'message-a', status: 'sending' })),
      update: vi.fn(),
    };
    const send = vi.fn(async () => ({ id: 'message-b', status: 'sent' }));
    await expect(
      sendWithLedger(
        store,
        {
          tenantId: 'org',
          leadId: 'contact',
          jobId: 'job',
          seq: 1,
          body: 'Candidate B',
          acceptedResponse: candidateB,
        },
        send,
      ),
    ).resolves.toMatchObject({ kind: 'queued', crmMessageId: 'message-a' });
    expect(boundResponse).toBe(candidateA);
    expect(store.rebindUnsent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed if the atomic unsent proof loses a race', async () => {
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => {
        throw { code: '23505' };
      }),
      find: vi.fn(async () => ({
        id: 'ledger-1',
        status: 'requested' as const,
        crm_message_id: null,
      })),
      rotate: vi.fn(),
      rebindUnsent: vi.fn(async () => false),
      message: vi.fn(async () => null),
      update: vi.fn(),
    };
    const send = vi.fn();
    await expect(
      sendWithLedger(
        store,
        {
          tenantId: 'org',
          leadId: 'contact',
          jobId: 'job',
          seq: 1,
          body: 'Candidate B',
          acceptedResponse: { schema_version: '2', status: 'reply' },
        },
        send,
      ),
    ).rejects.toThrow('send_ledger_external_response_rebind_ambiguous');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not replace a split candidate after an earlier bubble was accepted', async () => {
    const candidateA = { schema_version: '2', status: 'reply', checkpoint: { marker: 'A' } };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from send_ledger')) {
        return {
          rows: [
            {
              id: 'ledger-final',
              seq: 2,
              status: 'requested',
              crm_message_id: null,
              external_response: candidateA,
            },
            {
              id: 'ledger-first',
              seq: 1,
              status: 'accepted',
              crm_message_id: 'message-first',
              external_response: null,
            },
          ],
        };
      }
      if (sql.includes('from messages')) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      loadExternalResponseBinding(
        { query } as unknown as Queryable,
        { tenantId: 'org', jobId: 'job' },
      ),
    ).resolves.toEqual({ kind: 'pending', response: candidateA });
  });
});
