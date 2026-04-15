/**
 * @arraypress/download-gate — test suite.
 *
 * The gate is pure logic — every dependency goes through a closure, so
 * tests use simple stub queries / config loaders rather than a real DB.
 * That means we can exhaustively cover every branch without booting
 * Workers / SQLite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadGate, pickLater, REASON } from '../src/index.js';

// ── Test fixtures ──────────────────────────────────

/**
 * Build a gate with sensible defaults; per-test overrides merge over.
 * `queryLog` captures every query call so tests can assert order /
 * arguments without re-implementing assertions inline.
 */
function buildGate(overrides = {}) {
  const queryLog = [];
  const queries = {
    getTransaction: async (id) => {
      queryLog.push(['getTransaction', id]);
      return { customerId: 100, resetCutoff: null };
    },
    getCustomer: async (id) => {
      queryLog.push(['getCustomer', id]);
      return { blocked: false, resetCutoff: null };
    },
    resolveGrantedFile: async (fileId, txId) => {
      queryLog.push(['resolveGrantedFile', fileId, txId]);
      return { downloadLimit: null };
    },
    countDownloads: async (fileId, txId, since) => {
      queryLog.push(['countDownloads', fileId, txId, since]);
      return 0;
    },
    getFirstDownloadIp: async (txId, since) => {
      queryLog.push(['getFirstDownloadIp', txId, since]);
      return null;
    },
    getDistinctIps: async (txId, since) => {
      queryLog.push(['getDistinctIps', txId, since]);
      return new Set();
    },
    ...(overrides.queries || {}),
  };

  const loadConfig = overrides.loadConfig ?? (async () => ({
    defaultLimit: 5,
    singleIp: false,
    maxDistinctIps: 0,
  }));

  const gate = createDownloadGate({
    queries,
    loadConfig,
    writeDownloadLog: overrides.writeDownloadLog,
    preChecks: overrides.preChecks,
  });
  return { gate, queryLog };
}

// ── Validation ─────────────────────────────────────

describe('createDownloadGate validation', () => {
  it('throws when queries is missing', () => {
    assert.throws(() => createDownloadGate({ loadConfig: async () => ({}) }), /queries/);
  });

  it('throws when loadConfig is missing', () => {
    assert.throws(() => createDownloadGate({ queries: {} }), /loadConfig/);
  });
});

// ── Happy path ─────────────────────────────────────

describe('check() happy path', () => {
  it('returns allowed:true when everything passes', async () => {
    const { gate } = buildGate();
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.deepEqual(result, { allowed: true });
  });
});

// ── Transaction missing ────────────────────────────

describe('check() transaction_missing', () => {
  it('returns transaction_missing when getTransaction returns null', async () => {
    const { gate } = buildGate({ queries: { getTransaction: async () => null } });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.TRANSACTION_MISSING);
  });

  it('returns transaction_missing when customer is missing', async () => {
    const { gate } = buildGate({ queries: { getCustomer: async () => null } });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.TRANSACTION_MISSING);
  });
});

// ── Customer blocked ───────────────────────────────

describe('check() customer_blocked', () => {
  it('returns customer_blocked when customer.blocked === true', async () => {
    const { gate } = buildGate({
      queries: { getCustomer: async () => ({ blocked: true, resetCutoff: null }) },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.CUSTOMER_BLOCKED);
  });
});

// ── File mismatch ──────────────────────────────────

describe('check() file_mismatch', () => {
  it('returns file_mismatch when resolveGrantedFile returns null', async () => {
    const { gate } = buildGate({
      queries: { resolveGrantedFile: async () => null },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.FILE_MISMATCH);
  });
});

// ── Limit reached ──────────────────────────────────

describe('check() limit_reached', () => {
  it('returns limit_reached when count >= effective limit', async () => {
    const { gate } = buildGate({
      queries: { countDownloads: async () => 5 },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.LIMIT_REACHED);
    assert.match(result.message, /5/);
  });

  it('per-file downloadLimit override wins over store default', async () => {
    const { gate } = buildGate({
      queries: {
        resolveGrantedFile: async () => ({ downloadLimit: 2 }), // override → 2
        countDownloads: async () => 2, // exactly at the per-file cap
      },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.LIMIT_REACHED);
    assert.match(result.message, /2/);
  });

  it('downloadLimit of 0 means unlimited (skips count check)', async () => {
    const { gate, queryLog } = buildGate({
      queries: {
        resolveGrantedFile: async () => ({ downloadLimit: 0 }),
        countDownloads: async () => 99999,
      },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, true);
    // countDownloads should not have been called when limit is 0.
    assert.equal(queryLog.find((c) => c[0] === 'countDownloads'), undefined);
  });

  it('honours the resetCutoff timestamp for the count query', async () => {
    let countSinceArg;
    const { gate } = buildGate({
      queries: {
        getTransaction: async () => ({ customerId: 100, resetCutoff: '2026-04-15T00:00:00Z' }),
        countDownloads: async (fileId, txId, since) => { countSinceArg = since; return 0; },
      },
    });
    await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(countSinceArg, '2026-04-15T00:00:00Z');
  });

  it('uses the LATER reset cutoff when both tx + customer have one', async () => {
    let countSinceArg;
    const { gate } = buildGate({
      queries: {
        getTransaction: async () => ({ customerId: 100, resetCutoff: '2026-04-10T00:00:00Z' }),
        getCustomer: async () => ({ blocked: false, resetCutoff: '2026-04-20T00:00:00Z' }),
        countDownloads: async (_f, _t, since) => { countSinceArg = since; return 0; },
      },
    });
    await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(countSinceArg, '2026-04-20T00:00:00Z');
  });
});

// ── Single-IP enforcement ──────────────────────────

describe('check() single-IP', () => {
  it('locks subsequent downloads to the IP of the first download', async () => {
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: true, maxDistinctIps: 0 }),
      queries: { getFirstDownloadIp: async () => '10.0.0.1' },
    });

    const allowed = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.1' });
    assert.equal(allowed.allowed, true);

    const blocked = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.2' });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, REASON.IP_MISMATCH);
  });

  it('skips IP check when no first IP recorded yet', async () => {
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: true, maxDistinctIps: 0 }),
      queries: { getFirstDownloadIp: async () => null },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.99' });
    assert.equal(result.allowed, true);
  });

  it('skips IP check when params.ip is null (no resolvable origin)', async () => {
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: true, maxDistinctIps: 0 }),
      queries: { getFirstDownloadIp: async () => '10.0.0.1' },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: null });
    assert.equal(result.allowed, true);
  });
});

