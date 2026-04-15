// ── Result + reasons ──────────────────────────────

/**
 * Discriminated result from a gate check.
 *
 * `allowed: true` is a pass with no reason / message; the `false`
 * branch carries a stable `reason` enum + a human-readable `message`
 * the consumer can surface to the user.
 */
export type GateResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'transaction_missing'
        | 'customer_blocked'
        | 'file_mismatch'
        | 'limit_reached'
        | 'ip_mismatch'
        | (string & {}); // allow consumer-defined reasons from preChecks
      message: string;
    };

/** Standard reason strings the library emits. Use for `switch` / mapping. */
export declare const REASON: {
  TRANSACTION_MISSING: 'transaction_missing';
  CUSTOMER_BLOCKED: 'customer_blocked';
  FILE_MISMATCH: 'file_mismatch';
  LIMIT_REACHED: 'limit_reached';
  IP_MISMATCH: 'ip_mismatch';
};

// ── Gate inputs ──────────────────────────────────

/**
 * Parameters for {@link DownloadGate.check}.
 */
export interface CheckParams {
  /** Primary key of the file the customer is trying to download. */
  fileId: number;
  /** Primary key of the transaction that should grant access. */
  transactionId: number;
  /** Request IP — used for single-IP and N-distinct-IPs enforcement. `null` skips IP checks. */
  ip: string | null;
}

/**
 * Record passed to {@link DownloadGate.log}.
 */
export interface DownloadLogRecord {
  fileId: number;
  transactionId: number;
  customerId: number;
  ip: string | null;
  userAgent?: string | null;
  country?: string | null;
}

// ── Query closures ───────────────────────────────

/**
 * Query closures the gate calls during `check()`. Each receives whatever
 * arguments are needed; the library is agnostic about your DB layer.
 *
 * **Reset semantics:** if your schema supports soft-reset (a
 * `download_reset_at` timestamp on transaction or customer that "resets
 * the count"), return it from `getTransaction` / `getCustomer` and
 * honour the `since` argument in `countDownloads` / `getFirstDownloadIp` /
 * `getDistinctIps`. Otherwise return `undefined` / `null` and the
 * library will pass `null` for `since` everywhere.
 */
export interface DownloadQueries {
  /**
   * Look up the transaction. Return `null` if not found.
   * `resetCutoff` is the optional ISO timestamp from the transaction's
   * soft-reset column.
   */
  getTransaction(transactionId: number): Promise<{
    customerId: number;
    resetCutoff?: string | null;
  } | null>;

  /**
   * Look up the customer. Return `null` if not found.
   * `blocked` is the kill-switch flag; `resetCutoff` is the optional
   * ISO timestamp from the customer-level soft-reset column.
   */
  getCustomer(customerId: number): Promise<{
    blocked: boolean;
    resetCutoff?: string | null;
  } | null>;

  /**
   * Check whether the file is granted by this transaction. Return:
   *   - `null` when the file is NOT granted (gate fails with `file_mismatch`).
   *   - `{ downloadLimit }` where `downloadLimit` is the per-file override
   *     (`number`, `0` = unlimited) or `null` to inherit the store default.
   *
   * Your implementation is the file→product join — supports both 1:1
   * (`files.product_id`) and M:N (`file_products` join table) schemas.
   */
  resolveGrantedFile(
    fileId: number,
    transactionId: number,
  ): Promise<{ downloadLimit: number | null } | null>;

  /**
   * Count downloads on `(file, transaction)` since `since` (or all-time
   * if `since` is `null`). Used for the limit check.
   */
  countDownloads(
    fileId: number,
    transactionId: number,
    since: string | null,
  ): Promise<number>;

  /**
   * IP of the OLDEST download row on the transaction since `since`.
   * Used for single-IP enforcement. Return `null` if no downloads yet
   * or if the oldest row has no IP.
   */
  getFirstDownloadIp(
    transactionId: number,
    since: string | null,
  ): Promise<string | null>;

  /**
   * Set of distinct IPs on the transaction since `since`. Used for
   * the N-distinct-IPs cap. Exclude null IPs.
   */
  getDistinctIps(
    transactionId: number,
    since: string | null,
  ): Promise<Set<string>>;
}

// ── Config ───────────────────────────────────────

/**
 * Gate-time configuration. Returned by your `loadConfig()` closure on
 * every check — typically reads from your settings K/V store. Cache
 * inside `loadConfig` if it's hot.
 */
export interface DownloadConfig {
  /** Per-(file, transaction) cap. `0` = unlimited (gate skips count check). */
  defaultLimit: number;
  /** Lock the transaction to the IP of the first successful download. */
  singleIp: boolean;
  /** Max distinct IPs allowed across all downloads on a transaction. `0` = no cap. Ignored when `singleIp` is true (single-IP wins). */
  maxDistinctIps: number;
}

/**
 * Optional pre-check hook. Runs BEFORE the standard checks; return a
 * `{ allowed: false, ... }` result to short-circuit. Returning `null`
 * (or any non-`{allowed:false}` value) lets the standard checks run.
 *
 * Use for app-specific gates that don't fit the standard shape:
 * "the file's product is in a frozen subscription window," "the
 * customer has a separate download-frozen flag," etc.
 */
export type PreCheck = (params: CheckParams) => Promise<GateResult | null | undefined>;

// ── Factory config ───────────────────────────────

export interface DownloadGateConfig {
  queries: DownloadQueries;
  /** Loads the per-request config (limit + IP enforcement settings). */
  loadConfig: () => Promise<DownloadConfig>;
  /**
   * Optional download-log writer. If omitted, calling `log()` throws —
   * useful when you only need read-only `check()` (e.g. preview UI).
   */
  writeDownloadLog?: (record: DownloadLogRecord) => Promise<void>;
  /** Optional app-specific pre-checks; run before the standard chain. */
  preChecks?: PreCheck[];
}

/**
 * Built-and-configured download gate. Returned from {@link createDownloadGate}.
 */
export interface DownloadGate {
  /**
   * Run the gate. Does NOT log a download — call `log()` after the
   * allowed branch so failed attempts don't pollute counters or the
   * single-IP record.
   */
  check(params: CheckParams): Promise<GateResult>;
  /**
   * Append a download log entry. Throws if `writeDownloadLog` wasn't
   * supplied at factory time.
   */
  log(record: DownloadLogRecord): Promise<void>;
}

/**
 * Build a configured download gate. See the JSDoc on the JS export
 * for the full wiring example.
 */
export function createDownloadGate(config: DownloadGateConfig): DownloadGate;

/**
 * Pick the more-recent of two ISO timestamps. Exported so consumers
 * can reuse the same comparison semantics outside the gate.
 */
export function pickLater(a: string | null | undefined, b: string | null | undefined): string | null;
