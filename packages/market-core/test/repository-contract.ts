/**
 * Backend-parametric repository contract suite.
 *
 * This is the anti-drift guard: it pins the EXACT behavioral contract of the
 * CatalogRepository + AdminRepository ports (the submission/kit state machine,
 * TTL/lazy-expiry, duplicate + sha256 dedup, review-queue retention, catalog
 * listing/visibility, pagination, version ordering, download counting, and
 * hide/unhide/remove). Any adapter — AWS/DynamoDB or self-host/Postgres — must
 * satisfy it identically.
 *
 * Usage:
 *   runRepositoryContract('postgres', async () => {
 *     // ...build repos backed by a fresh store...
 *     return { catalog, admin, reset };
 *   });
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AdminRepository, AuditRepository, CatalogRepository, FavoritesRepository, OrgRepository } from '../src/core/ports.js';
import type {
  CreateSubmissionInput,
  SubmissionRecord,
} from '../src/core/types.js';
import {
  AWAITING_UPLOAD_TTL_MS,
  REVIEW_QUEUE_RETENTION_MS,
} from '../src/core/services/constants.js';
import { isHiddenFromDefaultReviewQueue } from '../src/core/services/index.js';
import { routeRequest } from '../src/core/routes/index.js';
import type { CoreRequest, RouterDeps } from '../src/core/routes/types.js';
import { decryptSecret, encryptSecret } from '../src/core/crypto.js';

export interface ContractRepos {
  catalog: CatalogRepository;
  admin: AdminRepository;
  /** Org repository. Optional so a backend can opt out, though both adapters provide it. */
  org?: OrgRepository;
  /** Favorites repository (cloud-synced kit references). Both adapters provide it. */
  favorites?: FavoritesRepository;
  /** Audit-log repository (append-only). Both adapters provide it. */
  audit?: AuditRepository;
  /** Truncate/recreate all backing tables so each test starts clean. */
  reset: () => Promise<void>;
}

/** A repos factory. Called once; `reset` is called before each test. */
export type MakeRepos = () => Promise<ContractRepos>;

function baseInput(overrides: Partial<CreateSubmissionInput> = {}): CreateSubmissionInput {
  return {
    fileName: 'kit.agentkit.zip',
    version: '1',
    publisherId: 'Ada Lovelace',
    submittedByUserId: 'user_1',
    submittedByEmail: 'ada@example.com',
    listingDraft: {
      name: 'My Cool Kit',
      summary: 'A cool kit',
      description: 'Longer description',
      categories: ['productivity'],
      tags: ['cli'],
    },
    ...overrides,
  };
}

/** Drives a submission through to the point just before publish. */
async function uploadAndQueue(admin: AdminRepository, input: CreateSubmissionInput): Promise<SubmissionRecord> {
  const { submission } = await admin.createSubmission(input);
  const job = await admin.createValidationJob(submission);
  await admin.markSubmissionValidationQueued(submission.submissionId, job.jobId);
  const updated = await admin.getSubmission(submission.submissionId);
  if (!updated) {
    throw new Error('submission disappeared after queue');
  }
  return updated;
}