// ── Max-distinct-IPs ───────────────────────────────

describe('check() max-distinct-IPs', () => {
  it('allows when current IP is already in the set', async () => {
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: false, maxDistinctIps: 2 }),
      queries: { getDistinctIps: async () => new Set(['10.0.0.1', '10.0.0.2']) },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.1' });
    assert.equal(result.allowed, true);
  });

  it('allows when there is room in the cap', async () => {
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: false, maxDistinctIps: 3 }),
      queries: { getDistinctIps: async () => new Set(['10.0.0.1', '10.0.0.2']) },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.99' });
    assert.equal(result.allowed, true);
  });

  it('blocks when adding a new IP would exceed the cap', async () => {
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: false, maxDistinctIps: 2 }),
      queries: { getDistinctIps: async () => new Set(['10.0.0.1', '10.0.0.2']) },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.99' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.IP_MISMATCH);
    assert.match(result.message, /2/);
  });

  it('singleIp wins over maxDistinctIps when both are configured', async () => {
    let firstIpCalled = false;
    let distinctIpsCalled = false;
    const { gate } = buildGate({
      loadConfig: async () => ({ defaultLimit: 0, singleIp: true, maxDistinctIps: 5 }),
      queries: {
        getFirstDownloadIp: async () => { firstIpCalled = true; return '10.0.0.1'; },
        getDistinctIps: async () => { distinctIpsCalled = true; return new Set(); },
      },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '10.0.0.2' });
    // singleIp branch took the call; max-distinct shouldn't have been queried.
    assert.equal(firstIpCalled, true);
    assert.equal(distinctIpsCalled, false);
    // And it correctly rejected for IP mismatch (proves the singleIp gate is what blocked, not max-distinct).
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASON.IP_MISMATCH);
  });
});

// ── preChecks ──────────────────────────────────────

describe('check() preChecks', () => {
  it('runs preChecks before the standard chain and short-circuits on failure', async () => {
    let standardChainHit = false;
    const { gate } = buildGate({
      preChecks: [
        async () => ({ allowed: false, reason: 'custom_reason', message: 'app-specific block' }),
      ],
      queries: {
        getTransaction: async () => { standardChainHit = true; return { customerId: 100, resetCutoff: null }; },
      },
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'custom_reason');
    assert.equal(standardChainHit, false);
  });

  it('preChecks returning null fall through to the standard chain', async () => {
    const { gate } = buildGate({
      preChecks: [async () => null],
    });
    const result = await gate.check({ fileId: 1, transactionId: 2, ip: '1.1.1.1' });
    assert.equal(result.allowed, true);
  });
});

// ── log() ──────────────────────────────────────────

describe('log()', () => {
  it('writes to the provided writer', async () => {
    const writes = [];
    const { gate } = buildGate({
      writeDownloadLog: async (r) => writes.push(r),
    });
    await gate.log({
      fileId: 1, transactionId: 2, customerId: 100,
      ip: '1.1.1.1', userAgent: 'curl', country: 'US',
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].fileId, 1);
  });

  it('throws when writeDownloadLog wasn\'t supplied', async () => {
    const { gate } = buildGate(); // no writeDownloadLog
    await assert.rejects(
      gate.log({ fileId: 1, transactionId: 2, customerId: 100, ip: null }),
      /writeDownloadLog/,
    );
  });
});

// ── pickLater ──────────────────────────────────────

describe('pickLater', () => {
  it('picks the more-recent of two ISO strings', () => {
    assert.equal(pickLater('2026-04-10', '2026-04-20'), '2026-04-20');
    assert.equal(pickLater('2026-04-20', '2026-04-10'), '2026-04-20');
  });

  it('returns the non-null when one is missing', () => {
    assert.equal(pickLater('2026-04-15', null), '2026-04-15');
    assert.equal(pickLater(null, '2026-04-15'), '2026-04-15');
    assert.equal(pickLater(undefined, '2026-04-15'), '2026-04-15');
  });

  it('returns null when both are missing', () => {
    assert.equal(pickLater(null, null), null);
    assert.equal(pickLater(undefined, undefined), null);
  });
});
