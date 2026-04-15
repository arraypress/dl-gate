# @arraypress/download-gate

Pure-function download access gate for digital-product stores. Single source of truth for the question *"can this request download this file right now?"* — combines per-(file, transaction) count limits, single-IP locking (or N-distinct-IPs cap), and soft reset semantics.

Storage-agnostic: you supply query + write closures; the library has no opinion on whether you're on D1, SQLite, libSQL, or Postgres. Zero runtime dependencies. ~150 LOC, fully testable without a DB.

---

## Why this exists

Download gating sounds simple ("count + IP check") but the edge cases pile up: per-file overrides vs store defaults, soft reset cutoffs, single-IP vs N-distinct-IPs (and what wins when both are on), 1:1 vs M:N file→product schemas, blocked customers vs missing transactions. Getting one of these wrong opens the door to URL sharing on Reddit hammering your bandwidth bill.

This package factors out the gate logic — the bit that's the same across every digital-product store — so you can drop it in instead of re-deriving it. Your queries are app-specific; the gate logic isn't.

## Install

```bash
npm install @arraypress/download-gate
```

## Quick start

```ts
import { createDownloadGate, REASON } from '@arraypress/download-gate';

const gate = createDownloadGate({
  queries: {
    getTransaction: async (id) => {
      const tx = await db.selectFrom('transactions').selectAll().where('id', '=', id).executeTakeFirst();
      return tx ? { customerId: tx.customer_id, resetCutoff: tx.download_reset_at } : null;
    },
    getCustomer: async (id) => {
      const c = await db.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
      return c ? { blocked: !!c.blocked, resetCutoff: c.download_reset_at } : null;
    },
    resolveGrantedFile: async (fileId, txId) => {
      // Adapt to your schema — supports both 1:1 (files.product_id) and M:N (file_products) layouts.
      const f = await db
        .selectFrom('files as f')
        .innerJoin('file_products as fp', 'fp.file_id', 'f.id')
        .innerJoin('transaction_items as ti', 'ti.product_id', 'fp.product_id')
        .select('f.download_limit')
        .distinct()
        .where('f.id', '=', fileId)
        .where('ti.transaction_id', '=', txId)
        .executeTakeFirst();
      return f ? { downloadLimit: f.download_limit } : null;
    },
    countDownloads: async (fileId, txId, since) => {
      let q = db.selectFrom('downloads').select(db.fn.countAll().as('n'))
        .where('file_id', '=', fileId).where('transaction_id', '=', txId);
      if (since) q = q.where('downloaded_at', '>', since);
      const r = await q.executeTakeFirst();
      return Number(r?.n) || 0;
    },
    getFirstDownloadIp: async (txId, since) => {
      let q = db.selectFrom('downloads').select('ip').where('transaction_id', '=', txId);
      if (since) q = q.where('downloaded_at', '>', since);
      const r = await q.orderBy('id', 'asc').limit(1).executeTakeFirst();
      return r?.ip ?? null;
    },
    getDistinctIps: async (txId, since) => {
      let q = db.selectFrom('downloads').select('ip')
        .where('transaction_id', '=', txId).where('ip', 'is not', null);
      if (since) q = q.where('downloaded_at', '>', since);
      const rows = await q.groupBy('ip').execute();
      return new Set(rows.map((r) => r.ip));
    },
  },
  loadConfig: async () => {
    const s = await getAllSettings(db);
    return {
      defaultLimit: parseInt(s.default_download_limit || '5', 10),
      singleIp: s.restrict_single_ip === '1',
      maxDistinctIps: parseInt(s.max_distinct_ips || '0', 10),
    };
  },
  writeDownloadLog: async (record) => {
    await db.insertInto('downloads').values({
      file_id: record.fileId,
      transaction_id: record.transactionId,
      customer_id: record.customerId,
      ip: record.ip,
      user_agent: record.userAgent,
      country: record.country,
    }).execute();
  },
});

// In your download route:
const result = await gate.check({ fileId, transactionId, ip });
if (!result.allowed) {
  const status = result.reason === REASON.LIMIT_REACHED ? 429 : 403;
  return c.json({ error: result.message }, status);
}
await gate.log({ fileId, transactionId, customerId, ip, userAgent, country });
// stream the file...
```

## Order of checks

First failure wins:

1. **Custom `preChecks`** — your app-specific gates (subscription frozen, etc.). Optional.
2. **Transaction exists** — `getTransaction(id)` returns null → `transaction_missing`.
3. **Customer is not blocked** — `customer.blocked === true` → `customer_blocked`.
4. **File granted** — `resolveGrantedFile(fileId, txId)` returns null → `file_mismatch`.
5. **Limit not reached** — `countDownloads(...)` ≥ effective limit → `limit_reached`. Effective limit is the per-file `downloadLimit` override OR the store `defaultLimit` (whichever is set; `0` means unlimited and skips the count check entirely).
6. **IP enforcement** — single-IP lock OR N-distinct-IPs cap. Single-IP wins when both are configured.

## Soft reset semantics

If your schema has a `download_reset_at` column on the transaction or customer (or both), return it from `getTransaction` / `getCustomer` and honour the `since` argument in `countDownloads` / `getFirstDownloadIp` / `getDistinctIps`.

Reset semantics: the gate uses `MAX(tx.resetCutoff, customer.resetCutoff)` and counts only downloads after that point. So an admin can "top up" an allowance without deleting download history (analytics + abuse detection still see the full record).

The `pickLater(a, b)` helper is exported if you need to apply the same comparison outside the gate.

