/**
 * @arraypress/download-gate
 *
 * Pure-function download access gate for digital-product stores. Single
 * source of truth for the question *"can this request download this
 * file right now?"* — combines per-(file, transaction) count limits,
 * single-IP locking (or N-distinct-IPs cap), and soft reset semantics.
 *
 * Storage-agnostic: you supply query + write closures; the library has
 * no opinion on whether you're on D1, SQLite, libSQL, or Postgres.
 *
 * **Order of checks** (first failure wins):
 *
 *   1. App-specific `preChecks` (optional — one-shot custom rules)
 *   2. Transaction exists
 *   3. Customer is not blocked
 *   4. File is granted by the transaction (your `resolveGrantedFile`
 *      closure decides — supports 1:1 or M:N file→product schemas)
 *   5. Download count under the effective limit (per-file override or
 *      store default; soft reset cutoff applies if your queries
 *      honour it)
 *   6. IP enforcement — single-IP lock OR N-distinct-IPs cap, whichever
 *      is configured. Single-IP wins when both are set.
 *
 * Returns a discriminated `GateResult`. The caller decides HTTP status
 * (typically 429 for `limit_reached`, 403 for the rest).
 *
 * @module @arraypress/download-gate
 */

const REASONS = {
  TRANSACTION_MISSING: 'transaction_missing',
  CUSTOMER_BLOCKED: 'customer_blocked',
  FILE_MISMATCH: 'file_mismatch',
  LIMIT_REACHED: 'limit_reached',
  IP_MISMATCH: 'ip_mismatch',
};

/**
 * Build a configured download-gate instance.
 *
 * @template TxRow, CustomerRow
 * @param {import('./index.d.ts').DownloadGateConfig} config
 * @returns {{ check: Function, log: Function }}
 *
 * @example
 * ```ts
 * import { createDownloadGate } from '@arraypress/download-gate';
 *
 * const gate = createDownloadGate({
 *   queries: {
 *     getTransaction: async (id) => {
 *       const tx = await db.selectFrom('transactions').selectAll().where('id', '=', id).executeTakeFirst();
 *       return tx ? { customerId: tx.customer_id, resetCutoff: tx.download_reset_at } : null;
 *     },
 *     getCustomer: async (id) => {
 *       const c = await db.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
 *       return c ? { blocked: !!c.blocked, resetCutoff: c.download_reset_at } : null;
 *     },
 *     resolveGrantedFile: async (fileId, txId) => {
 *       const f = await db.selectFrom('files as f')
 *         .innerJoin('file_products as fp', 'fp.file_id', 'f.id')
 *         .innerJoin('transaction_items as ti', 'ti.product_id', 'fp.product_id')
 *         .select('f.download_limit')
 *         .distinct()
 *         .where('f.id', '=', fileId)
 *         .where('ti.transaction_id', '=', txId)
 *         .executeTakeFirst();
 *       return f ? { downloadLimit: f.download_limit } : null;
 *     },
 *     countDownloads: async (fileId, txId, since) => {
 *       let q = db.selectFrom('downloads').select(db.fn.countAll().as('n'))
 *         .where('file_id', '=', fileId).where('transaction_id', '=', txId);
 *       if (since) q = q.where('downloaded_at', '>', since);
 *       return Number((await q.executeTakeFirst())?.n) || 0;
 *     },
 *     getFirstDownloadIp: async (txId, since) => {
 *       let q = db.selectFrom('downloads').select('ip').where('transaction_id', '=', txId);
 *       if (since) q = q.where('downloaded_at', '>', since);
 *       return (await q.orderBy('id', 'asc').limit(1).executeTakeFirst())?.ip ?? null;
 *     },
 *     getDistinctIps: async (txId, since) => {
 *       let q = db.selectFrom('downloads').select('ip').where('transaction_id', '=', txId).where('ip', 'is not', null);
 *       if (since) q = q.where('downloaded_at', '>', since);
 *       const rows = await q.groupBy('ip').execute();
 *       return new Set(rows.map((r) => r.ip));
 *     },
 *   },
 *   loadConfig: async () => {
 *     const s = await getAllSettings(db);
 *     return {
 *       defaultLimit: parseInt(s.default_download_limit || '5', 10),
 *       singleIp: s.restrict_single_ip === '1',
 *       maxDistinctIps: parseInt(s.max_distinct_ips || '0', 10),
 *     };
 *   },
 *   writeDownloadLog: async (record) => {
 *     await db.insertInto('downloads').values({
 *       file_id: record.fileId,
 *       transaction_id: record.transactionId,
 *       customer_id: record.customerId,
 *       ip: record.ip,
 *       user_agent: record.userAgent,
 *       country: record.country,
 *     }).execute();
 *   },
 * });
 *
 * const result = await gate.check({ fileId, transactionId, ip });
 * if (!result.allowed) return c.json({ error: result.message }, 403);
 * await gate.log({ fileId, transactionId, customerId, ip, userAgent, country });
 * ```
 */
