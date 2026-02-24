import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

import log from '../lib/logger';
import type { EntryData, PricesDataObject, PricesObject } from './Pricelist';
import type TradeOfferManager from '@tf2autobot/tradeoffer-manager';
import type { Blocked } from './MyHandler/interfaces';
import type { FIFOEntry } from './InventoryCostBasis';
export default class BotDatabase {
    private readonly db: BetterSqlite3.Database;

    readonly accountName: string;

    constructor(dbPath: string, accountName: string) {
        this.accountName = accountName;

        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new BetterSqlite3(dbPath);

        // had issues with reads and writes Claude saved the day
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this.initSchema();
    }

    //This is a straight rip from the original files to sqlite and might need refining as we will end up storing json within the rows

    private initSchema(): void {
        this.db.exec(`
            -- One row per pricelist entry (SKU)
            CREATE TABLE IF NOT EXISTS pricelist (
                account_name        TEXT    NOT NULL,
                sku                 TEXT    NOT NULL,
                item_id             TEXT,
                enabled             INTEGER NOT NULL DEFAULT 1,
                autoprice           INTEGER NOT NULL DEFAULT 1,
                min_stock           INTEGER NOT NULL DEFAULT 0,
                max_stock           INTEGER NOT NULL DEFAULT 1,
                intent              INTEGER NOT NULL DEFAULT 2,
                buy_keys            INTEGER,
                buy_metal           REAL,
                sell_keys           INTEGER,
                sell_metal          REAL,
                promoted            INTEGER NOT NULL DEFAULT 0,
                item_group          TEXT,
                note_buy            TEXT,
                note_sell           TEXT,
                is_partial_priced   INTEGER NOT NULL DEFAULT 0,
                price_time          INTEGER,
                purchase_history    TEXT,
                partial_price_time  INTEGER,
                last_in_stock_time  INTEGER,
                PRIMARY KEY (account_name, sku)
            );

            -- One row per trade offer
            CREATE TABLE IF NOT EXISTS poll_data (
                account_name TEXT    NOT NULL,
                offer_id     TEXT    NOT NULL,
                direction    TEXT    NOT NULL,  -- 'sent' | 'received'
                state        INTEGER NOT NULL,
                ts           INTEGER,
                offer_data   TEXT,              -- JSON blob
                PRIMARY KEY (account_name, offer_id)
            );

            -- One row per account: stores offersSince
            CREATE TABLE IF NOT EXISTS poll_meta (
                account_name TEXT    NOT NULL PRIMARY KEY,
                offers_since INTEGER NOT NULL DEFAULT 0
            );

            -- One row per login-attempt Unix timestamp
            CREATE TABLE IF NOT EXISTS login_attempts (
                account_name TEXT    NOT NULL,
                ts           INTEGER NOT NULL,
                PRIMARY KEY (account_name, ts)
            );

            -- One row per blocked SteamID
            CREATE TABLE IF NOT EXISTS blocked_users (
                account_name TEXT NOT NULL,
                steam_id     TEXT NOT NULL,
                reason       TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (account_name, steam_id)
            );

            -- One row per FIFO cost-basis acquisition
            CREATE TABLE IF NOT EXISTS cost_basis (
                row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
                account_name TEXT    NOT NULL,
                sku          TEXT    NOT NULL,
                cost_keys    REAL    NOT NULL DEFAULT 0,
                cost_metal   REAL    NOT NULL DEFAULT 0,
                diff_keys    REAL    NOT NULL DEFAULT 0,
                diff_metal   REAL    NOT NULL DEFAULT 0,
                trade_id     TEXT    NOT NULL,
                timestamp    INTEGER NOT NULL,
                diff_version INTEGER NOT NULL DEFAULT 2
            );

            CREATE INDEX IF NOT EXISTS idx_pricelist_account   ON pricelist      (account_name);
            CREATE INDEX IF NOT EXISTS idx_poll_data_account   ON poll_data      (account_name);
            CREATE INDEX IF NOT EXISTS idx_login_attempts_acct ON login_attempts (account_name);
            CREATE INDEX IF NOT EXISTS idx_blocked_users_acct  ON blocked_users  (account_name);
            CREATE INDEX IF NOT EXISTS idx_cost_basis_account  ON cost_basis     (account_name);
        `);

        this.migrateFromBotData();
    }

