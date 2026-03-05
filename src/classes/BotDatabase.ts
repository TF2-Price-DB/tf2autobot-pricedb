import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

import log from '../lib/logger';
import type { EntryData, PricesDataObject, PricesObject } from './Pricelist';
import type TradeOfferManager from '@tf2autobot/tradeoffer-manager';
import type { Blocked } from './MyHandler/interfaces';
import type { FIFOEntry } from './InventoryCostBasis';

interface PricelistRow {
    price_key: string;
    sku: string;
    item_id: string | null;
    enabled: number;
    autoprice: number;
    min_stock: number;
    max_stock: number;
    intent: number;
    buy_keys: number | null;
    buy_metal: number | null;
    sell_keys: number | null;
    sell_metal: number | null;
    promoted: number;
    item_group: string | null;
    note_buy: string | null;
    note_sell: string | null;
    is_partial_priced: number;
    price_time: number | null;
    partial_price_time: number | null;
    last_in_stock_time: number | null;
}

interface PurchaseHistoryRow {
    id: number;
    sku: string;
    quantity: number;
    price_keys: number;
    price_metal: number;
    // (Math.floor(Date.now() / 1000)) I hate this but autobot handles date time like this so why reinvent the wheel
    timestamp: number;
}

interface BotRow {
    account_name: string;
    steam_id64: string | null;
    display_name: string | null;
    // See above comments for my anger on the issue
    created_at: number;
    last_seen_at: number | null;
}
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

    //This is the creation of the tables. If ever changed a migration needs to be put in for the next version
    //removed on the following major version
    private initSchema(): void {
        this.db.exec(`
            -- one row per bot
            CREATE TABLE IF NOT EXISTS bots (
                account_name  TEXT    NOT NULL PRIMARY KEY,
                steam_id64    TEXT,                          
                display_name  TEXT,
                created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
                last_seen_at  INTEGER                        
            );

            -- One row per price list entry
            CREATE TABLE IF NOT EXISTS pricelist (
                account_name        TEXT    NOT NULL,
                price_key           TEXT    NOT NULL,   
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
                partial_price_time  INTEGER,            
                last_in_stock_time  INTEGER,            
                PRIMARY KEY (account_name, price_key)
            );

            -- One row per purchase record related by sku
            -- TODO: how will we handle the cases of assetids instead of sku in the pricelist?
            CREATE TABLE IF NOT EXISTS purchase_history (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                account_name    TEXT    NOT NULL,
                sku             TEXT    NOT NULL,   
                quantity        INTEGER NOT NULL,
                price_keys      INTEGER NOT NULL DEFAULT 0,  -- has to be whole
                price_metal     REAL    NOT NULL DEFAULT 0,  
                timestamp       INTEGER NOT NULL             
            );

            -- Polldata Migration this might be the biggest breaking change time will tell if this is controversial 
            CREATE TABLE IF NOT EXISTS poll_data (
                account_name TEXT    NOT NULL,
                offer_id     TEXT    NOT NULL,
                direction    TEXT    NOT NULL,   
                state        INTEGER NOT NULL,
                ts           INTEGER,
                offer_data   TEXT,               
                PRIMARY KEY (account_name, offer_id)
            );

            -- One row per account: stores offersSince cursor
            CREATE TABLE IF NOT EXISTS poll_meta (
                account_name TEXT    NOT NULL PRIMARY KEY,
                offers_since INTEGER NOT NULL DEFAULT 0
            );

            -- One row per
            CREATE TABLE IF NOT EXISTS login_attempts (
                account_name TEXT    NOT NULL,
                ts           INTEGER NOT NULL,
                PRIMARY KEY (account_name, ts)
            );

            -- One row per blocked user can now be shared across bots thankfully
            CREATE TABLE IF NOT EXISTS blocked_users (
                account_name TEXT NOT NULL,
                steam_id     TEXT NOT NULL,
                reason       TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (account_name, steam_id)
            );

            -- for profit tracking this stored per entry as we can have multiple instances of the same sku
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

            -- Index overkill
            CREATE INDEX IF NOT EXISTS idx_pricelist_account         ON pricelist        (account_name);
            CREATE INDEX IF NOT EXISTS idx_purchase_history_acct_sku ON purchase_history (account_name, sku);
            CREATE INDEX IF NOT EXISTS idx_purchase_history_ts       ON purchase_history (timestamp);
            CREATE INDEX IF NOT EXISTS idx_poll_data_account         ON poll_data        (account_name);
            CREATE INDEX IF NOT EXISTS idx_login_attempts_acct       ON login_attempts   (account_name);
            CREATE INDEX IF NOT EXISTS idx_blocked_users_acct        ON blocked_users    (account_name);
            CREATE INDEX IF NOT EXISTS idx_cost_basis_account        ON cost_basis       (account_name);
            CREATE INDEX IF NOT EXISTS idx_cost_basis_account_sku    ON cost_basis       (account_name, sku);
        `);

        this.migrateFromBotData();
        this.migratePurchaseHistoryColumn();
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

    //Migration will be removed on future versions and changed to a seperate script
    private migratePurchaseHistoryColumn(): void {
        // Check whether the legacy column still exists
        const cols = this.db.pragma(`table_info(pricelist)`) as { name: string }[];
        const hasLegacyCol = cols.some(c => c.name === 'purchase_history');
        if (!hasLegacyCol) return;

        log.info('[DB] Migrating pricelist.purchase_history JSON blobs → purchase_history table…');

        const rows = this.db
            .prepare(
                `SELECT account_name, sku, purchase_history
                 FROM pricelist
                 WHERE purchase_history IS NOT NULL AND purchase_history != '[]'`
            )
            .all() as { account_name: string; sku: string; purchase_history: string }[];

        if (rows.length > 0) {
            const insertStmt = this.db.prepare(`
                INSERT OR IGNORE INTO purchase_history
                    (account_name, sku, quantity, price_keys, price_metal, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `);

            const tx = this.db.transaction(() => {
                let rowsInserted = 0;
                for (const row of rows) {
                    try {
                        const records: {
                            quantity: number;
                            pricePaid: { keys: number; metal: number };
                            timestamp: number;
                        }[] = JSON.parse(row.purchase_history);

                        for (const rec of records) {
                            insertStmt.run(
                                row.account_name,
                                row.sku,
                                rec.quantity,
                                rec.pricePaid?.keys ?? 0,
                                rec.pricePaid?.metal ?? 0,
                                rec.timestamp
                            );
                            rowsInserted++;
                        }
                    } catch {
                        // Ignore malformed JSON — better to lose history than crash
                    }
                }
                log.info(`[DB] Migrated ${rowsInserted} purchase_history record(s) from pricelist blob.`);
            });
            tx();
        }

        // Drop the legacy column (requires SQLite 3.35+; gracefully skip on older builds)
        try {
            this.db.exec(`ALTER TABLE pricelist DROP COLUMN purchase_history`);
            log.info('[DB] Dropped legacy pricelist.purchase_history column.');
        } catch (err) {
            log.warn(
                '[DB] Could not drop pricelist.purchase_history column (SQLite < 3.35?). ' +
                    'The column will remain but will no longer be written to.',
                err
            );
        }
    }

    // part of the migration to be removed in the future
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
                `SELECT price_key, sku, item_id, enabled, autoprice, min_stock, max_stock, intent,
                        buy_keys, buy_metal, sell_keys, sell_metal, promoted, item_group,
                        note_buy, note_sell, is_partial_priced, price_time,
                        partial_price_time, last_in_stock_time
                 FROM pricelist
                 WHERE account_name = ?`
            )
            .all(this.accountName) as PricelistRow[];

        if (rows.length === 0) return null;

        // Load all purchase history
        const historyRows = this.db
            .prepare(
                `SELECT sku, quantity, price_keys, price_metal, timestamp
                 FROM purchase_history
                 WHERE account_name = ?
                 ORDER BY sku, id ASC`
            )
            .all(this.accountName) as PurchaseHistoryRow[];

        // Group history rows
        const historyBySku: Record<
            string,
            { quantity: number; pricePaid: { keys: number; metal: number }; timestamp: number }[]
        > = {};
        for (const h of historyRows) {
            if (!historyBySku[h.sku]) historyBySku[h.sku] = [];
            historyBySku[h.sku].push({
                quantity: h.quantity,
                pricePaid: { keys: h.price_keys, metal: h.price_metal },
                timestamp: h.timestamp
            });
        }

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
                purchaseHistory: historyBySku[row.sku] ?? [],
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
            result[row.price_key] = entry;
        }
        return result;
    }

    // startup magic this bound to change
    savePricelist(data: PricesObject | PricesDataObject): void {
        const deletePricelistStmt = this.db.prepare(`DELETE FROM pricelist WHERE account_name = ?`);
        const deleteHistoryStmt = this.db.prepare(`DELETE FROM purchase_history WHERE account_name = ?`);

        const insertPricelistStmt = this.db.prepare(`
            INSERT INTO pricelist (
                account_name, price_key, sku, item_id, enabled, autoprice,
                min_stock, max_stock, intent,
                buy_keys, buy_metal, sell_keys, sell_metal, promoted, item_group,
                note_buy, note_sell, is_partial_priced, price_time,
                partial_price_time, last_in_stock_time
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_name, price_key) DO UPDATE SET
                sku                = excluded.sku,
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
                partial_price_time = excluded.partial_price_time,
                last_in_stock_time = excluded.last_in_stock_time
        `);

        const insertHistoryStmt = this.db.prepare(`
            INSERT INTO purchase_history
                (account_name, sku, quantity, price_keys, price_metal, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const tx = this.db.transaction((entries: [string, EntryData][]) => {
            deletePricelistStmt.run(this.accountName);
            deleteHistoryStmt.run(this.accountName);

            for (const [priceKey, e] of entries) {
                insertPricelistStmt.run(
                    this.accountName,
                    priceKey, // price_key: may be assetId for id-keyed entries
                    e.sku, // canonical TF2 SKU TODO: We need to ensure this is never null
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
                    e.partialPriceTime ?? null,
                    e.lastInStockTime ?? null
                );

                // Persist purchase history rows in FIFO insertion order
                if (e.purchaseHistory?.length) {
                    for (const rec of e.purchaseHistory) {
                        insertHistoryStmt.run(
                            this.accountName,
                            e.sku,
                            rec.quantity,
                            rec.pricePaid?.keys ?? 0,
                            rec.pricePaid?.metal ?? 0,
                            rec.timestamp
                        );
                    }
                }
            }
        });

        tx(Object.entries(data));
    }

    // adds to the pricelist table enough said
    upsertPricelistEntry(priceKey: string, entry: EntryData): void {
        this.db
            .prepare(
                `INSERT INTO pricelist (
                    account_name, price_key, sku, item_id, enabled, autoprice,
                    min_stock, max_stock, intent,
                    buy_keys, buy_metal, sell_keys, sell_metal, promoted, item_group,
                    note_buy, note_sell, is_partial_priced, price_time,
                    partial_price_time, last_in_stock_time
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(account_name, price_key) DO UPDATE SET
                    sku                = excluded.sku,
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
                    partial_price_time = excluded.partial_price_time,
                    last_in_stock_time = excluded.last_in_stock_time`
            )
            .run(
                this.accountName,
                priceKey,
                entry.sku,
                entry.id ?? null,
                entry.enabled ? 1 : 0,
                entry.autoprice ? 1 : 0,
                entry.min,
                entry.max,
                entry.intent,
                entry.buy?.keys ?? null,
                entry.buy?.metal ?? null,
                entry.sell?.keys ?? null,
                entry.sell?.metal ?? null,
                entry.promoted ?? 0,
                entry.group ?? null,
                entry.note?.buy ?? null,
                entry.note?.sell ?? null,
                entry.isPartialPriced ? 1 : 0,
                entry.time ?? null,
                entry.partialPriceTime ?? null,
                entry.lastInStockTime ?? null
            );
    }

    // removed from pricelist table enough also said
    deletePricelistEntry(priceKey: string): void {
        this.db
            .prepare(`DELETE FROM pricelist WHERE account_name = ? AND price_key = ?`)
            .run(this.accountName, priceKey);
    }

    // Adds a bot to the table simple as
    upsertBot(steamId64?: string | null, displayName?: string | null): void {
        this.db
            .prepare(
                `INSERT INTO bots (account_name, steam_id64, display_name, last_seen_at)
                 VALUES (?, ?, ?, CAST(strftime('%s', 'now') AS INTEGER))
                 ON CONFLICT(account_name) DO UPDATE SET
                     steam_id64   = COALESCE(excluded.steam_id64,  bots.steam_id64),
                     display_name = COALESCE(excluded.display_name, bots.display_name),
                     last_seen_at = excluded.last_seen_at`
            )
            .run(this.accountName, steamId64 ?? null, displayName ?? null);
    }

    getBot(): BotRow | null {
        return (
            (this.db.prepare(`SELECT * FROM bots WHERE account_name = ?`).get(this.accountName) as
                | BotRow
                | undefined) ?? null
        );
    }

    // Adds entries to the purchase history table I forsee issues with assetids and no sku
    addPurchaseHistoryRecord(
        sku: string,
        quantity: number,
        priceKeys: number,
        priceMetal: number,
        timestamp: number
    ): void {
        this.db
            .prepare(
                `INSERT INTO purchase_history
                     (account_name, sku, quantity, price_keys, price_metal, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(this.accountName, sku, quantity, priceKeys, priceMetal, timestamp);
    }

    // remove this entry based on FIFO this is used for PPU and needs reviewing for edge cases mostly relating to assetids and
    // related orphan records
    removePurchaseHistoryRecords(sku: string, quantity: number): void {
        const tx = this.db.transaction(() => {
            let remaining = quantity;

            while (remaining > 0) {
                const row = this.db
                    .prepare(
                        `SELECT id, quantity FROM purchase_history
                         WHERE account_name = ? AND sku = ?
                         ORDER BY id ASC LIMIT 1`
                    )
                    .get(this.accountName, sku) as { id: number; quantity: number } | undefined;

                if (!row) break; // No more records — already depleted

                if (row.quantity <= remaining) {
                    // Consume entire record
                    remaining -= row.quantity;
                    this.db.prepare(`DELETE FROM purchase_history WHERE id = ?`).run(row.id);
                } else {
                    // Partial consumption — reduce quantity in place
                    this.db
                        .prepare(`UPDATE purchase_history SET quantity = quantity - ? WHERE id = ?`)
                        .run(remaining, row.id);
                    remaining = 0;
                }
            }
        });
        tx();
    }

    // This removed after the ppu date. It might be cleaner long term to hold them but ignore after the time incase of extending
    // the time with in the config at a later date
    deleteExpiredPurchaseHistory(sku: string, thresholdSeconds: number): void {
        const cutoff = Math.floor(Date.now() / 1000) - thresholdSeconds;
        this.db
            .prepare(
                `DELETE FROM purchase_history
                 WHERE account_name = ? AND sku = ? AND timestamp <= ?`
            )
            .run(this.accountName, sku, cutoff);
    }

    // Just a getter for the price history
    getPurchaseHistoryForSku(
        sku: string
    ): { quantity: number; pricePaid: { keys: number; metal: number }; timestamp: number }[] {
        const rows = this.db
            .prepare(
                `SELECT quantity, price_keys, price_metal, timestamp
                 FROM purchase_history
                 WHERE account_name = ? AND sku = ?
                 ORDER BY id ASC`
            )
            .all(this.accountName, sku) as {
            quantity: number;
            price_keys: number;
            price_metal: number;
            timestamp: number;
        }[];

        return rows.map(r => ({
            quantity: r.quantity,
            pricePaid: { keys: r.price_keys, metal: r.price_metal },
            timestamp: r.timestamp
        }));
    }

    /** Remove all purchase history for a SKU (e.g. when the item is removed from pricelist). */
    deleteAllPurchaseHistoryForSku(sku: string): void {
        this.db.prepare(`DELETE FROM purchase_history WHERE account_name = ? AND sku = ?`).run(this.accountName, sku);
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

        // lets limit what we hold in memory to only active offers not all data
        const activeStates = new Set([2, 4, 9, 11]); // Active, Countered, NeedsConfirmation, InEscrow
        const sevenDaysAgoSecs = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

        for (const row of offerRows) {
            result[row.direction][row.offer_id] = row.state;
            if (row.ts != null) result.timestamps[row.offer_id] = row.ts;

            // might need to revert if not used as I suspect
            const isActive = activeStates.has(row.state);
            const isRecent = row.ts != null && row.ts >= sevenDaysAgoSecs;
            if (row.offer_data != null && (isActive || isRecent)) {
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
        const upsertOfferStmt = this.db.prepare(`
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
            upsertMetaStmt.run(this.accountName, data.offersSince ?? 0);

            // An offer ID appears in either sent or received, never both
            const allIds = new Set([...Object.keys(data.sent ?? {}), ...Object.keys(data.received ?? {})]);

            for (const offerId of allIds) {
                const isSent = offerId in (data.sent ?? {});
                const direction = isSent ? 'sent' : 'received';
                const state = isSent ? data.sent[offerId] : data.received[offerId];
                const ts = data.timestamps?.[offerId] ?? null;
                const offerDataJson =
                    data.offerData?.[offerId] != null ? JSON.stringify(data.offerData[offerId]) : null;
                upsertOfferStmt.run(this.accountName, offerId, direction, state, ts, offerDataJson);
            }

            if (allIds.size > 0) {
                const placeholders = Array.from(allIds).fill('?').join(',');
                this.db
                    .prepare(
                        `DELETE FROM poll_data
                         WHERE account_name = ?
                           AND offer_id NOT IN (${placeholders})`
                    )
                    .run(this.accountName, ...Array.from(allIds));
            } else {
                // Manager cleared all offers (e.g. after deletePollData)
                this.db.prepare(`DELETE FROM poll_data WHERE account_name = ?`).run(this.accountName);
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

    // Helpers credits goes to claude for converting the sql to useable functions here

    // ─── Per-operation cost_basis helpers (replaces the bulk DELETE+reinsert) ───

    /**
     * Insert a single FIFO cost basis entry.
     * Called once per item on every buy trade.
     * @param entry - The FIFO entry to persist
     */
    addCostBasisEntry(entry: FIFOEntry): void {
        this.db
            .prepare(
                `INSERT INTO cost_basis
                    (account_name, sku, cost_keys, cost_metal, diff_keys, diff_metal, trade_id, timestamp, diff_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                this.accountName,
                entry.sku,
                entry.costKeys,
                entry.costMetal,
                entry.diffKeys,
                entry.diffMetal,
                entry.tradeId,
                entry.timestamp,
                entry.diffVersion ?? 2
            );
    }

    /**
     * Remove and return the oldest (lowest row_id) FIFO entry for a SKU.
     * Returns null if no entry exists for that SKU.
     * @param sku - Item SKU
     */
    removeOldestCostBasisEntry(sku: string): FIFOEntry | null {
        const row = this.db
            .prepare(
                `SELECT row_id, sku, cost_keys, cost_metal, diff_keys, diff_metal,
                        trade_id, timestamp, diff_version
                 FROM cost_basis
                 WHERE account_name = ? AND sku = ?
                 ORDER BY row_id ASC
                 LIMIT 1`
            )
            .get(this.accountName, sku) as
            | {
                  row_id: number;
                  sku: string;
                  cost_keys: number;
                  cost_metal: number;
                  diff_keys: number;
                  diff_metal: number;
                  trade_id: string;
                  timestamp: number;
                  diff_version: number;
              }
            | undefined;

        if (!row) return null;

        this.db.prepare(`DELETE FROM cost_basis WHERE row_id = ?`).run(row.row_id);

        return {
            sku: row.sku,
            costKeys: row.cost_keys,
            costMetal: row.cost_metal,
            diffKeys: row.diff_keys,
            diffMetal: row.diff_metal,
            tradeId: row.trade_id,
            timestamp: row.timestamp,
            diffVersion: row.diff_version
        };
    }

    /**
     * Return the oldest FIFO cost basis entry for a SKU without removing it.
     * @param sku - Item SKU
     */
    peekCostBasisEntry(sku: string): FIFOEntry | null {
        const row = this.db
            .prepare(
                `SELECT sku, cost_keys, cost_metal, diff_keys, diff_metal,
                        trade_id, timestamp, diff_version
                 FROM cost_basis
                 WHERE account_name = ? AND sku = ?
                 ORDER BY row_id ASC
                 LIMIT 1`
            )
            .get(this.accountName, sku) as
            | {
                  sku: string;
                  cost_keys: number;
                  cost_metal: number;
                  diff_keys: number;
                  diff_metal: number;
                  trade_id: string;
                  timestamp: number;
                  diff_version: number;
              }
            | undefined;

        if (!row) return null;

        return {
            sku: row.sku,
            costKeys: row.cost_keys,
            costMetal: row.cost_metal,
            diffKeys: row.diff_keys,
            diffMetal: row.diff_metal,
            tradeId: row.trade_id,
            timestamp: row.timestamp,
            diffVersion: row.diff_version
        };
    }

    /**
     * Count how many FIFO entries exist for a specific SKU.
     * @param sku - Item SKU
     */
    getCostBasisCountForSku(sku: string): number {
        const row = this.db
            .prepare(`SELECT COUNT(*) AS cnt FROM cost_basis WHERE account_name = ? AND sku = ?`)
            .get(this.accountName, sku) as { cnt: number };
        return row.cnt;
    }

    /**
     * Delete all cost basis entries for this account.
     */
    clearCostBasisEntries(): void {
        this.db.prepare(`DELETE FROM cost_basis WHERE account_name = ?`).run(this.accountName);
    }

    /**
     * Get the total unrealised cost basis value across all inventory.
     * Actual cost per item = cost - diff (matching InventoryCostBasis.getInventoryValue convention).
     */
    getCostBasisInventoryValue(): { keys: number; metal: number } {
        const row = this.db
            .prepare(
                `SELECT COALESCE(SUM(cost_keys - diff_keys), 0) AS total_keys,
                        COALESCE(SUM(cost_metal - diff_metal), 0) AS total_metal
                 FROM cost_basis
                 WHERE account_name = ?`
            )
            .get(this.accountName) as { total_keys: number; total_metal: number };
        return { keys: row.total_keys, metal: row.total_metal };
    }

    // ─── Queries for in-memory savings: profit and friend-trade counts ─────────

    /**
     * Return all offer-data rows that contain FIFO profit records, ordered oldest-first.
     * Used by profit() to avoid keeping all historical offerData in memory.
     * The caller is responsible for admin/donation filtering.
     */
    getProfitRows(): Array<{
        partner?: string;
        handledByUs?: boolean;
        isAccepted?: boolean;
        action?: { reason?: string };
        donation?: boolean;
        buyBptfPremium?: boolean;
        handleTimestamp?: number;
        tradeProfit?: {
            rawProfit: { keys: number; metal: number };
            hasEstimates?: boolean;
            timestamp?: number;
        };
    }> {
        const rows = this.db
            .prepare(
                `SELECT offer_data
                 FROM poll_data
                 WHERE account_name = ?
                   AND offer_data IS NOT NULL
                   AND json_extract(offer_data, '$.tradeProfit') IS NOT NULL
                 ORDER BY ts ASC`
            )
            .all(this.accountName) as { offer_data: string }[];

        const result: ReturnType<BotDatabase['getProfitRows']> = [];
        for (const row of rows) {
            try {
                result.push(JSON.parse(row.offer_data));
            } catch {
                // Skip malformed rows
            }
        }
        return result;
    }

    /**
     * Count how many trades exist with each of the given partner SteamID64s.
     * Uses SQLite json_extract so partner does not need to be a top-level column.
     * @param steamID64s - Partner SteamID64 strings to count trades for
     */
    getTradeCountsByPartner(steamID64s: string[]): Record<string, number> {
        const result: Record<string, number> = {};
        steamID64s.forEach(id => {
            result[id] = 0;
        });

        if (steamID64s.length === 0) return result;

        const rows = this.db
            .prepare(
                `SELECT json_extract(offer_data, '$.partner') AS partner,
                        COUNT(*) AS cnt
                 FROM poll_data
                 WHERE account_name = ?
                   AND offer_data IS NOT NULL
                   AND json_extract(offer_data, '$.partner') IS NOT NULL
                 GROUP BY partner`
            )
            .all(this.accountName) as { partner: string; cnt: number }[];

        for (const row of rows) {
            if (Object.prototype.hasOwnProperty.call(result, row.partner)) {
                result[row.partner] = row.cnt;
            }
        }

        return result;
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
