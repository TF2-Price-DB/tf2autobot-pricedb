import axios, { AxiosError, AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import filterAxiosError from '@tf2autobot/filter-axios-error';
import log from '../lib/logger';

interface ManncoResponse<T> {
    err: number;
    success: boolean;
    content: T;
    message?: string;
}

export interface ManncoDepositAsset {
    assetid: string;
    depositkey: string;
}

interface ManncoDepositInformation {
    informations: Array<{
        assetid: string;
        depositkey: Record<string, string>;
    }>;
}

interface ManncoPriceItem {
    name: string;
    url: string;
}

interface ManncoItemDetails {
    informations: {
        id: number;
        name: string;
    };
}

export interface ManncoDepositTrade {
    id: string;
    [key: string]: unknown;
}

export type ManncoDepositStatus = -1 | 0 | 3;

/**
 * Mannco.store API client. Deposits intentionally remain a separate workflow
 * from Backpack.tf listings because an accepted deposit transfers ownership.
 */
export default class ManncoStoreManager extends EventEmitter {
    private readonly api: AxiosInstance;

    private jwt: string | null = null;

    private readonly listedAssetsBySku = new Map<string, string[]>();

    private readonly buyOrderValuesBySku = new Map<string, string>();

    private itemPrices: ManncoPriceItem[] | null = null;

    private itemPricesExpiresAt = 0;

    private readonly pendingDepositAssetIds: string[][] = [];

    constructor(private readonly apiKey: string) {
        super();
        this.api = axios.create({
            baseURL: 'https://api.mannco.store',
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': `TF2Autobot@${process.env.BOT_VERSION}`
            }
        });
    }

    async init(): Promise<void> {
        await this.login();
        log.debug('Mannco.store manager initialised');
    }

    async getDepositableAssets(game = 440): Promise<ManncoDepositAsset[]> {
        const depositInformation = await this.request<ManncoDepositInformation>('get', `/deposit/${game}`);

        return depositInformation.informations.flatMap(information =>
            information.assetid
                .split(';')
                .filter(assetid => assetid.length > 0 && information.depositkey[assetid] !== undefined)
                .map(assetid => ({ assetid, depositkey: information.depositkey[assetid] }))
        );
    }

    async createDepositTrade(
        prices: Record<string, number>,
        depositKeys: Record<string, string>,
        game = 440
    ): Promise<ManncoDepositTrade> {
        return this.request<ManncoDepositTrade>('post', '/deposit/trade', {
            prices,
            depositKeys,
            game
        });
    }

    async getDepositTradeStatus(tradeId: string): Promise<ManncoDepositStatus> {
        return this.request<ManncoDepositStatus>('get', `/deposit/tradeStatus/${tradeId}`);
    }

    async listInventory(assetIds: string[], price: number): Promise<unknown> {
        if (!Number.isSafeInteger(price) || price <= 0) {
            throw new Error('Mannco.store listing price must be a positive integer number of cents');
        }

        if (assetIds.length === 0) {
            throw new Error('At least one Mannco.store inventory asset is required');
        }

        return this.request<unknown>('post', '/inventory/price', {
            ids: assetIds.join(','),
            price
        });
    }

    /** Wait for a deposit, list its assets, then retain the SKU-to-asset mapping for repricing. */
    async depositAndList(sku: string, assets: ManncoDepositAsset[], price: number): Promise<ManncoDepositTrade> {
        const prices: Record<string, number> = {};
        const depositKeys: Record<string, string> = {};

        for (const asset of assets) {
            prices[asset.assetid] = price;
            depositKeys[asset.assetid] = asset.depositkey;
        }

        const assetIds = assets.map(asset => asset.assetid);
        this.pendingDepositAssetIds.push(assetIds);

        let trade: ManncoDepositTrade;
        try {
            trade = await this.createDepositTrade(prices, depositKeys);
        } catch (err) {
            this.removePendingDeposit(assetIds);
            throw err;
        }
        const completed = await this.waitForDepositCompletion(trade.id);
        if (!completed) {
            this.removePendingDeposit(assetIds);
            throw new Error(`Mannco.store deposit ${trade.id} did not complete`);
        }

        await this.listInventory(assetIds, price);
        this.listedAssetsBySku.set(sku, assetIds);
        this.emit('listingCreated', { sku, assetIds, price, tradeId: trade.id });
        return trade;
    }

    /** Only accepts an incoming offer when it contains precisely a bot-initiated deposit's assets. */
    matchesPendingDepositOffer(offer: {
        itemsToGive: Array<{ assetid: string }>;
        itemsToReceive: unknown[];
    }): boolean {
        if (offer.itemsToReceive.length !== 0) {
            return false;
        }

        const offerAssetIds = offer.itemsToGive.map(item => item.assetid).sort();
        const index = this.pendingDepositAssetIds.findIndex(assetIds => {
            const expected = assetIds.slice().sort();
            return expected.length === offerAssetIds.length && expected.every((assetId, i) => assetId === offerAssetIds[i]);
        });

        if (index === -1) {
            return false;
        }

        this.pendingDepositAssetIds.splice(index, 1);
        return true;
    }

    private removePendingDeposit(assetIds: string[]): void {
        const index = this.pendingDepositAssetIds.findIndex(
            pending => pending.length === assetIds.length && pending.every(assetId => assetIds.includes(assetId))
        );
        if (index !== -1) {
            this.pendingDepositAssetIds.splice(index, 1);
        }
    }

    /** Update already-listed Mannco assets when their pricelist USD sell price changes. */
    async repriceSku(sku: string, price: number): Promise<void> {
        const assetIds = this.listedAssetsBySku.get(sku);
        if (!assetIds || assetIds.length === 0) {
            return;
        }

        await this.listInventory(assetIds, price);
        this.emit('listingUpdated', { sku, assetIds, price });
    }

    async resolveItemByName(name: string): Promise<{ itemId: number; name: string }> {
        const items = await this.getItemPrices();
        const matches = items.filter(item => item.name.toLowerCase() === name.toLowerCase());
        if (matches.length === 0) {
            throw new Error(`No Mannco.store item exactly matches "${name}"`);
        }
        if (matches.length > 1) {
            throw new Error(`Mannco.store returned multiple items named "${name}"`);
        }

        const details = await this.request<ManncoItemDetails>('get', `/item/details/${encodeURIComponent(matches[0].url)}`);
        return { itemId: details.informations.id, name: details.informations.name };
    }

    async upsertBuyOrder(sku: string, itemId: number, amount: number, value: number): Promise<void> {
        if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(amount) || amount < 1 || amount > 5000) {
            throw new Error('Mannco.store buy-order item ID and amount are invalid');
        }
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error('Mannco.store buy-order value must be a positive integer number of cents');
        }

        const key = `${itemId}:${amount}:${value}`;
        if (this.buyOrderValuesBySku.get(sku) === key) {
            return;
        }

        await this.request('post', '/item/buyorder/bulk', {
            orders: [{ itemid: itemId, value, amount }]
        });
        this.buyOrderValuesBySku.set(sku, key);
        this.emit('buyOrderUpdated', { sku, itemId, amount, value });
    }

    private async getItemPrices(): Promise<ManncoPriceItem[]> {
        if (this.itemPrices !== null && Date.now() < this.itemPricesExpiresAt) {
            return this.itemPrices;
        }

        this.itemPrices = await this.request<ManncoPriceItem[]>('get', '/item/prices?game=440&outofstock=1');
        this.itemPricesExpiresAt = Date.now() + 5 * 60 * 1000;
        return this.itemPrices;
    }

    private async waitForDepositCompletion(tradeId: string): Promise<boolean> {
        const deadline = Date.now() + 15 * 60 * 1000;
        while (Date.now() < deadline) {
            const status = await this.getDepositTradeStatus(tradeId);
            if (status === 3) {
                return true;
            }
            if (status === -1) {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        return false;
    }

    private async login(): Promise<void> {
        try {
            const response = await this.api.post<ManncoResponse<{ jwt: string }>>('/user/login', { apiKey: this.apiKey });
            if (!response.data.success || !response.data.content?.jwt) {
                throw new Error(response.data.message || 'Mannco.store login failed');
            }

            this.jwt = response.data.content.jwt;
        } catch (err) {
            throw filterAxiosError(err as AxiosError);
        }
    }

    private async request<T>(method: 'get' | 'post', path: string, data?: unknown, retry = true): Promise<T> {
        if (!this.jwt) {
            await this.login();
        }

        try {
            const response = await this.api.request<ManncoResponse<T>>({
                method,
                url: path,
                data,
                headers: { Authorization: `Bearer ${this.jwt}` }
            });

            if (!response.data.success) {
                throw new Error(response.data.message || `Mannco.store API request failed (${response.data.err})`);
            }

            return response.data.content;
        } catch (err) {
            const status = (err as AxiosError).response?.status;
            if (retry && status === 401) {
                this.jwt = null;
                await this.login();
                return this.request<T>(method, path, data, false);
            }

            const filtered = filterAxiosError(err as AxiosError);
            this.emit('error', filtered);
            throw filtered;
        }
    }
}