    // literally just take whats in the json and throw it in the db
    private migrateFromBotData(): void {
        if (!this.tableExists('bot_data')) return;

        const rows = this.db
            .prepare(`SELECT key, value FROM bot_data WHERE account_name = ?`)
            .all(this.accountName) as { key: string; value: string }[];

        if (rows.length === 0) return;

        for (const { key, value } of rows) {
            try {
                const data = JSON.parse(value);
                switch (key) {
                    case 'pricelist':
                        if (this.pricelistCount() === 0) this.savePricelist(data as PricesDataObject);
                        break;
                    case 'poll_data':
                        if (this.pollDataCount() === 0) this.savePollData(data as TradeOfferManager.PollData);
                        break;
                    case 'login_attempts':
                        if (this.loginAttemptsCount() === 0) this.saveLoginAttempts(data as number[]);
                        break;
                    case 'blocked_list':
                        if (this.blockedUsersCount() === 0) this.saveBlockedList(data as Blocked);
                        break;
                }
            } catch {
                // Ignore parse errors — better to start fresh than to crash
            }
        }

        this.db.prepare(`DELETE FROM bot_data WHERE account_name = ?`).run(this.accountName);

        // Drop the legacy table once all accounts have been lifted
        const remaining = (this.db.prepare(`SELECT COUNT(*) AS cnt FROM bot_data`).get() as { cnt: number }).cnt;
        if (remaining === 0) {
            this.db.exec(`DROP TABLE IF EXISTS bot_data`);
            log.info('[DB] Dropped legacy bot_data table.');
        }

        log.info(`[DB] In-DB migration from bot_data complete for ${this.accountName}`);
    }

    migrateFromFiles(filesDir: string): void {
        let migrated = 0;

        const tryMigrateKv = (filename: string, fn: (data: any) => void, alreadyHasData: () => boolean) => {
            const filePath = path.join(filesDir, filename);
            if (!fs.existsSync(filePath)) return;

            if (alreadyHasData()) {
                this.safeRename(filePath);
                return;
            }

            try {
                const content = fs.readFileSync(filePath, 'utf8').trim();
                if (content.length === 0) {
                    this.safeRename(filePath);
                    return;
                }
                fn(JSON.parse(content));
                this.safeRename(filePath);
                migrated++;
                log.info(`[DB] Migrated ${filename} → SQLite (${this.accountName})`);
            } catch (err) {
                log.warn(`[DB] Failed to migrate ${filename}: `, err);
            }
        };

        tryMigrateKv(
            'pricelist.json',
            data => this.savePricelist(data as PricesDataObject),
            () => this.pricelistCount() > 0
        );
        tryMigrateKv(
            'loginattempts.json',
            data => this.saveLoginAttempts(data as number[]),
            () => this.loginAttemptsCount() > 0
        );
        tryMigrateKv(
            'polldata.json',
            data => this.savePollData(data as TradeOfferManager.PollData),
            () => this.pollDataCount() > 0
        );
        tryMigrateKv(
            'blockedList.json',
            data => this.saveBlockedList(data as Blocked),
            () => this.blockedUsersCount() > 0
        );

        let i = 1;
        while (true) {
            const numbered = path.join(filesDir, `polldata${i}.json`);
            if (!fs.existsSync(numbered)) break;
            this.safeRename(numbered);
            i++;
        }
        const costBasisPath = path.join(filesDir, 'costBasis.json');
        if (fs.existsSync(costBasisPath)) {
            const existing = (
                this.db
                    .prepare('SELECT COUNT(*) AS cnt FROM cost_basis WHERE account_name = ?')
                    .get(this.accountName) as { cnt: number }
            ).cnt;

            if (existing === 0) {
                try {
                    const content = fs.readFileSync(costBasisPath, 'utf8').trim();
                    if (content.length > 0) {
                        const entries: FIFOEntry[] = JSON.parse(content);
                        this.saveCostBasisEntries(this.normalizeCostBasisEntries(entries));
                        migrated++;
                        log.info(`[DB] Migrated costBasis.json → SQLite (${this.accountName})`);
                    }
                    this.safeRename(costBasisPath);
                } catch (err) {
                    log.warn('[DB] Failed to migrate costBasis.json: ', err);
                }
            } else {
                this.safeRename(costBasisPath);
            }
        }

        if (migrated > 0) {
            log.info(`[DB] Migration complete for ${this.accountName}: ${migrated} file(s) imported.`);
        }
    }

