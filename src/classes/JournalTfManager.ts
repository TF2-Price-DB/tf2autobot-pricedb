import axios, { AxiosError, AxiosInstance } from 'axios';
import filterAxiosError from '@tf2autobot/filter-axios-error';
import { promises as fs } from 'fs';
import path from 'path';
import log from '../lib/logger';

export type JournalTfPnlPeriod = 'daily' | 'weekly' | 'monthly' | 'all';

export interface JournalTfPortfolioEntry {
    id: string;
    sku: string;
    item_name: string;
    buy_price_keys: number;
    buy_price_metal: string;
    quantity: number;
    notes: string | null;
    purchased_at: string;
    status: string;
    created_at: string;
    quantityRemaining?: number;
}

export interface JournalTfPortfolioResponse {
    ok: boolean;
    data: {
        entries: JournalTfPortfolioEntry[];
        summary?: Record<string, unknown>;
    };
}

export interface JournalTfPortfolioEntryResponse {
    ok: boolean;
    data: {
        entry: JournalTfPortfolioEntry;
        sells?: JournalTfSell[];
    };
}

export interface JournalTfPortfolioCreateRequest {
    sku: string;
    item_name: string;
    buy_price_keys: number;
    buy_price_metal: number;
    quantity: number;
    purchased_at: string;
    notes: string;
}

export interface JournalTfPortfolioCreateResponse {
    ok: boolean;
    data: {
        entry: JournalTfPortfolioEntry;
    };
}

export interface JournalTfSell {
    id: string;
    entry_id: string;
    sell_price_keys: number;
    sell_price_metal: string;
    quantity_sold: number;
    realized_pnl_metal: string;
    key_price_at_sale: string;
    notes: string | null;
    sold_at: string;
}

export interface JournalTfSellRequest {
    sell_price_keys: number;
    sell_price_metal: number;
    quantity_sold: number;
    notes: string;
}

export interface JournalTfSellResponse {
    ok: boolean;
    data: {
        sell: JournalTfSell;
    };
}

export interface JournalTfPnlResponse {
    ok: boolean;
    data: {
        period: JournalTfPnlPeriod;
        sells: Array<
            JournalTfSell & { sku: string; item_name: string; buy_price_keys: number; buy_price_metal: string }
        >;
        summary: Record<string, number>;
    };
}

export interface JournalTfBoughtItem {
    sku: string;
    itemName: string;
    buyPriceKeys: number;
    buyPriceMetal: number;
    quantity: number;
    purchasedAt: string;
    notes: string;
}

export interface JournalTfSoldItem {
    sku: string;
    sellPriceKeys: number;
    sellPriceMetal: number;
    quantity: number;
    notes: string;
}

interface QueuedRequest {
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
}

interface JournalTfSyncOperation {
    type: 'buy' | 'sell';
    tradeId: string;
    sku: string;
    quantity: number;
    portfolioEntryId?: string;
    journalRecordId?: string;
    timestamp: number;
}

interface JournalTfSyncState {
    operations: JournalTfSyncOperation[];
}

export default class JournalTfManager {
    static readonly baseURL = 'https://journal.tf/api/v1';

    private readonly axiosInstance: AxiosInstance;

    private readonly requestQueue: QueuedRequest[] = [];

    private isProcessingQueue = false;

    private readonly requestDelayMs = 100;

    private stateLoaded = false;

    private syncState: JournalTfSyncState = { operations: [] };