export function runRepositoryContract(name: string, makeRepos: MakeRepos): void {
  describe(`repository contract [${name}]`, () => {
    let repos: ContractRepos;

    beforeEach(async () => {
      if (!repos) {
        repos = await makeRepos();
      }
      await repos.reset();
    });

    describe('createSubmission', () => {
      it('creates an awaiting_upload submission with server-owned ids and a TTL', async () => {
        const { submission, version } = await repos.admin.createSubmission(baseInput());

        expect(version).toBe('1');
        expect(submission.submissionId).toMatch(/^submission_/);
        expect(submission.kitId).toMatch(/^kit_/);
        expect(submission.packageS3Key).toBe(`submissions/${submission.submissionId}/package.agentkit.zip`);
        expect(submission.status).toBe('awaiting_upload');
        expect(submission.validationStatus).toBe('pending');
        expect(submission.reviewStatus).toBe('pending');
        expect(submission.submissionType).toBe('new_kit');
        expect(typeof submission.expiresAt).toBe('number');
        expect(submission.listingDraft.name).toBe('My Cool Kit');
        expect(submission.listingDraft.categories).toEqual(['productivity']);
      });

      it('round-trips the submission through getSubmission', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput());
        const fetched = await repos.admin.getSubmission(submission.submissionId);
        expect(fetched).toEqual(submission);
      });

      it('reuses the targetKitId for a version_update', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput({
          submissionType: 'version_update',
          targetKitId: 'kit_existing_abcd1234',
          version: '2',
        }));
        expect(submission.kitId).toBe('kit_existing_abcd1234');
        expect(submission.submissionType).toBe('version_update');
        expect(submission.targetKitId).toBe('kit_existing_abcd1234');
      });

      it('returns undefined for an unknown submission', async () => {
        expect(await repos.admin.getSubmission('submission_nope')).toBeUndefined();
      });
    });

    describe('listSubmissions', () => {
      it('returns submissions newest-first by createdAt', async () => {
        // createSubmission stamps createdAt from the wall clock, so fake ONLY
        // Date (leaving real timers for the AWS SDK) to control each row's
        // createdAt. Create OUT of insertion order — middle, newest, oldest —
        // so neither Postgres heap order nor DynamoDB hash order can coincide
        // with the expected newest-first result.
        vi.useFakeTimers({ toFake: ['Date'] });
        let middle: SubmissionRecord;
        let newest: SubmissionRecord;
        let oldest: SubmissionRecord;
        try {
          vi.setSystemTime(new Date('2020-01-01T00:00:02.000Z'));
          middle = (await repos.admin.createSubmission(baseInput())).submission;
          vi.setSystemTime(new Date('2020-01-01T00:00:03.000Z'));
          newest = (await repos.admin.createSubmission(baseInput())).submission;
          vi.setSystemTime(new Date('2020-01-01T00:00:01.000Z'));
          oldest = (await repos.admin.createSubmission(baseInput())).submission;
        } finally {
          vi.useRealTimers();
        }

        const listed = await repos.admin.listSubmissions();
        expect(listed.map((s) => s.submissionId)).toEqual([
          newest.submissionId,
          middle.submissionId,
          oldest.submissionId,
        ]);
        expect(listed.map((s) => s.createdAt)).toEqual([
          '2020-01-01T00:00:03.000Z',
          '2020-01-01T00:00:02.000Z',
          '2020-01-01T00:00:01.000Z',
        ]);
      });
    });

    describe('findActiveDuplicateSubmission', () => {
      it('returns undefined when there is no submitter user id', async () => {
        const input = baseInput({ submittedByUserId: undefined });
        await uploadAndQueue(repos.admin, baseInput());
        expect(await repos.admin.findActiveDuplicateSubmission(input)).toBeUndefined();
      });

      it('does NOT treat an awaiting_upload row as an active duplicate', async () => {
        // First attempt never uploaded -> still awaiting_upload -> not a duplicate.
        await repos.admin.createSubmission(baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput());
        expect(dup).toBeUndefined();
      });

      it('detects an active (queued) duplicate for same user + version + slug', async () => {
        await uploadAndQueue(repos.admin, baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput());
        expect(dup).toBeDefined();
        expect(dup?.status).toBe('validation_queued');
      });

      it('does not match a different version', async () => {
        await uploadAndQueue(repos.admin, baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput({ version: '2' }));
        expect(dup).toBeUndefined();
      });

      it('does not match a different listing name (slug)', async () => {
        await uploadAndQueue(repos.admin, baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput({
          listingDraft: { name: 'Different Kit', summary: 's' },
        }));
        expect(dup).toBeUndefined();
      });

      it('does not treat a rejected submission as an active duplicate', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        await repos.admin.rejectSubmission(queued.submissionId, 'nope', new Date().toISOString());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput());
        expect(dup).toBeUndefined();
      });
    });

    describe('state machine', () => {
      it('markSubmissionValidationQueued advances status and clears the TTL', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput());
        const job = await repos.admin.createValidationJob(submission);
        await repos.admin.markSubmissionValidationQueued(submission.submissionId, job.jobId);

        const updated = await repos.admin.getSubmission(submission.submissionId);
        expect(updated?.status).toBe('validation_queued');
        expect(updated?.validationStatus).toBe('queued');
        expect(updated?.expiresAt).toBeUndefined();
      });

      it('createValidationJob persists a queued job', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput());
        const job = await repos.admin.createValidationJob(submission);
        expect(job.jobId).toMatch(/^validation_/);
        expect(job.submissionId).toBe(submission.submissionId);
        expect(job.kitId).toBe(submission.kitId);
        expect(job.status).toBe('queued');
      });

      it('approveSubmission sets reviewStatus=approved with notes', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const reviewedAt = new Date().toISOString();
        const result = await repos.admin.approveSubmission(queued.submissionId, 'looks good', reviewedAt);
        expect(result?.reviewStatus).toBe('approved');
        expect(result?.reviewNotes).toBe('looks good');
        expect(result?.reviewedAt).toBe(reviewedAt);
        // status is unchanged by approve (publish flips status).
        expect(result?.status).toBe('validation_queued');
      });

      it('rejectSubmission flips status and reviewStatus to rejected', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const result = await repos.admin.rejectSubmission(queued.submissionId, 'bad', new Date().toISOString());
        expect(result?.reviewStatus).toBe('rejected');
        expect(result?.status).toBe('rejected');
        expect(result?.reviewNotes).toBe('bad');
      });

      it('archiveSubmission archives a non-published submission', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const result = await repos.admin.archiveSubmission(queued.submissionId, new Date().toISOString());
        expect(result?.status).toBe('archived');
      });

      it('archiveSubmission refuses a published submission', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        await repos.admin.approveSubmission(queued.submissionId, null, new Date().toISOString());
        const published = await repos.admin.getSubmission(queued.submissionId);
        await repos.admin.publishSubmission(published!, new Date().toISOString());
        const result = await repos.admin.archiveSubmission(queued.submissionId, new Date().toISOString());
        expect(result).toBeUndefined();
      });

      it('cancelSubmission cancels a non-published submission', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const result = await repos.admin.cancelSubmission(queued.submissionId, new Date().toISOString());
        expect(result?.status).toBe('canceled');
      });
    });

    describe('publishSubmission', () => {
      it('atomically creates a public kit + version and marks the submission published', async () => {
        const queued = await uploadAndQueue(repos.admin, {
          ...baseInput(),
        });
        const enriched: SubmissionRecord = {
          ...queued,
          packageSizeBytes: 1234,
          sha256: 'abc123sha',
          schemaVersion: '0.1',
          validationStatus: 'passed',
        };
        await repos.admin.approveSubmission(queued.submissionId, null, new Date().toISOString());
        const publishedAt = new Date().toISOString();
        const kit = await repos.admin.publishSubmission(enriched, publishedAt);

        expect(kit.status).toBe('published');
        expect(kit.validationStatus).toBe('passed');
        expect(kit.reviewStatus).toBe('approved');
        expect(kit.slug).toBe('my-cool-kit');
        expect(kit.currentVersion).toBe('1');
        expect(kit.badges).toEqual(['Validated', 'Reviewed']);
        expect(kit.ownerUserId).toBe('user_1');
        expect(kit.downloads).toBe(0);

        const storedKit = await repos.admin.getKit(kit.kitId);
        expect(storedKit?.slug).toBe('my-cool-kit');

        const version = await repos.admin.getKitVersion(kit.kitId, '1');
        expect(version?.sha256).toBe('abc123sha');
        expect(version?.packageSizeBytes).toBe(1234);

        const sub = await repos.admin.getSubmission(queued.submissionId);
        expect(sub?.status).toBe('published');
        expect(sub?.publishedAt).toBe(publishedAt);
      });

      it('preserves owner, createdAt, downloads on a version update (re-publish)', async () => {
        // v1
        const queued1 = await uploadAndQueue(repos.admin, baseInput());
        const kit1 = await repos.admin.publishSubmission(
          { ...queued1, validationStatus: 'passed' },
          '2026-01-01T00:00:00.000Z',
        );
        await repos.admin.incrementKitDownloads(kit1.kitId);

        // v2 targeting the same kit
        const queued2 = await uploadAndQueue(repos.admin, baseInput({
          submissionType: 'version_update',
          targetKitId: kit1.kitId,
          version: '2',
          submittedByUserId: 'user_other',
        }));
        const kit2 = await repos.admin.publishSubmission(
          { ...queued2, validationStatus: 'passed' },
          '2026-02-01T00:00:00.000Z',
        );

        expect(kit2.kitId).toBe(kit1.kitId);
        expect(kit2.currentVersion).toBe('2');
        expect(kit2.ownerUserId).toBe('user_1'); // original owner kept
        expect(kit2.createdAt).toBe('2026-01-01T00:00:00.000Z');
        expect(kit2.publishedAt).toBe('2026-01-01T00:00:00.000Z'); // first publish time kept
        expect(kit2.downloads).toBe(1); // download count preserved

        const versions = await repos.admin.listKitVersions(kit1.kitId);
        expect(versions.map((v) => v.version)).toEqual(['1', '2']);
      });
    });

    describe('catalog listing + visibility', () => {
      async function publishKit(input: CreateSubmissionInput): Promise<string> {
        const queued = await uploadAndQueue(repos.admin, input);
        const kit = await repos.admin.publishSubmission(
          { ...queued, validationStatus: 'passed' },
          new Date().toISOString(),
        );
        return kit.kitId;
      }

      it('lists only published∧passed∧approved kits', async () => {
        await publishKit(baseInput({ listingDraft: { name: 'Published Kit', summary: 's' } }));
        // A queued-but-not-published submission must not appear.
        await uploadAndQueue(repos.admin, baseInput({
          submittedByUserId: 'user_2',
          listingDraft: { name: 'Pending Kit', summary: 's' },
        }));

        const page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(1);
        expect(page.kits[0]?.slug).toBe('published-kit');
      });

      it('hidden / removed kits are excluded from the catalog', async () => {
        const kitId = await publishKit(baseInput());
        await repos.admin.hideKit(kitId);
        let page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(0);

        await repos.admin.unhideKit(kitId);
        page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(1);

        await repos.admin.removeKit(kitId, new Date().toISOString());
        page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(0);
      });

      it('attaches publisher snapshots in the page', async () => {
        await publishKit(baseInput());
        const page = await repos.catalog.listKits(20, undefined);
        const kit = page.kits[0]!;
        // publisher snapshot is stored on the kit row itself in this design.
        expect(kit.publisherId).toBe('Ada Lovelace');
      });

      it('paginates with a nextToken cursor', async () => {
        for (let i = 0; i < 3; i += 1) {
          await publishKit(baseInput({
            submittedByUserId: `user_${i}`,
            listingDraft: { name: `Kit Number ${i}`, summary: 's' },
          }));
        }

        const page1 = await repos.catalog.listKits(2, undefined);
        expect(page1.kits).toHaveLength(2);
        expect(page1.nextToken).toBeTruthy();

        const page2 = await repos.catalog.listKits(2, page1.nextToken ?? undefined);
        expect(page2.kits).toHaveLength(1);

        const seen = new Set([...page1.kits, ...page2.kits].map((k) => k.kitId));
        expect(seen.size).toBe(3);
      });

      it('getKitBySlug returns a published kit with versions newest-first', async () => {
        const queued1 = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued1, validationStatus: 'passed' }, new Date().toISOString());
        const queued2 = await uploadAndQueue(repos.admin, baseInput({
          submissionType: 'version_update', targetKitId: kit.kitId, version: '2',
        }));
        await repos.admin.publishSubmission({ ...queued2, validationStatus: 'passed' }, new Date().toISOString());

        const detail = await repos.catalog.getKitBySlug('my-cool-kit');
        expect(detail.kit?.kitId).toBe(kit.kitId);
        expect(detail.versions.map((v) => v.version)).toEqual(['2', '1']);
      });

      it('getKitBySlug hides non-public kits', async () => {
        const kitId = await publishKit(baseInput());
        await repos.admin.hideKit(kitId);
        const detail = await repos.catalog.getKitBySlug('my-cool-kit');
        expect(detail.kit).toBeUndefined();
        expect(detail.versions).toEqual([]);
      });
    });

    describe('sha256 dedup', () => {
      it('findKitVersionBySha256 finds a published version by digest', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        await repos.admin.publishSubmission(
          { ...queued, sha256: 'deadbeef', validationStatus: 'passed' },
          new Date().toISOString(),
        );
        const found = await repos.admin.findKitVersionBySha256('deadbeef');
        expect(found?.sha256).toBe('deadbeef');
        expect(await repos.admin.findKitVersionBySha256('nope')).toBeUndefined();
      });
    });

    describe('incrementKitDownloads', () => {
      it('increments the download counter', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued, validationStatus: 'passed' }, new Date().toISOString());
        await repos.admin.incrementKitDownloads(kit.kitId);
        await repos.admin.incrementKitDownloads(kit.kitId);
        const updated = await repos.admin.getKit(kit.kitId);
        expect(updated?.downloads).toBe(2);
      });
    });

    describe('hide / unhide guards', () => {
      it('hideKit / unhideKit / removeKit return undefined for unknown kits', async () => {
        expect(await repos.admin.hideKit('kit_nope')).toBeUndefined();
        expect(await repos.admin.unhideKit('kit_nope')).toBeUndefined();
        expect(await repos.admin.removeKit('kit_nope', new Date().toISOString())).toBeUndefined();
      });

      it('unhideKit refuses a kit that is not hidden', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued, validationStatus: 'passed' }, new Date().toISOString());
        expect(await repos.admin.unhideKit(kit.kitId)).toBeUndefined();
      });
    });

    describe('TTL / lazy-expiry semantics (via listSubmissions + service rule)', () => {
      it('a fresh awaiting_upload row is not yet hidden, a stale one is', async () => {
        await repos.admin.createSubmission(baseInput());
        const submissions = await repos.admin.listSubmissions();
        expect(submissions).toHaveLength(1);
        const sub = submissions[0]!;

        const now = Date.now();
        expect(isHiddenFromDefaultReviewQueue(sub, now)).toBe(false);
        // Past the TTL window -> lazily expired -> hidden from the queue.
        const wayLater = (sub.expiresAt ?? 0) * 1000 + AWAITING_UPLOAD_TTL_MS + 1;
        expect(isHiddenFromDefaultReviewQueue(sub, wayLater)).toBe(true);
      });

      it('an approved submission drops out of the queue after the retention window', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const reviewedAt = new Date().toISOString();
        await repos.admin.approveSubmission(queued.submissionId, null, reviewedAt);
        const sub = await repos.admin.getSubmission(queued.submissionId);

        const reviewedMs = Date.parse(reviewedAt);
        expect(isHiddenFromDefaultReviewQueue(sub!, reviewedMs + 1000)).toBe(false);
        expect(isHiddenFromDefaultReviewQueue(sub!, reviewedMs + REVIEW_QUEUE_RETENTION_MS + 1000)).toBe(true);
      });
    });

    describe('organizations (Market Phase 2)', () => {
      function org(): OrgRepository {
        if (!repos.org) {
          throw new Error('OrgRepository not provided by this backend');
        }
        return repos.org;
      }

      async function publishKit(input: CreateSubmissionInput): Promise<string> {
        const queued = await uploadAndQueue(repos.admin, input);
        const kit = await repos.admin.publishSubmission(
          { ...queued, validationStatus: 'passed' },
          new Date().toISOString(),
        );
        return kit.kitId;
      }

      it('createOrg creates a team org with an active owner membership', async () => {
        const created = await org().createOrg({ displayName: 'Acme Team', ownerUserId: 'user_owner' });
        expect(created.orgId).toMatch(/^org_/);
        expect(created.type).toBe('team');
        expect(created.slug).toBe('acme-team');
        expect(created.ownerUserId).toBe('user_owner');

        const membership = await org().getMembership(created.orgId, 'user_owner');
        expect(membership?.role).toBe('owner');
        expect(membership?.status).toBe('active');
      });

      it('createOrg dedupes slugs with a numeric suffix', async () => {
        const a = await org().createOrg({ displayName: 'Dup Org', ownerUserId: 'u1' });
        const b = await org().createOrg({ displayName: 'Dup Org', ownerUserId: 'u2' });
        const c = await org().createOrg({ displayName: 'Dup Org', ownerUserId: 'u3' });
        expect(a.slug).toBe('dup-org');
        expect(b.slug).toBe('dup-org-2');
        expect(c.slug).toBe('dup-org-3');
      });

      it('ensurePersonalOrg is idempotent', async () => {
        const first = await org().ensurePersonalOrg('user_p', 'Pat Personal');
        const second = await org().ensurePersonalOrg('user_p', 'Pat Personal');
        expect(first.orgId).toBe(second.orgId);
        expect(first.type).toBe('personal');
      });

      it('getOrg / getOrgBySlug round-trip', async () => {
        const created = await org().createOrg({ displayName: 'Lookup Org', ownerUserId: 'u_l' });
        expect((await org().getOrg(created.orgId))?.orgId).toBe(created.orgId);
        expect((await org().getOrgBySlug(created.slug))?.orgId).toBe(created.orgId);
        expect(await org().getOrg('org_nope')).toBeUndefined();
      });

      it('addMember creates an invite + invited membership; acceptInvite activates it', async () => {
        const created = await org().createOrg({ displayName: 'Invite Org', ownerUserId: 'u_owner' });

        const membership = await org().addMember(created.orgId, 'u_invitee', 'member', 'u_owner');
        expect(membership.status).toBe('invited');
        expect(membership.role).toBe('member');

        const invites = await org().listInvitesForUser('u_invitee');
        expect(invites).toHaveLength(1);
        expect(invites[0]?.orgId).toBe(created.orgId);

        // Invited (not yet active) members are still listed for the user.
        expect((await org().listOrgsForUser('u_invitee')).map((o) => o.orgId)).toContain(created.orgId);

        const accepted = await org().acceptInvite(created.orgId, 'u_invitee');
        expect(accepted?.status).toBe('active');

        // Invite is cleared after accept.
        expect(await org().listInvitesForUser('u_invitee')).toHaveLength(0);

        // Accepting a non-existent invite returns undefined.
        expect(await org().acceptInvite(created.orgId, 'u_invitee')).toBeUndefined();
      });

      it('email invites: create → listByEmail → claim creates membership, clears invite, idempotent', async () => {
        const org1 = await org().createOrg({ displayName: 'Email Invite Org 1', ownerUserId: 'u_owner' });
        const org2 = await org().createOrg({ displayName: 'Email Invite Org 2', ownerUserId: 'u_owner2' });

        // createEmailInvite stores an invite keyed by email (no userId).
        const invite = await org().createEmailInvite(org1.orgId, 'New.User@Example.com', 'member', 'u_owner');
        expect(invite.orgId).toBe(org1.orgId);
        expect(invite.email).toBe('new.user@example.com'); // normalized (trim + lowercase)
        expect(invite.userId).toBeUndefined();
        expect(invite.role).toBe('member');

        await org().createEmailInvite(org2.orgId, 'new.user@example.com', 'admin', 'u_owner2');

        // listInvitesByEmail is case-insensitive and finds both pending invites.
        const byEmail = await org().listInvitesByEmail('NEW.USER@example.com');
        expect(byEmail).toHaveLength(2);
        expect(byEmail.every((i) => i.userId === undefined)).toBe(true);
        expect(byEmail.map((i) => i.orgId).sort()).toEqual([org1.orgId, org2.orgId].sort());

        // An email invite is NOT surfaced via listInvitesForUser (which keys on real userId).
        expect(await org().listInvitesForUser('u_claimer')).toHaveLength(0);

        // claimInvitesByEmail creates active memberships and removes the invites.
        const claimed = await org().claimInvitesByEmail('new.user@example.com', 'u_claimer');
        expect(claimed).toHaveLength(2);
        expect(claimed.every((m) => m.status === 'active')).toBe(true);
        expect(claimed.every((m) => m.userId === 'u_claimer')).toBe(true);
        expect(claimed.map((m) => m.role).sort()).toEqual(['admin', 'member']);

        expect(await org().getMembership(org1.orgId, 'u_claimer')).toMatchObject({ status: 'active', role: 'member' });
        expect(await org().getMembership(org2.orgId, 'u_claimer')).toMatchObject({ status: 'active', role: 'admin' });

        // Invites are cleared after claim.
        expect(await org().listInvitesByEmail('new.user@example.com')).toHaveLength(0);

        // Idempotent: a second claim is a no-op (no new memberships).
        expect(await org().claimInvitesByEmail('new.user@example.com', 'u_claimer')).toHaveLength(0);
      });

      it('claimInvitesByEmail skips orgs the user is already an active member of', async () => {
        const created = await org().createOrg({ displayName: 'Already Member Org', ownerUserId: 'u_owner' });
        // Owner is already an active member; an email invite for the owner's email should be a no-op on claim.
        await org().createEmailInvite(created.orgId, 'owner@example.com', 'admin', 'u_owner');

        const claimed = await org().claimInvitesByEmail('owner@example.com', 'u_owner');
        expect(claimed).toHaveLength(0);

        // Owner keeps their original owner role (not downgraded to the invite's admin role).
        expect(await org().getMembership(created.orgId, 'u_owner')).toMatchObject({ status: 'active', role: 'owner' });

        // The invite is still cleared.
        expect(await org().listInvitesByEmail('owner@example.com')).toHaveLength(0);
      });

      it('listMembers returns all memberships; removeMember marks removed', async () => {
        const created = await org().createOrg({ displayName: 'Members Org', ownerUserId: 'u_owner' });
        await org().addMember(created.orgId, 'u_member', 'member', 'u_owner');
        await org().acceptInvite(created.orgId, 'u_member');

        expect((await org().listMembers(created.orgId)).map((m) => m.userId).sort())
          .toEqual(['u_member', 'u_owner']);

        await org().removeMember(created.orgId, 'u_member');
        const removed = await org().getMembership(created.orgId, 'u_member');
        expect(removed?.status).toBe('removed');
        // Removed members drop out of the user's org list.
        expect((await org().listOrgsForUser('u_member')).map((o) => o.orgId)).not.toContain(created.orgId);
      });

      it('listOrgsForUser lists orgs the user belongs to', async () => {
        const a = await org().createOrg({ displayName: 'Org A', ownerUserId: 'multi_user' });
        const b = await org().createOrg({ displayName: 'Org B', ownerUserId: 'multi_user' });
        const ids = (await org().listOrgsForUser('multi_user')).map((o) => o.orgId).sort();
        expect(ids).toEqual([a.orgId, b.orgId].sort());
      });

      it('setKitOwnerOrg transfers a kit to another org', async () => {
        const kitId = await publishKit(baseInput());
        const target = await org().createOrg({ displayName: 'Target Org', ownerUserId: 'user_1' });

        const updated = await org().setKitOwnerOrg(kitId, target.orgId);
        expect(updated?.ownerOrgId).toBe(target.orgId);

        const kits = await org().listKitsForOrg(target.orgId);
        expect(kits.map((k) => k.kitId)).toContain(kitId);

        expect(await org().setKitOwnerOrg('kit_nope', target.orgId)).toBeUndefined();
      });

      // NOTE: Stripe Connect seller-payout persistence (setOrgStripeAccount /
      // getOrgByStripeAccountId) is a commercial port; its contract lives in
      // @agentkit-commercial/market-core.

      it('setKitVisibility=private hides a kit from the public catalog', async () => {
        const kitId = await publishKit(baseInput());
        // Visible by default.
        expect((await repos.catalog.listKits(20, undefined)).kits).toHaveLength(1);

        const updated = await org().setKitVisibility(kitId, 'private');
        expect(updated?.visibility).toBe('private');

        // Excluded from the public listing + detail.
        expect((await repos.catalog.listKits(20, undefined)).kits).toHaveLength(0);
        expect((await repos.catalog.getKitBySlug('my-cool-kit')).kit).toBeUndefined();

        // Back to public restores it.
        await org().setKitVisibility(kitId, 'public');
        expect((await repos.catalog.listKits(20, undefined)).kits).toHaveLength(1);
      });

      it('listKitsForOrg includes private kits the public catalog hides', async () => {
        const kitId = await publishKit(baseInput());
        const target = await org().createOrg({ displayName: 'Owner Org', ownerUserId: 'user_1' });
        await org().setKitOwnerOrg(kitId, target.orgId);
        await org().setKitVisibility(kitId, 'private');

        const kits = await org().listKitsForOrg(target.orgId);
        expect(kits.map((k) => k.kitId)).toContain(kitId);
        expect(kits.find((k) => k.kitId === kitId)?.visibility).toBe('private');
      });

      it('a published kit defaults to public visibility', async () => {
        const kitId = await publishKit(baseInput());
        const kit = await repos.admin.getKit(kitId);
        expect(kit?.visibility).toBe('public');
      });

      describe('deleteOrg', () => {
        function adminRequest(orgId: string, body: Record<string, unknown>): CoreRequest {
          return {
            method: 'DELETE',
            resource: '/admin/orgs/{orgId}',
            pathParameters: { orgId },
            queryStringParameters: null,
            headers: { 'x-agentkitmarket-admin-key': 'test-admin-key' },
            body: JSON.stringify(body),
          };
        }

        function deps(): RouterDeps {
          return {
            repository: repos.catalog,
            adminRepository: repos.admin,
            orgRepository: repos.org,
            adminKey: 'test-admin-key',
          };
        }

        it('happy path: removes the org, its memberships, and its invites', async () => {
          const created = await org().createOrg({ displayName: 'Delete Me', ownerUserId: 'u_owner' });
          await org().addMember(created.orgId, 'u_member', 'member', 'u_owner');
          await org().acceptInvite(created.orgId, 'u_member');
          await org().addMember(created.orgId, 'u_pending', 'member', 'u_owner');

          const res = await routeRequest(adminRequest(created.orgId, { actorUserId: 'u_owner' }), deps());
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body)).toEqual({ ok: true, orgId: created.orgId });

          expect(await org().getOrg(created.orgId)).toBeUndefined();
          expect(await org().listMembers(created.orgId)).toHaveLength(0);
          expect(await org().getMembership(created.orgId, 'u_owner')).toBeUndefined();
          expect(await org().getMembership(created.orgId, 'u_member')).toBeUndefined();
          expect(await org().listInvitesForUser('u_pending')).toHaveLength(0);
        });

        it('refuses to delete a personal org', async () => {
          const personal = await org().ensurePersonalOrg('u_solo', 'Solo Dev');
          const res = await routeRequest(adminRequest(personal.orgId, { actorUserId: 'u_solo' }), deps());
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body).message).toMatch(/personal/i);
          expect(await org().getOrg(personal.orgId)).toBeDefined();
        });

        it('refuses to delete an org that still owns kits', async () => {
          const kitId = await publishKit(baseInput());
          const target = await org().createOrg({ displayName: 'Owns Kits', ownerUserId: 'user_1' });
          await org().setKitOwnerOrg(kitId, target.orgId);

          const res = await routeRequest(adminRequest(target.orgId, { actorUserId: 'user_1' }), deps());
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body).message).toMatch(/kits/i);
          expect(await org().getOrg(target.orgId)).toBeDefined();
        });

        it('refuses a non-owner/admin actor (member → 403)', async () => {
          const created = await org().createOrg({ displayName: 'Guarded Org', ownerUserId: 'u_owner' });
          await org().addMember(created.orgId, 'u_member', 'member', 'u_owner');
          await org().acceptInvite(created.orgId, 'u_member');

          const res = await routeRequest(adminRequest(created.orgId, { actorUserId: 'u_member' }), deps());
          expect(res.statusCode).toBe(403);
          expect(await org().getOrg(created.orgId)).toBeDefined();
        });

        it('allows an admin (non-owner) to delete', async () => {
          const created = await org().createOrg({ displayName: 'Admin Deletes', ownerUserId: 'u_owner' });
          await org().addMember(created.orgId, 'u_admin', 'admin', 'u_owner');
          await org().acceptInvite(created.orgId, 'u_admin');

          const res = await routeRequest(adminRequest(created.orgId, { actorUserId: 'u_admin' }), deps());
          expect(res.statusCode).toBe(200);
          expect(await org().getOrg(created.orgId)).toBeUndefined();
        });

        it('returns 404 for an unknown org', async () => {
          const res = await routeRequest(adminRequest('org_nope', { actorUserId: 'u_owner' }), deps());
          expect(res.statusCode).toBe(404);
        });
      });

      describe('org shared LLM API key (encrypted at rest)', () => {
        function req(method: string, resource: string, pathParameters: Record<string, string>, body?: unknown, query?: Record<string, string>): CoreRequest {
          return {
            method,
            resource,
            pathParameters,
            queryStringParameters: query ?? null,
            headers: { 'x-agentkitmarket-admin-key': 'test-admin-key' },
            body: body === undefined ? null : JSON.stringify(body),
          };
        }

        function deps(): RouterDeps {
          return {
            repository: repos.catalog,
            adminRepository: repos.admin,
            orgRepository: repos.org,
            adminKey: 'test-admin-key',
          };
        }

        it('set (per provider) → status (lists providers) → resolve (single org, per provider) → clear', async () => {
          const created = await org().createOrg({ displayName: 'Key Org', ownerUserId: 'u_owner' });

          // Set two providers' keys on the org.
          const setAnthropic = await routeRequest(
            req('POST', '/admin/orgs/{orgId}/api-key', { orgId: created.orgId }, {
              actorUserId: 'u_owner', providerType: 'anthropic', apiKey: 'sk-ant-secret-Xy12', baseUrl: 'https://api.anthropic.com',
            }),
            deps(),
          );
          expect(setAnthropic.statusCode).toBe(200);
          expect(JSON.parse(setAnthropic.body)).toEqual({ ok: true });

          const setOpenai = await routeRequest(
            req('POST', '/admin/orgs/{orgId}/api-key', { orgId: created.orgId }, {
              actorUserId: 'u_owner', providerType: 'openai', apiKey: 'sk-openai-secret-Ab34',
            }),
            deps(),
          );
          expect(setOpenai.statusCode).toBe(200);

          // Status lists BOTH configured providers (one row each), masked.
          const statusRes = await routeRequest(
            req('GET', '/admin/orgs/{orgId}/api-key/status', { orgId: created.orgId }, undefined, { actorUserId: 'u_owner' }),
            deps(),
          );
          expect(statusRes.statusCode).toBe(200);
          const status = JSON.parse(statusRes.body);
          expect(Array.isArray(status.providers)).toBe(true);
          expect(status.providers).toHaveLength(2);
          const byProvider: Record<string, any> = Object.fromEntries(
            status.providers.map((p: any) => [p.providerType, p]),
          );
          expect(byProvider.anthropic.maskedKey).toBe('…Xy12');
          expect(byProvider.anthropic.baseUrl).toBe('https://api.anthropic.com');
          expect(byProvider.anthropic.updatedByUserId).toBe('u_owner');
          expect(byProvider.openai.maskedKey).toBe('…Ab34');
          expect(JSON.stringify(status)).not.toContain('sk-ant-secret');
          expect(JSON.stringify(status)).not.toContain('sk-openai-secret');

          // Resolve for openai → the openai key.
          const resolveOpenai = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_owner' }, undefined, { providerType: 'openai' }),
            deps(),
          );
          expect(resolveOpenai.statusCode).toBe(200);
          expect(JSON.parse(resolveOpenai.body)).toEqual({
            found: true,
            orgId: created.orgId,
            apiKey: 'sk-openai-secret-Ab34',
            providerType: 'openai',
          });

          // Resolve for anthropic → the anthropic key (with baseUrl).
          const resolveAnthropic = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_owner' }, undefined, { providerType: 'anthropic' }),
            deps(),
          );
          expect(JSON.parse(resolveAnthropic.body)).toEqual({
            found: true,
            orgId: created.orgId,
            apiKey: 'sk-ant-secret-Xy12',
            providerType: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
          });

          // Resolve for a provider the org has no key for → not found.
          const resolveGemini = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_owner' }, undefined, { providerType: 'gemini' }),
            deps(),
          );
          expect(JSON.parse(resolveGemini.body)).toEqual({ found: false });

          // Clear only the openai key; anthropic remains.
          const clearRes = await routeRequest(
            req('DELETE', '/admin/orgs/{orgId}/api-key', { orgId: created.orgId }, { actorUserId: 'u_owner' }, { providerType: 'openai' }),
            deps(),
          );
          expect(clearRes.statusCode).toBe(200);

          const afterStatus = await routeRequest(
            req('GET', '/admin/orgs/{orgId}/api-key/status', { orgId: created.orgId }, undefined, { actorUserId: 'u_owner' }),
            deps(),
          );
          const after = JSON.parse(afterStatus.body);
          expect(after.providers).toHaveLength(1);
          expect(after.providers[0].providerType).toBe('anthropic');
        });

        it('DELETE / resolve require a providerType query param', async () => {
          const created = await org().createOrg({ displayName: 'PT Org', ownerUserId: 'u_owner' });
          const badDelete = await routeRequest(
            req('DELETE', '/admin/orgs/{orgId}/api-key', { orgId: created.orgId }, { actorUserId: 'u_owner' }),
            deps(),
          );
          expect(badDelete.statusCode).toBe(400);

          const badResolve = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_owner' }),
            deps(),
          );
          expect(badResolve.statusCode).toBe(400);
        });

        it('gates set/status to owner/admin (member → 403)', async () => {
          const created = await org().createOrg({ displayName: 'Gated Key Org', ownerUserId: 'u_owner' });
          await org().addMember(created.orgId, 'u_member', 'member', 'u_owner');
          await org().acceptInvite(created.orgId, 'u_member');

          const setRes = await routeRequest(
            req('POST', '/admin/orgs/{orgId}/api-key', { orgId: created.orgId }, { actorUserId: 'u_member', providerType: 'anthropic', apiKey: 'sk-ant-nope' }),
            deps(),
          );
          expect(setRes.statusCode).toBe(403);

          const statusRes = await routeRequest(
            req('GET', '/admin/orgs/{orgId}/api-key/status', { orgId: created.orgId }, undefined, { actorUserId: 'u_member' }),
            deps(),
          );
          expect(statusRes.statusCode).toBe(403);
        });

        it('multi-org resolve rule is PER PROVIDER: 0 → not found; 2 (same provider) → not found; exactly 1 → found', async () => {
          const orgA = await org().createOrg({ displayName: 'Resolve Org A', ownerUserId: 'u_multi' });
          const orgB = await org().createOrg({ displayName: 'Resolve Org B', ownerUserId: 'u_multi' });

          // 0 openai keys → not found.
          let res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_multi' }, undefined, { providerType: 'openai' }),
            deps(),
          );
          expect(JSON.parse(res.body)).toEqual({ found: false });

          // Both orgs hold an OPENAI key → ambiguous for openai → not found.
          await org().setOrgProviderKey(orgA.orgId, { providerType: 'openai', apiKeyCiphertext: 'cipher-a', updatedByUserId: 'u_multi' });
          await org().setOrgProviderKey(orgB.orgId, { providerType: 'openai', apiKeyCiphertext: 'cipher-b', updatedByUserId: 'u_multi' });
          res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_multi' }, undefined, { providerType: 'openai' }),
            deps(),
          );
          expect(JSON.parse(res.body)).toEqual({ found: false });

          // But resolving anthropic (which neither org has) → not found, independent of the openai ambiguity.
          res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_multi' }, undefined, { providerType: 'anthropic' }),
            deps(),
          );
          expect(JSON.parse(res.body)).toEqual({ found: false });

          // Exactly 1 org with an openai key → found (orgB, after clearing orgA's openai).
          await org().clearOrgProviderKey(orgA.orgId, 'openai');
          res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_multi' }, undefined, { providerType: 'openai' }),
            deps(),
          );
          const resolved = JSON.parse(res.body);
          expect(resolved.found).toBe(true);
          expect(resolved.orgId).toBe(orgB.orgId);
        });

        it('resolve is per-provider: 2 orgs with DIFFERENT providers each resolve their own', async () => {
          const orgA = await org().createOrg({ displayName: 'Diff Org A', ownerUserId: 'u_diff' });
          const orgB = await org().createOrg({ displayName: 'Diff Org B', ownerUserId: 'u_diff' });
          // orgA has an anthropic key; orgB has an openai key.
          await org().setOrgProviderKey(orgA.orgId, { providerType: 'anthropic', apiKeyCiphertext: 'cipher-anthropic', updatedByUserId: 'u_diff' });
          await org().setOrgProviderKey(orgB.orgId, { providerType: 'openai', apiKeyCiphertext: 'cipher-openai', updatedByUserId: 'u_diff' });

          // Resolving anthropic → exactly one org (orgA) has it → found.
          let res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_diff' }, undefined, { providerType: 'anthropic' }),
            deps(),
          );
          let r = JSON.parse(res.body);
          expect(r.found).toBe(true);
          expect(r.orgId).toBe(orgA.orgId);

          // Resolving openai → exactly one org (orgB) has it → found.
          res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_diff' }, undefined, { providerType: 'openai' }),
            deps(),
          );
          r = JSON.parse(res.body);
          expect(r.found).toBe(true);
          expect(r.orgId).toBe(orgB.orgId);
        });

        it('resolve only considers ACTIVE memberships', async () => {
          const created = await org().createOrg({ displayName: 'Invited Key Org', ownerUserId: 'u_owner' });
          await org().setOrgProviderKey(created.orgId, { providerType: 'anthropic', apiKeyCiphertext: 'cipher', updatedByUserId: 'u_owner' });
          // An invited (not yet active) member must not resolve the org's key.
          await org().addMember(created.orgId, 'u_invited', 'member', 'u_owner');

          const res = await routeRequest(
            req('GET', '/admin/users/{userId}/org-api-key/resolve', { userId: 'u_invited' }, undefined, { providerType: 'anthropic' }),
            deps(),
          );
          expect(JSON.parse(res.body)).toEqual({ found: false });
        });

        it('persists ciphertext verbatim per provider and round-trips via get/list', async () => {
          const created = await org().createOrg({ displayName: 'Cipher Org', ownerUserId: 'u_owner' });
          await org().setOrgProviderKey(created.orgId, {
            providerType: 'anthropic',
            apiKeyCiphertext: 'enc:v1:opaque-ciphertext',
            baseUrl: 'https://example.test',
            updatedByUserId: 'u_owner',
          });
          await org().setOrgProviderKey(created.orgId, {
            providerType: 'gemini',
            apiKeyCiphertext: 'enc:v1:gemini',
            updatedByUserId: 'u_owner',
          });

          const record = await org().getOrgProviderKey(created.orgId, 'anthropic');
          expect(record?.orgId).toBe(created.orgId);
          expect(record?.apiKeyCiphertext).toBe('enc:v1:opaque-ciphertext');
          expect(record?.baseUrl).toBe('https://example.test');
          expect(record?.providerType).toBe('anthropic');
          expect(record?.updatedByUserId).toBe('u_owner');
          expect(typeof record?.updatedAt).toBe('string');

          // listOrgProviderKeys returns every configured provider for the org.
          const list = await org().listOrgProviderKeys(created.orgId);
          expect(list.map((k) => k.providerType).sort()).toEqual(['anthropic', 'gemini']);

          // Upsert is keyed on (orgId, providerType): updating anthropic leaves gemini intact.
          await org().setOrgProviderKey(created.orgId, {
            providerType: 'anthropic',
            apiKeyCiphertext: 'enc:v1:second',
            updatedByUserId: 'u_owner',
          });
          const updated = await org().getOrgProviderKey(created.orgId, 'anthropic');
          expect(updated?.apiKeyCiphertext).toBe('enc:v1:second');
          expect(updated?.baseUrl).toBeUndefined();
          expect((await org().getOrgProviderKey(created.orgId, 'gemini'))?.apiKeyCiphertext).toBe('enc:v1:gemini');

          // Clearing one provider leaves the other.
          await org().clearOrgProviderKey(created.orgId, 'anthropic');
          expect(await org().getOrgProviderKey(created.orgId, 'anthropic')).toBeUndefined();
          expect(await org().getOrgProviderKey(created.orgId, 'gemini')).toBeDefined();
        });

        it('encryption round-trips when the secret is set (ciphertext != plaintext)', () => {
          const prev = process.env.MARKET_KEY_ENCRYPTION_SECRET;
          process.env.MARKET_KEY_ENCRYPTION_SECRET = 'a'.repeat(64); // 32-byte hex key
          try {
            const plain = 'sk-ant-roundtrip-9999';
            const ciphertext = encryptSecret(plain);
            expect(ciphertext).not.toBe(plain);
            expect(ciphertext.startsWith('enc:v1:')).toBe(true);
            expect(decryptSecret(ciphertext)).toBe(plain);
          } finally {
            if (prev === undefined) delete process.env.MARKET_KEY_ENCRYPTION_SECRET;
            else process.env.MARKET_KEY_ENCRYPTION_SECRET = prev;
          }
        });

        it('deleting the org removes ALL its per-provider key rows', async () => {
          const created = await org().createOrg({ displayName: 'Delete Key Org', ownerUserId: 'u_owner' });
          await org().setOrgProviderKey(created.orgId, { providerType: 'anthropic', apiKeyCiphertext: 'cipher', updatedByUserId: 'u_owner' });
          await org().setOrgProviderKey(created.orgId, { providerType: 'openai', apiKeyCiphertext: 'cipher2', updatedByUserId: 'u_owner' });
          await org().deleteOrg(created.orgId);
          expect(await org().listOrgProviderKeys(created.orgId)).toEqual([]);
        });
      });

      describe('org default run budget', () => {
        it('is absent by default; set → get → clear round-trips', async () => {
          const created = await org().createOrg({ displayName: 'Budget Org', ownerUserId: 'u_owner' });
          expect(await org().getOrgRunBudget(created.orgId)).toBeUndefined();

          await org().setOrgRunBudget(created.orgId, { budgetCents: 250, updatedByUserId: 'u_owner' });
          const record = await org().getOrgRunBudget(created.orgId);
          expect(record?.budgetCents).toBe(250);
          expect(record?.updatedByUserId).toBe('u_owner');

          // Upsert replaces the value.
          await org().setOrgRunBudget(created.orgId, { budgetCents: 999, updatedByUserId: 'u_admin' });
          expect((await org().getOrgRunBudget(created.orgId))?.budgetCents).toBe(999);

          await org().clearOrgRunBudget(created.orgId);
          expect(await org().getOrgRunBudget(created.orgId)).toBeUndefined();
        });

        it('deleting the org removes its run budget', async () => {
          const created = await org().createOrg({ displayName: 'Delete Budget Org', ownerUserId: 'u_owner' });
          await org().setOrgRunBudget(created.orgId, { budgetCents: 500, updatedByUserId: 'u_owner' });
          await org().deleteOrg(created.orgId);
          expect(await org().getOrgRunBudget(created.orgId)).toBeUndefined();
        });
      });
    });

    // NOTE: The Tier-2 paid/licensed-kit contract (set-pricing, grant/revoke
    // entitlements, watermarked licensed-package, paid-download 402 guard) lives
    // in @agentkit-commercial/market-core's contract suite, which composes the
    // commercial router into these same repos. The free build only verifies that
    // the public download path is NOT gated when no commercial router is injected.
    describe('public download guard (free path)', () => {
      async function publishKit(input: CreateSubmissionInput): Promise<string> {
        const queued = await uploadAndQueue(repos.admin, input);
        const kit = await repos.admin.publishSubmission(
          { ...queued, validationStatus: 'passed' },
          new Date().toISOString(),
        );
        return kit.kitId;
      }

      function req(method: string, resource: string, pathParameters: Record<string, string>, body?: unknown): CoreRequest {
        return {
          method,
          resource,
          pathParameters,
          queryStringParameters: null,
          headers: { 'x-agentkitmarket-admin-key': 'test-admin-key' },
          body: body === undefined ? null : JSON.stringify(body),
        };
      }

      function deps(extra?: Partial<RouterDeps>): RouterDeps {
        return {
          repository: repos.catalog,
          adminRepository: repos.admin,
          orgRepository: repos.org,
          adminKey: 'test-admin-key',
          ...extra,
        };
      }

      it('returns a download URL (200, not 402) when no commercial router is injected', async () => {
        const kitId = await publishKit(baseInput());
        const res = await routeRequest(
          req('POST', '/admin/kits/{kitId}/download-url', { kitId }),
          deps({ packageUploadService: stubPackageUploadService() }),
        );
        expect(res.statusCode).toBe(200);
      });
    });

    describe('favorites (cloud-synced kit references)', () => {
      function fav(): FavoritesRepository {
        if (!repos.favorites) {
          throw new Error('FavoritesRepository not provided by this backend');
        }
        return repos.favorites;
      }

      async function publishKit(input: CreateSubmissionInput): Promise<string> {
        const queued = await uploadAndQueue(repos.admin, input);
        const kit = await repos.admin.publishSubmission(
          { ...queued, validationStatus: 'passed' },
          new Date().toISOString(),
        );
        return kit.kitId;
      }

      function req(method: string, resource: string, pathParameters: Record<string, string>, body?: unknown): CoreRequest {
        return {
          method,
          resource,
          pathParameters,
          queryStringParameters: null,
          headers: { 'x-agentkitmarket-admin-key': 'test-admin-key' },
          body: body === undefined ? null : JSON.stringify(body),
        };
      }

      function deps(): RouterDeps {
        return {
          repository: repos.catalog,
          adminRepository: repos.admin,
          orgRepository: repos.org,
          favoritesRepository: repos.favorites,
          adminKey: 'test-admin-key',
        };
      }

      it('adds (by slug), lists, and removes a favorite', async () => {
        const kitId = await publishKit(baseInput());

        const addRes = await routeRequest(
          req('POST', '/admin/users/{userId}/favorites', { userId: 'u_fav' }, { slug: 'my-cool-kit' }),
          deps(),
        );
        expect(addRes.statusCode).toBe(201);
        const item = JSON.parse(addRes.body).item;
        expect(item.kitId).toBe(kitId);
        expect(item.slug).toBe('my-cool-kit');
        // Best-effort cached display metadata is resolved from the kit.
        expect(item.displayName).toBe('My Cool Kit');
        expect(item.publisherName).toBe('Ada Lovelace');

        const listRes = await routeRequest(
          req('GET', '/admin/users/{userId}/favorites', { userId: 'u_fav' }),
          deps(),
        );
        expect(listRes.statusCode).toBe(200);
        expect(JSON.parse(listRes.body).items).toHaveLength(1);

        const delRes = await routeRequest(
          req('DELETE', '/admin/users/{userId}/favorites/{kitId}', { userId: 'u_fav', kitId }),
          deps(),
        );
        expect(delRes.statusCode).toBe(200);
        expect(JSON.parse(delRes.body)).toEqual({ ok: true, kitId });

        const listAfter = await routeRequest(
          req('GET', '/admin/users/{userId}/favorites', { userId: 'u_fav' }),
          deps(),
        );
        expect(JSON.parse(listAfter.body).items).toHaveLength(0);
      });

      it('adds by kitId', async () => {
        const kitId = await publishKit(baseInput());
        const res = await routeRequest(
          req('POST', '/admin/users/{userId}/favorites', { userId: 'u_fav2' }, { kitId }),
          deps(),
        );
        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).item.kitId).toBe(kitId);
      });

      it('is idempotent on (userId, kitId) and preserves addedAt', async () => {
        const kitId = await publishKit(baseInput());
        const first = await fav().addFavorite('u_idem', { kitId, slug: 'my-cool-kit', displayName: 'My Cool Kit' });
        const second = await fav().addFavorite('u_idem', { kitId, slug: 'my-cool-kit', displayName: 'Renamed' });
        expect(second.addedAt).toBe(first.addedAt);
        expect(second.displayName).toBe('Renamed');
        const items = await fav().listFavorites('u_idem');
        expect(items).toHaveLength(1);
      });

      it('404 when the referenced kit does not exist', async () => {
        const res = await routeRequest(
          req('POST', '/admin/users/{userId}/favorites', { userId: 'u_fav3' }, { slug: 'no-such-kit' }),
          deps(),
        );
        expect(res.statusCode).toBe(404);
      });

      it('removeFavorite is idempotent (no error for an absent favorite)', async () => {
        const res = await routeRequest(
          req('DELETE', '/admin/users/{userId}/favorites/{kitId}', { userId: 'u_fav4', kitId: 'kit_nope' }),
          deps(),
        );
        expect(res.statusCode).toBe(200);
      });
    });

    describe('audit log (append-only)', () => {
      function audit(): AuditRepository {
        if (!repos.audit) {
          throw new Error('AuditRepository not provided by this backend');
        }
        return repos.audit;
      }

      const ts = (n: number) => `2026-06-1${n}T00:00:00.000Z`;

      it('records and lists events newest-first', async () => {
        await audit().record({ timestamp: ts(0), actorUserId: 'admin', actorType: 'admin', action: 'kit.hidden', targetType: 'kit', targetId: 'kit_1' });
        await audit().record({ timestamp: ts(1), actorUserId: 'admin', actorType: 'admin', action: 'kit.unhidden', targetType: 'kit', targetId: 'kit_1' });
        const page = await audit().list({});
        expect(page.items).toHaveLength(2);
        // Newest first.
        expect(page.items[0].action).toBe('kit.unhidden');
        expect(page.items[1].action).toBe('kit.hidden');
        // Repository stamps an auditId.
        expect(page.items[0].auditId).toMatch(/^aud_/);
      });

      it('filters by actor, by target, and by action', async () => {
        await audit().record({ timestamp: ts(0), actorUserId: 'u_a', actorType: 'user', action: 'submission.created', targetType: 'submission', targetId: 's_1' });
        await audit().record({ timestamp: ts(1), actorUserId: 'u_b', actorType: 'user', action: 'submission.approved', targetType: 'submission', targetId: 's_1' });
        await audit().record({ timestamp: ts(2), actorUserId: 'u_a', actorType: 'user', action: 'kit.published', targetType: 'kit', targetId: 'k_1' });

        const byActor = await audit().list({ actorUserId: 'u_a' });
        expect(byActor.items.map((e) => e.action).sort()).toEqual(['kit.published', 'submission.created']);

        const byTarget = await audit().list({ targetType: 'submission', targetId: 's_1' });
        expect(byTarget.items).toHaveLength(2);

        const byAction = await audit().list({ action: 'kit.published' });
        expect(byAction.items).toHaveLength(1);
        expect(byAction.items[0].targetId).toBe('k_1');
      });

      it('filters by time range', async () => {
        await audit().record({ timestamp: ts(0), actorUserId: 'admin', actorType: 'admin', action: 'kit.hidden', targetType: 'kit', targetId: 'k_t' });
        await audit().record({ timestamp: ts(2), actorUserId: 'admin', actorType: 'admin', action: 'kit.unhidden', targetType: 'kit', targetId: 'k_t' });
        await audit().record({ timestamp: ts(4), actorUserId: 'admin', actorType: 'admin', action: 'kit.removed', targetType: 'kit', targetId: 'k_t' });

        const mid = await audit().list({ since: ts(1), until: ts(3) });
        expect(mid.items).toHaveLength(1);
        expect(mid.items[0].action).toBe('kit.unhidden');
      });

      it('paginates with an opaque nextToken', async () => {
        for (let i = 0; i < 5; i++) {
          await audit().record({ timestamp: `2026-06-10T00:00:0${i}.000Z`, actorUserId: 'admin', actorType: 'admin', action: 'kit.hidden', targetType: 'kit', targetId: `k_${i}` });
        }
        const first = await audit().list({ limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextToken).toBeTruthy();
        const second = await audit().list({ limit: 2, nextToken: first.nextToken });
        expect(second.items).toHaveLength(2);
        // No overlap between pages.
        const ids = new Set([...first.items, ...second.items].map((e) => e.auditId));
        expect(ids.size).toBe(4);
      });

      it('preserves metadata, orgId, and actorEmail round-trip', async () => {
        await audit().record({
          timestamp: ts(0), actorUserId: 'admin', actorEmail: 'a@b.com', actorType: 'admin',
          action: 'kit.pricing_set', targetType: 'kit', targetId: 'k_meta', orgId: 'org_1',
          metadata: { priceCents: 500, pricing: 'paid' },
        });
        const page = await audit().list({ action: 'kit.pricing_set' });
        expect(page.items[0].orgId).toBe('org_1');
        expect(page.items[0].actorEmail).toBe('a@b.com');
        expect(page.items[0].metadata).toEqual({ priceCents: 500, pricing: 'paid' });
      });
    });

    describe('audit emission from handlers', () => {
      function req(method: string, resource: string, pathParameters: Record<string, string>, body?: unknown): CoreRequest {
        return {
          method, resource, pathParameters,
          queryStringParameters: null,
          headers: { 'x-agentkitmarket-admin-key': 'test-admin-key' },
          body: body === undefined ? null : JSON.stringify(body),
        };
      }

      async function publishedKitId(): Promise<string> {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued, validationStatus: 'passed' }, new Date().toISOString());
        return kit.kitId;
      }

      it('emits kit.hidden on a successful hide', async () => {
        const kitId = await publishedKitId();
        const res = await routeRequest(
          req('POST', '/admin/kits/{kitId}/hide', { kitId }),
          { repository: repos.catalog, adminRepository: repos.admin, auditRepository: repos.audit, adminKey: 'test-admin-key' },
        );
        expect(res.statusCode).toBe(200);
        const page = await repos.audit!.list({ targetType: 'kit', targetId: kitId });
        expect(page.items.some((e) => e.action === 'kit.hidden')).toBe(true);
      });

      it('a failing audit write does NOT fail the main operation', async () => {
        const kitId = await publishedKitId();
        const explodingAudit: AuditRepository = {
          async record() { throw new Error('audit backend down'); },
          async list() { return { items: [] }; },
        };
        const res = await routeRequest(
          req('POST', '/admin/kits/{kitId}/hide', { kitId }),
          { repository: repos.catalog, adminRepository: repos.admin, auditRepository: explodingAudit, adminKey: 'test-admin-key' },
        );
        // Main op still succeeds despite the audit write throwing.
        expect(res.statusCode).toBe(200);
      });
    });
  });
}

/** A stub PackageUploadService so the download-guard test does not hit a real store. */
function stubPackageUploadService() {
  return {
    async createUploadUrl(): Promise<string> { return 'https://example.test/upload'; },
    async createDownloadUrl(): Promise<string> { return 'https://example.test/download'; },
    async packageExists(): Promise<boolean> { return true; },
    async enqueueValidationJob(): Promise<void> {},
  };
}