    getPricelist(): PricesDataObject | null {
        const rows = this.db
            .prepare(
                `SELECT sku, item_id, enabled, autoprice, min_stock, max_stock, intent,
                        buy_keys, buy_metal, sell_keys, sell_metal, promoted, item_group,
                        note_buy, note_sell, is_partial_priced, price_time,
                        purchase_history, partial_price_time, last_in_stock_time
                 FROM pricelist
                 WHERE account_name = ?`
            )
            .all(this.accountName) as any[];

        if (rows.length === 0) return null;

        const result: PricesDataObject = {};
        for (const row of rows) {
            const entry: EntryData = {
                sku: row.sku,
                enabled: row.enabled === 1,
                autoprice: row.autoprice === 1,
                min: row.min_stock,
                max: row.max_stock,
                intent: row.intent as 0 | 1 | 2,
                promoted: (row.promoted ?? 0) as 0 | 1,
                group: row.item_group ?? null,
                note: { buy: row.note_buy ?? null, sell: row.note_sell ?? null },
                isPartialPriced: row.is_partial_priced === 1,
                time: row.price_time ?? null,
                purchaseHistory: row.purchase_history ? JSON.parse(row.purchase_history) : [],
                partialPriceTime: row.partial_price_time ?? null,
                lastInStockTime: row.last_in_stock_time ?? null
            };
            if (row.item_id != null) entry.id = row.item_id;
            if (row.buy_keys != null && row.buy_metal != null) {
                entry.buy = { keys: row.buy_keys, metal: row.buy_metal };
            }
            if (row.sell_keys != null && row.sell_metal != null) {
                entry.sell = { keys: row.sell_keys, metal: row.sell_metal };
            }
            result[row.sku] = entry;
        }
        return result;
    }

    //literally the same as above old method converted to save to sqlite
    savePricelist(data: PricesObject | PricesDataObject): void {
        const deleteStmt = this.db.prepare(`DELETE FROM pricelist WHERE account_name = ?`);
        const insertStmt = this.db.prepare(`
            INSERT INTO pricelist (
                account_name, sku, item_id, enabled, autoprice, min_stock, max_stock, intent,
                buy_keys, buy_metal, sell_keys, sell_metal, promoted, item_group,
                note_buy, note_sell, is_partial_priced, price_time,
                purchase_history, partial_price_time, last_in_stock_time
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_name, sku) DO UPDATE SET
                item_id            = excluded.item_id,
                enabled            = excluded.enabled,
                autoprice          = excluded.autoprice,
                min_stock          = excluded.min_stock,
                max_stock          = excluded.max_stock,
                intent             = excluded.intent,
                buy_keys           = excluded.buy_keys,
                buy_metal          = excluded.buy_metal,
                sell_keys          = excluded.sell_keys,
                sell_metal         = excluded.sell_metal,
                promoted           = excluded.promoted,
                item_group         = excluded.item_group,
                note_buy           = excluded.note_buy,
                note_sell          = excluded.note_sell,
                is_partial_priced  = excluded.is_partial_priced,
                price_time         = excluded.price_time,
                purchase_history   = excluded.purchase_history,
                partial_price_time = excluded.partial_price_time,
                last_in_stock_time = excluded.last_in_stock_time
        `);

        const tx = this.db.transaction((entries: [string, EntryData][]) => {
            deleteStmt.run(this.accountName);
            for (const [, e] of entries) {
                insertStmt.run(
                    this.accountName,
                    e.sku,
                    e.id ?? null,
                    e.enabled ? 1 : 0,
                    e.autoprice ? 1 : 0,
                    e.min,
                    e.max,
                    e.intent,
                    e.buy?.keys ?? null,
                    e.buy?.metal ?? null,
                    e.sell?.keys ?? null,
                    e.sell?.metal ?? null,
                    e.promoted ?? 0,
                    e.group ?? null,
                    e.note?.buy ?? null,
                    e.note?.sell ?? null,
                    e.isPartialPriced ? 1 : 0,
                    e.time ?? null,
                    e.purchaseHistory?.length ? JSON.stringify(e.purchaseHistory) : null,
                    e.partialPriceTime ?? null,
                    e.lastInStockTime ?? null
                );
            }
        });

        tx(Object.entries(data));
    }

