/**
 * Private-kits A1 tests.
 *
 *  - Download guard: a PUBLIC kit is downloadable by a non-owner; a PUBLISHED
 *    PRIVATE kit is 403 for a non-owner and 200 for the owning org's member.
 *  - Per-org private-kit cap: with USER_PRIVATE_KIT_LIMIT=2 the 3rd set-private
 *    is 409; with the limit unset (null / unlimited) it is allowed.
 */
import { describe, it, expect } from 'vitest';
import { routeRequest } from '../src/core/routes/index.js';
import type { CoreRequest, RouterDeps } from '../src/core/routes/types.js';
import type {
  AdminRepository,
  CatalogRepository,
  OrgLookupClient,
  OrgRepository,
  PackageUploadService,
} from '../src/core/ports.js';
import type {
  KitRecord,
  KitVersionRecord,
  KitVisibility,
  OrgMembership,
} from '../src/core/types.js';

const now = () => new Date().toISOString();

function publishedKit(overrides: Partial<KitRecord> = {}): KitRecord {
  return {
    kitId: 'kit_1',
    slug: 'acme-kit',
    publisherId: 'Acme',
    name: 'Acme Kit',
    summary: 'An Acme Kit',
    currentVersion: 1,
    ownerOrgId: 'org_1',
    visibility: 'public',
    status: 'published',
    validationStatus: 'passed',
    reviewStatus: 'approved',
    publishedAt: now(),
    updatedAt: now(),
    ...overrides,
  } as KitRecord;
}

const version: KitVersionRecord = {
  kitId: 'kit_1',
  version: '1',
  packageS3Key: 'kits/kit_1/v1.agentkit.zip',
  packageFileName: 'acme-kit-v1.agentkit.zip',
};

function downloadDeps(kit: KitRecord, member: OrgMembership | undefined): RouterDeps {
  const adminRepository: Partial<AdminRepository> = {
    getKitBySlug: async () => kit,
    getKit: async () => kit,
    getKitVersion: async () => version,
    incrementKitDownloads: async () => {},
  };
  const orgLookupClient: Partial<OrgLookupClient> = {
    getMembership: async () => member,
  };
  const packageUploadService: Partial<PackageUploadService> = {
    createDownloadUrl: async () => 'https://example.com/download',
  };
  return {
    repository: {} as CatalogRepository,
    adminRepository: adminRepository as AdminRepository,
    orgLookupClient: orgLookupClient as OrgLookupClient,
    packageUploadService: packageUploadService as PackageUploadService,
    adminKey: 'test-key',
  };
}

function downloadRequest(actorUserId?: string): CoreRequest {
  return {
    method: 'POST',
    resource: '/admin/kits/by-slug/{slug}/download-url',
    pathParameters: { slug: 'acme-kit' },
    queryStringParameters: {},
    headers: { 'x-agentkitmarket-admin-key': 'test-key' },
    body: actorUserId ? JSON.stringify({ actorUserId }) : JSON.stringify({}),
    sourceIp: '127.0.0.1',
  };
}

const activeMember: OrgMembership = {
  orgId: 'org_1',
  userId: 'u_owner',
  role: 'owner',
  status: 'active',
  createdAt: now(),
};

describe('private-kit download guard', () => {
  it('allows a non-owner to download a PUBLIC kit', async () => {
    const deps = downloadDeps(publishedKit({ visibility: 'public' }), undefined);
    const response = await routeRequest(downloadRequest('u_stranger'), deps);
    expect(response.statusCode).toBe(200);
  });

  it('rejects a non-owner from downloading a PRIVATE kit (403)', async () => {
    // orgLookup returns no membership for the stranger.
    const deps = downloadDeps(publishedKit({ visibility: 'private' }), undefined);
    const response = await routeRequest(downloadRequest('u_stranger'), deps);
    expect(response.statusCode).toBe(403);
  });

  it('allows the owning org member to download a PRIVATE kit (200)', async () => {
    const deps = downloadDeps(publishedKit({ visibility: 'private' }), activeMember);
    const response = await routeRequest(downloadRequest('u_owner'), deps);
    expect(response.statusCode).toBe(200);
  });
});

// --- Per-org private-kit cap ------------------------------------------------

function visibilityDeps(
  kit: KitRecord,
  member: OrgMembership,
  privateCount: number,
  userPrivateKitLimit: number | null,
  /**
   * The org-configured cap from Profile (getOrgPrivateKitCap). number = configured
   * cap; null = org explicitly unlimited; undefined = Profile unresolvable (fail-
   * open → fall to the env default). Defaults to undefined (A1 behaviour).
   */
  orgCap: number | null | undefined = undefined,
): RouterDeps {
  const adminRepository: Partial<AdminRepository> = {
    getKit: async () => kit,
  };
  const orgRepository: Partial<OrgRepository> = {
    countPrivateKitsForOrg: async () => privateCount,
    setKitVisibility: async (_kitId: string, visibility: KitVisibility) =>
      ({ ...kit, visibility }) as KitRecord,
  };
  const orgLookupClient: Partial<OrgLookupClient> = {
    getMembership: async () => member,
    getOrgPrivateKitCap: async () => orgCap,
  };
  return {
    repository: {} as CatalogRepository,
    adminRepository: adminRepository as AdminRepository,
    orgRepository: orgRepository as OrgRepository,
    orgLookupClient: orgLookupClient as OrgLookupClient,
    adminKey: 'test-key',
    userPrivateKitLimit,
  };
}

function setPrivateRequest(): CoreRequest {
  return {
    method: 'POST',
    resource: '/admin/kits/{kitId}/visibility',
    pathParameters: { kitId: 'kit_1' },
    queryStringParameters: {},
    headers: { 'x-agentkitmarket-admin-key': 'test-key' },
    body: JSON.stringify({ actorUserId: 'u_owner', visibility: 'private' }),
    sourceIp: '127.0.0.1',
  };
}

describe('per-org private-kit cap', () => {
  it('rejects the 3rd set-private with 409 when the cap is 2', async () => {
    // Kit is currently public; org already holds 2 private kits; cap is 2.
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 2, 2);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { currentCount: number; limit: number };
    expect(body.currentCount).toBe(2);
    expect(body.limit).toBe(2);
  });

  it('allows set-private when the cap is unset (unlimited)', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 999, null);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(200);
  });

  it('allows set-private under the cap', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 1, 2);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(200);
  });
});

// --- Precedence: org-configured cap → env default → unlimited (private-kits A2) ---

describe('per-org private-kit cap precedence', () => {
  it('org cap OVERRIDES a laxer env default (org=1, env=10, count=1 → 409)', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 1, 10, 1);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { limit: number };
    expect(body.limit).toBe(1); // the org cap, not the env default
  });

  it('org cap OVERRIDES a stricter env default (org=5, env=1, count=2 → 200)', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 2, 1, 5);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(200);
  });

  it('org cap null (explicit unlimited) overrides a strict env default (env=1, count=99 → 200)', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 99, 1, null);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(200);
  });

  it('FAIL-OPEN: org cap undefined (Profile down) falls back to the env default (env=2, count=2 → 409)', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 2, 2, undefined);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { limit: number };
    expect(body.limit).toBe(2); // env default applies when Profile is unresolvable
  });

  it('org cap undefined + env unlimited → allowed (count high, both unlimited)', async () => {
    const deps = visibilityDeps(publishedKit({ visibility: 'public' }), activeMember, 999, null, undefined);
    const response = await routeRequest(setPrivateRequest(), deps);
    expect(response.statusCode).toBe(200);
  });
});