export function createDownloadGate(config) {
  if (!config?.queries) throw new Error('createDownloadGate: config.queries is required');
  if (!config?.loadConfig) throw new Error('createDownloadGate: config.loadConfig is required');

  const { queries, loadConfig, writeDownloadLog, preChecks = [] } = config;

  return {
    /**
     * Run the gate. Does NOT log a download row — call `log()` after
     * the allowed branch so failed attempts aren't counted toward the
     * limit and don't become the "first IP".
     *
     * @param {{ fileId: number, transactionId: number, ip: string | null }} params
     * @returns {Promise<import('./index.d.ts').GateResult>}
     */
    async check(params) {
      // App-specific custom checks first — anything that returns a
      // non-null GateResult short-circuits.
      for (const preCheck of preChecks) {
        const r = await preCheck(params);
        if (r && r.allowed === false) return r;
      }

      const tx = await queries.getTransaction(params.transactionId);
      if (!tx) return { allowed: false, reason: REASONS.TRANSACTION_MISSING, message: 'Transaction not found' };

      const customer = await queries.getCustomer(tx.customerId);
      if (!customer) {
        return { allowed: false, reason: REASONS.TRANSACTION_MISSING, message: 'Customer not found' };
      }
      if (customer.blocked) {
        return { allowed: false, reason: REASONS.CUSTOMER_BLOCKED, message: 'This account has been disabled.' };
      }

      // Effective reset cutoff = MAX(tx.resetCutoff, customer.resetCutoff).
      // The most-recent of the two timestamps wins; the gate counts
      // only downloads newer than this point so admins can top up an
      // allowance without deleting history.
      const resetCutoff = pickLater(tx.resetCutoff, customer.resetCutoff);

      const file = await queries.resolveGrantedFile(params.fileId, params.transactionId);
      if (!file) {
        return { allowed: false, reason: REASONS.FILE_MISMATCH, message: 'File not available for this transaction.' };
      }

      const settings = await loadConfig();
      const effectiveLimit = file.downloadLimit ?? settings.defaultLimit;

      if (effectiveLimit > 0) {
        const count = await queries.countDownloads(params.fileId, params.transactionId, resetCutoff);
        if (count >= effectiveLimit) {
          return {
            allowed: false,
            reason: REASONS.LIMIT_REACHED,
            message: `Download limit reached (${effectiveLimit} per file).`,
          };
        }
      }

      if (settings.singleIp && params.ip) {
        // First-IP wins. The earliest download row's IP locks the
        // transaction. Reset cutoff also clears the lock.
        const firstIp = await queries.getFirstDownloadIp(params.transactionId, resetCutoff);
        if (firstIp && firstIp !== params.ip) {
          return {
            allowed: false,
            reason: REASONS.IP_MISMATCH,
            message: 'This download link is locked to a different IP.',
          };
        }
      } else if (settings.maxDistinctIps > 0 && params.ip) {
        const seen = await queries.getDistinctIps(params.transactionId, resetCutoff);
        const wouldFit = seen.has(params.ip) || seen.size < settings.maxDistinctIps;
        if (!wouldFit) {
          return {
            allowed: false,
            reason: REASONS.IP_MISMATCH,
            message: `This transaction has reached the limit of ${settings.maxDistinctIps} distinct IP${settings.maxDistinctIps === 1 ? '' : 's'}.`,
          };
        }
      }

      return { allowed: true };
    },

    /**
     * Append a download log entry. Call this AFTER `check()` returns
     * `{ allowed: true }` — it's what makes the counter move and what
     * the single-IP check reads on subsequent attempts.
     *
     * Throws if `writeDownloadLog` wasn't supplied at factory time (the
     * gate can be constructed with only `queries` + `loadConfig` for
     * read-only use cases).
     *
     * @param {import('./index.d.ts').DownloadLogRecord} record
     * @returns {Promise<void>}
     */
    async log(record) {
      if (!writeDownloadLog) {
        throw new Error('createDownloadGate: writeDownloadLog was not provided — cannot log');
      }
      await writeDownloadLog(record);
    },
  };
}

/**
 * Pick the more-recent of two ISO timestamps. Used internally for the
 * reset-cutoff calculation; exported so consumers can reuse the same
 * comparison semantics.
 */
export function pickLater(a, b) {
  if (a && b) return a > b ? a : b;
  return a || b || null;
}

/**
 * Convenience: standard reasons table, exported so callers can refer to
 * them by name in switch statements / error mapping.
 */
export const REASON = REASONS;