    constructor(apiKey: string, private readonly stateFilePath: string) {
        this.axiosInstance = axios.create({
            baseURL: JournalTfManager.baseURL,
            headers: {
                'X-API-Key': apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    }

    async getPortfolio(): Promise<JournalTfPortfolioResponse> {
        return this.queueRequest(async () => {
            const response = await this.axiosInstance.get<JournalTfPortfolioResponse>('/portfolio');
            return response.data;
        });
    }

    async createPortfolioEntry(payload: JournalTfPortfolioCreateRequest): Promise<JournalTfPortfolioCreateResponse> {
        return this.queueRequest(async () => {
            const response = await this.axiosInstance.post<JournalTfPortfolioCreateResponse>('/portfolio', payload);
            return response.data;
        });
    }

    async getPortfolioEntry(id: string): Promise<JournalTfPortfolioEntryResponse> {
        return this.queueRequest(async () => {
            const response = await this.axiosInstance.get<JournalTfPortfolioEntryResponse>(`/portfolio/${id}`);
            return response.data;
        });
    }

    async recordSell(id: string, payload: JournalTfSellRequest): Promise<JournalTfSellResponse> {
        return this.queueRequest(async () => {
            const response = await this.axiosInstance.post<JournalTfSellResponse>(`/portfolio/${id}/sells`, payload);
            return response.data;
        });
    }

    async getPnl(period: JournalTfPnlPeriod): Promise<JournalTfPnlResponse> {
        return this.queueRequest(async () => {
            const response = await this.axiosInstance.get<JournalTfPnlResponse>('/pnl', { params: { period } });
            return response.data;
        });
    }

    async syncTrade(
        tradeId: string,
        boughtItems: JournalTfBoughtItem[],
        soldItems: JournalTfSoldItem[]
    ): Promise<void> {
        await this.loadState();
        await this.syncBoughtItems(tradeId, boughtItems);
        await this.syncSoldItems(tradeId, soldItems);
    }

    getMatchedSellEntries(
        entries: JournalTfPortfolioEntry[],
        sku: string,
        quantity: number
    ): Array<{ entry: JournalTfPortfolioEntry; quantity: number }> {
        let remaining = quantity;
        const matches: Array<{ entry: JournalTfPortfolioEntry; quantity: number }> = [];

        const eligibleEntries = entries
            .filter(entry => entry.sku === sku && entry.status === 'active' && this.getRemainingQuantity(entry) > 0)
            .sort((a, b) => this.getEntryTime(a) - this.getEntryTime(b));

        for (const entry of eligibleEntries) {
            if (remaining <= 0) {
                break;
            }

            const quantityToSell = Math.min(remaining, this.getRemainingQuantity(entry));
            matches.push({ entry, quantity: quantityToSell });
            remaining -= quantityToSell;
        }

        return matches;
    }

    private async syncBoughtItems(tradeId: string, boughtItems: JournalTfBoughtItem[]): Promise<void> {
        for (const item of boughtItems) {
            const syncedQuantity = this.getSyncedQuantity('buy', tradeId, item.sku);
            const quantity = item.quantity - syncedQuantity;

            if (quantity <= 0) {
                continue;
            }

            const response = await this.createPortfolioEntry({
                sku: item.sku,
                item_name: item.itemName,
                buy_price_keys: item.buyPriceKeys,
                buy_price_metal: item.buyPriceMetal,
                quantity,
                purchased_at: item.purchasedAt,
                notes: item.notes
            });

            this.syncState.operations.push({
                type: 'buy',
                tradeId,
                sku: item.sku,
                quantity,
                portfolioEntryId: response.data.entry.id,
                journalRecordId: response.data.entry.id,
                timestamp: Date.now()
            });
            await this.saveState();
        }
    }

    private async syncSoldItems(tradeId: string, soldItems: JournalTfSoldItem[]): Promise<void> {
        if (soldItems.length === 0) {
            return;
        }

        const portfolio = await this.getPortfolio();
        const entries = portfolio.data.entries;

        for (const item of soldItems) {
            const syncedQuantity = this.getSyncedQuantity('sell', tradeId, item.sku);
            const quantity = item.quantity - syncedQuantity;

            if (quantity <= 0) {
                continue;
            }

            const matches = this.getMatchedSellEntries(entries, item.sku, quantity);
            const matchedQuantity = matches.reduce((sum, match) => sum + match.quantity, 0);

            if (matchedQuantity < quantity) {
                log.warn(
                    `journal.tf sync could only match ${matchedQuantity}/${quantity} sold ${item.sku} entries for trade ${tradeId}`
                );
            }

            for (const match of matches) {
                const response = await this.recordSell(match.entry.id, {
                    sell_price_keys: item.sellPriceKeys,
                    sell_price_metal: item.sellPriceMetal,
                    quantity_sold: match.quantity,
                    notes: item.notes
                });

                this.syncState.operations.push({
                    type: 'sell',
                    tradeId,
                    sku: item.sku,
                    quantity: match.quantity,
                    portfolioEntryId: match.entry.id,
                    journalRecordId: response.data.sell.id,
                    timestamp: Date.now()
                });
                await this.saveState();

                match.entry.quantityRemaining = this.getRemainingQuantity(match.entry) - match.quantity;
                if (match.entry.quantityRemaining <= 0) {
                    match.entry.status = 'sold';
                }
            }
        }
    }

    private getSyncedQuantity(type: 'buy' | 'sell', tradeId: string, sku: string): number {
        return this.syncState.operations
            .filter(operation => operation.type === type && operation.tradeId === tradeId && operation.sku === sku)
            .reduce((sum, operation) => sum + operation.quantity, 0);
    }

    private async queueRequest<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                fn,
                resolve: value => resolve(value as T),
                reject
            });
            void this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            if (!request) {
                break;
            }

            try {
                const result = await request.fn();
                request.resolve(result);
            } catch (err) {
                request.reject(filterAxiosError(err as AxiosError));
            }

            if (this.requestQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
            }
        }

        this.isProcessingQueue = false;
    }

    private getEntryTime(entry: JournalTfPortfolioEntry): number {
        return new Date(entry.purchased_at || entry.created_at).getTime();
    }

    private getRemainingQuantity(entry: JournalTfPortfolioEntry): number {
        return entry.quantityRemaining ?? entry.quantity;
    }

    private async loadState(): Promise<void> {
        if (this.stateLoaded) {
            return;
        }

        try {
            const raw = await fs.readFile(this.stateFilePath, 'utf8');
            const parsed = JSON.parse(raw) as JournalTfSyncState;
            this.syncState = {
                operations: Array.isArray(parsed.operations) ? parsed.operations : []
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.warn('Failed to load journal.tf sync state, starting with empty state:', err);
            }
            this.syncState = { operations: [] };
        }

        this.stateLoaded = true;
    }

    private async saveState(): Promise<void> {
        await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
        await fs.writeFile(this.stateFilePath, JSON.stringify(this.syncState, null, 2), 'utf8');
    }
}