## Custom pre-checks

For app-specific rules that don't fit the standard chain, pass `preChecks`:

```ts
const gate = createDownloadGate({
  queries: { ... },
  loadConfig: async () => { ... },
  preChecks: [
    async ({ fileId, transactionId, ip }) => {
      const inFreeze = await isStoreInFreeze(db);
      if (inFreeze) return { allowed: false, reason: 'store_frozen', message: 'Downloads paused.' };
      return null; // fall through to standard chain
    },
  ],
});
```

Each pre-check runs BEFORE the standard checks. Return `null` (or any non-`{allowed:false}` value) to fall through. Custom `reason` strings are fine — the GateResult union accepts them.

## Configuration reference

### `DownloadGateConfig`

| Field | Required | Description |
|---|---|---|
| `queries` | yes | The 6 closures the gate calls during `check()`. See `DownloadQueries`. |
| `loadConfig` | yes | `async () => DownloadConfig` — runs every check. Cache inside if hot. |
| `writeDownloadLog` | optional | Required only if you call `log()`. |
| `preChecks` | optional | Array of app-specific pre-check hooks. |

### `DownloadConfig`

| Field | Description |
|---|---|
| `defaultLimit` | Per-(file, transaction) cap. `0` = unlimited (skips the count check). |
| `singleIp` | Lock the transaction to the IP of the first successful download. |
| `maxDistinctIps` | Max distinct IPs per transaction. `0` = no cap. Ignored when `singleIp` is true. |

### `DownloadQueries`

| Method | Purpose |
|---|---|
| `getTransaction(txId)` | Returns `{ customerId, resetCutoff? }` or null. |
| `getCustomer(customerId)` | Returns `{ blocked, resetCutoff? }` or null. |
| `resolveGrantedFile(fileId, txId)` | Returns `{ downloadLimit }` or null (file not granted). The `downloadLimit` is the per-file override (`number`, `0` = unlimited) or `null` to inherit `defaultLimit`. |
| `countDownloads(fileId, txId, since)` | Number of downloads on (file, tx) since the optional cutoff. |
| `getFirstDownloadIp(txId, since)` | IP of the oldest download row, or null. Used by single-IP. |
| `getDistinctIps(txId, since)` | Set of distinct non-null IPs on the transaction. Used by max-distinct. |

### `GateResult`

```ts
type GateResult =
  | { allowed: true }
  | { allowed: false; reason: string; message: string };
```

Standard reason strings (also exported as `REASON`):

| Reason | Suggested HTTP status |
|---|---|
| `transaction_missing` | 404 |
| `customer_blocked` | 403 |
| `file_mismatch` | 403 |
| `limit_reached` | 429 |
| `ip_mismatch` | 403 |

## Patterns

### Read-only check

If you're rendering a preview UI ("you have 3 of 5 downloads remaining") and don't need to write logs, omit `writeDownloadLog`:

```ts
const gate = createDownloadGate({ queries, loadConfig });
const result = await gate.check({ fileId, transactionId, ip: null });
// gate.log() will throw — but you're not calling it.
```

### Combined check + log

The standard "issue a download" flow. Always check, only log when allowed:

```ts
async function handleDownload(c) {
  const result = await gate.check({ fileId, transactionId, ip });
  if (!result.allowed) {
    return c.json({ error: result.message, reason: result.reason }, statusFor(result.reason));
  }
  // gate.log() runs AFTER the byte stream starts so a failed download
  // doesn't count against the customer's limit; some apps prefer to log
  // BEFORE for stricter enforcement. Pick whichever fits your abuse model.
  await gate.log({ fileId, transactionId, customerId, ip, userAgent, country });
  return streamFile(file);
}
```

### Schema flexibility

The library doesn't care whether your file→product relation is 1:1 or M:N — it's all in your `resolveGrantedFile` closure:

```ts
// 1:1 schema (files.product_id):
resolveGrantedFile: async (fileId, txId) => {
  const f = await db
    .selectFrom('files as f')
    .innerJoin('transaction_items as ti', 'ti.product_id', 'f.product_id')
    .select('f.download_limit')
    .where('f.id', '=', fileId)
    .where('ti.transaction_id', '=', txId)
    .executeTakeFirst();
  return f ? { downloadLimit: f.download_limit } : null;
},

// M:N schema (file_products join table):
resolveGrantedFile: async (fileId, txId) => {
  const f = await db
    .selectFrom('files as f')
    .innerJoin('file_products as fp', 'fp.file_id', 'f.id')
    .innerJoin('transaction_items as ti', 'ti.product_id', 'fp.product_id')
    .select('f.download_limit')
    .distinct()
    .where('f.id', '=', fileId)
    .where('ti.transaction_id', '=', txId)
    .executeTakeFirst();
  return f ? { downloadLimit: f.download_limit } : null;
},
```

## Security notes

- **Always run `check()` BEFORE serving file bytes.** A signed URL alone doesn't enforce the limit / IP / reset checks — those live here.
- **Log AFTER the gate allows.** Logging on failure pollutes the count + first-IP record and can lock customers out of legitimate retries.
- **The single-IP and max-distinct gates only fire when `params.ip` is non-null.** If your edge runtime can't resolve the client IP (no `cf-connecting-ip`, no proxy header trust), the IP checks silently pass — be explicit about which trust headers you accept upstream.
- **Reset cutoffs apply to the count, single-IP record, AND distinct-IPs set.** A reset effectively starts a fresh allowance window — old downloads remain in the log for analytics but don't count against the limit anymore.

## License

MIT
