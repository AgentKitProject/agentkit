/**
 * PROVIDER contract test: toPublicKitDetail surfaces suggested automations
 * from the persisted validation summary, re-validated through the contracts
 * schema — and the composed detail parses under the contracts
 * publicKitDetailSchema (the consumer's exact shape). Legacy records (no
 * automations anywhere) omit the field entirely.
 */
import { describe, it, expect } from 'vitest';
import { publicKitDetailSchema } from '@agentkitforge/contracts';
import { toPublicKitDetail } from '../src/core/services/index.js';
import type { KitRecord, KitVersionRecord, PublisherRecord } from '../src/core/types.js';

const AUTOMATION = {
  name: 'Daily digest',
  description: 'Every morning.',
  trigger: { type: 'schedule', config: { cron: '0 9 * * *' } },
  promptTemplate: 'Summarize the day.'
};

function kit(over: Partial<KitRecord> = {}): KitRecord {
  return {
    kitId: 'kit_1',
    slug: 'daily-digest',
    name: 'Daily Digest',
    summary: 'A kit',
    publisherId: 'Pub',
    currentVersion: 'v2',
    ...over
  } as KitRecord;
}

function version(over: Partial<KitVersionRecord> = {}): KitVersionRecord {
  return { kitId: 'kit_1', version: 'v2', ...over };
}

const publisher = { publisherId: 'Pub', displayName: 'Pub' } as unknown as PublisherRecord;

describe('toPublicKitDetail — suggested automations (provider contract)', () => {
  it('surfaces automations from the KIT validation summary and parses under contracts', () => {
    const detail = toPublicKitDetail(
      kit({ validationSummary: { status: 'passed', automations: [AUTOMATION] } }),
      publisher,
      [version()]
    );
    expect(detail.automations).toHaveLength(1);
    const parsed = publicKitDetailSchema.safeParse(detail);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.automations?.[0]?.name).toBe('Daily digest');
  });

  it('falls back to the LATEST VERSION validation summary', () => {
    const detail = toPublicKitDetail(kit(), publisher, [
      version({ validationSummary: { status: 'passed', automations: [AUTOMATION] } })
    ]);
    expect(detail.automations).toHaveLength(1);
  });

  it('legacy records / malformed entries → field omitted, detail still parses', () => {
    const legacy = toPublicKitDetail(kit(), publisher, [version()]);
    expect('automations' in legacy).toBe(false);
    expect(publicKitDetailSchema.safeParse(legacy).success).toBe(true);

    const smuggled = toPublicKitDetail(
      kit({ validationSummary: { automations: [{ ...AUTOMATION, approvalId: 'a1' }] } }),
      publisher,
      [version()]
    );
    expect('automations' in smuggled).toBe(false);
  });
});