    getPollData(): TradeOfferManager.PollData | null {
        const metaRow = this.db
            .prepare(`SELECT offers_since FROM poll_meta WHERE account_name = ?`)
            .get(this.accountName) as { offers_since: number } | undefined;

        const offerRows = this.db
            .prepare(
                `SELECT offer_id, direction, state, ts, offer_data
                 FROM poll_data
                 WHERE account_name = ?`
            )
            .all(this.accountName) as {
            offer_id: string;
            direction: 'sent' | 'received';
            state: number;
            ts: number | null;
            offer_data: string | null;
        }[];

        if (!metaRow && offerRows.length === 0) return null;

        const result: TradeOfferManager.PollData = {
            sent: {},
            received: {},
            timestamps: {},
            offersSince: metaRow?.offers_since ?? 0,
            offerData: {}
        };

        for (const row of offerRows) {
            result[row.direction][row.offer_id] = row.state;
            if (row.ts != null) result.timestamps[row.offer_id] = row.ts;
            if (row.offer_data != null) {
                try {
                    result.offerData[row.offer_id] = JSON.parse(row.offer_data);
                } catch {
                    result.offerData[row.offer_id] = {};
                }
            }
        }

        return result;
    }

    savePollData(data: TradeOfferManager.PollData): void {
        const deletePollStmt = this.db.prepare(`DELETE FROM poll_data WHERE account_name = ?`);
        const insertPollStmt = this.db.prepare(`
            INSERT INTO poll_data (account_name, offer_id, direction, state, ts, offer_data)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_name, offer_id) DO UPDATE SET
                direction  = excluded.direction,
                state      = excluded.state,
                ts         = excluded.ts,
                offer_data = excluded.offer_data
        `);
        const upsertMetaStmt = this.db.prepare(`
            INSERT INTO poll_meta (account_name, offers_since) VALUES (?, ?)
            ON CONFLICT(account_name) DO UPDATE SET offers_since = excluded.offers_since
        `);

        const tx = this.db.transaction(() => {
            deletePollStmt.run(this.accountName);
            upsertMetaStmt.run(this.accountName, data.offersSince ?? 0);

            // Merge sent + received — an offer ID appears in only one of the two
            const allIds = new Set([...Object.keys(data.sent ?? {}), ...Object.keys(data.received ?? {})]);

            for (const offerId of allIds) {
                const isSent = offerId in (data.sent ?? {});
                const direction = isSent ? 'sent' : 'received';
                const state = isSent ? data.sent[offerId] : data.received[offerId];
                const ts = data.timestamps?.[offerId] ?? null;
                const offerDataJson =
                    data.offerData?.[offerId] != null ? JSON.stringify(data.offerData[offerId]) : null;
                insertPollStmt.run(this.accountName, offerId, direction, state, ts, offerDataJson);
            }
        });

        tx();
    }

    getLoginAttempts(): number[] | null {
        const rows = this.db
            .prepare(`SELECT ts FROM login_attempts WHERE account_name = ? ORDER BY ts ASC`)
            .all(this.accountName) as { ts: number }[];

        if (rows.length === 0) return null;
        return rows.map(r => r.ts);
    }

    saveLoginAttempts(data: number[]): void {
        const deleteStmt = this.db.prepare(`DELETE FROM login_attempts WHERE account_name = ?`);
        const insertStmt = this.db.prepare(`INSERT OR IGNORE INTO login_attempts (account_name, ts) VALUES (?, ?)`);

        const tx = this.db.transaction((timestamps: number[]) => {
            deleteStmt.run(this.accountName);
            for (const ts of timestamps) {
                insertStmt.run(this.accountName, ts);
            }
        });

        tx(data);
    }

    getBlockedList(): Blocked | null {
        const rows = this.db
            .prepare(`SELECT steam_id, reason FROM blocked_users WHERE account_name = ?`)
            .all(this.accountName) as { steam_id: string; reason: string }[];

        if (rows.length === 0) return null;

        const result: Blocked = {};
        for (const row of rows) {
            result[row.steam_id] = row.reason;
        }
        return result;
    }

    saveBlockedList(data: Blocked): void {
        const deleteStmt = this.db.prepare(`DELETE FROM blocked_users WHERE account_name = ?`);
        const insertStmt = this.db.prepare(
            `INSERT OR IGNORE INTO blocked_users (account_name, steam_id, reason) VALUES (?, ?, ?)`
        );

        const tx = this.db.transaction((blocked: Blocked) => {
            deleteStmt.run(this.accountName);
            for (const [steamId, reason] of Object.entries(blocked)) {
                insertStmt.run(this.accountName, steamId, reason ?? '');
            }
        });

        tx(data);
    }

    getCostBasisEntries(): FIFOEntry[] {
        const rows = this.db
            .prepare(
                `SELECT sku, cost_keys, cost_metal, diff_keys, diff_metal,
                        trade_id, timestamp, diff_version
                 FROM cost_basis
                 WHERE account_name = ?
                 ORDER BY row_id ASC`
            )
            .all(this.accountName) as {
            sku: string;
            cost_keys: number;
            cost_metal: number;
            diff_keys: number;
            diff_metal: number;
            trade_id: string;
            timestamp: number;
            diff_version: number;
        }[];

        return rows.map(row => ({
            sku: row.sku,
            costKeys: row.cost_keys,
            costMetal: row.cost_metal,
            diffKeys: row.diff_keys,
            diffMetal: row.diff_metal,
            tradeId: row.trade_id,
            timestamp: row.timestamp,
            diffVersion: row.diff_version
        }));
    }

    saveCostBasisEntries(entries: FIFOEntry[]): void {
        const deleteStmt = this.db.prepare('DELETE FROM cost_basis WHERE account_name = ?');
        const insertStmt = this.db.prepare(
            `INSERT INTO cost_basis
                (account_name, sku, cost_keys, cost_metal, diff_keys, diff_metal, trade_id, timestamp, diff_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const tx = this.db.transaction((rows: FIFOEntry[]) => {
            deleteStmt.run(this.accountName);
            for (const e of rows) {
                insertStmt.run(
                    this.accountName,
                    e.sku,
                    e.costKeys,
                    e.costMetal,
                    e.diffKeys,
                    e.diffMetal,
                    e.tradeId,
                    e.timestamp,
                    e.diffVersion ?? 2
                );
            }
        });

        tx(entries);
    }

    //I was stupid dont ask
    close(): void {
        try {
            this.db.close();
        } catch {
            // Ignore errors on close
        }
    }

    private tableExists(name: string): boolean {
        const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as
            | { name: string }
            | undefined;
        return row != null;
    }

    private pricelistCount(): number {
        return (
            this.db.prepare(`SELECT COUNT(*) AS c FROM pricelist WHERE account_name = ?`).get(this.accountName) as {
                c: number;
            }
        ).c;
    }

    private pollDataCount(): number {
        return (
            this.db.prepare(`SELECT COUNT(*) AS c FROM poll_data WHERE account_name = ?`).get(this.accountName) as {
                c: number;
            }
        ).c;
    }

    private loginAttemptsCount(): number {
        return (
            this.db
                .prepare(`SELECT COUNT(*) AS c FROM login_attempts WHERE account_name = ?`)
                .get(this.accountName) as { c: number }
        ).c;
    }

    private blockedUsersCount(): number {
        return (
            this.db.prepare(`SELECT COUNT(*) AS c FROM blocked_users WHERE account_name = ?`).get(this.accountName) as {
                c: number;
            }
        ).c;
    }

    private safeRename(filePath: string): void {
        try {
            fs.renameSync(filePath, filePath + '.migrated');
        } catch {
            // Best-effort
        }
    }

    private normalizeCostBasisEntries(entries: FIFOEntry[]): FIFOEntry[] {
        const CURRENT_DIFF_VERSION = 2;
        return entries.map((entry: FIFOEntry & { diff?: number }) => {
            let e: any = { ...entry };

            // Very old format: single 'diff' (metal only) → diffKeys / diffMetal
            if ('diff' in e && !('diffKeys' in e)) {
                e = { ...e, diffKeys: 0, diffMetal: e.diff };
                delete e.diff;
            }

            // Version 1 had the sign backwards
            if ((e.diffVersion ?? 0) !== CURRENT_DIFF_VERSION) {
                e = {
                    ...e,
                    diffKeys: -(e.diffKeys ?? 0),
                    diffMetal: -(e.diffMetal ?? 0),
                    diffVersion: CURRENT_DIFF_VERSION
                };
            }

            return e as FIFOEntry;
        });
    }
}
