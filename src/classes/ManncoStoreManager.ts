import axios, { AxiosError, AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import filterAxiosError from '@tf2autobot/filter-axios-error';
import log from '../lib/logger';
import * as files from '../lib/files';

interface ManncoResponse<T> {
    err: number;
    success: boolean;
    content: T;
    message?: string;
}

export interface ManncoDepositAsset {
    assetid: string;
    depositkey: string;
    itemId: number;
}

interface ManncoDepositInformation {
    informations: Array<{
        assetid: string;
        depositkey: Record<string, string>;
        item_id: number;
    }>;
}

interface ManncoPriceItem {
    name: string;
    url: string;
    craftable: number;
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

export interface ManncoOnSaleItem {
    ids: string;
    count: number;
    item_id: number;
    state: 1;
    price: number;
    name: string;
    game: number;
}

export interface ManncoPricelistItem {
    sku: string;
    name: string;
    craftable: boolean;
}

export interface ManncoSalesHistory {
    values: unknown[];
    count: number;
}

export interface ManncoListingReconciliation {
    importedSkus: string[];
    noLongerOnSaleSkus: string[];
}

interface ManncoInventoryItem {
    ids: string;
    item_id: number;
}

interface ManncoStoreData {
    listings: Record<string, { assetIds: string[]; slug?: string }>;
    buyOrders: Record<string, { itemId: number; amount: number; name: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManncoStoreData(value: unknown): value is ManncoStoreData {
    if (!isRecord(value) || !isRecord(value.listings) || !isRecord(value.buyOrders)) {
        return false;
    }

    const hasValidListings = Object.values(value.listings).every(
        listing =>
            isRecord(listing) &&
            Array.isArray(listing.assetIds) &&
            listing.assetIds.every(assetId => typeof assetId === 'string')
    );
    const hasValidBuyOrders = Object.values(value.buyOrders).every(
        order =>
            isRecord(order) &&
            typeof order.itemId === 'number' &&
            typeof order.amount === 'number' &&
            typeof order.name === 'string'
    );

    return hasValidListings && hasValidBuyOrders;
}

/** Mannco.store omits TF2's Non-Craftable prefix from item names. */
function normaliseListingName(name: string): string {
    return name.trim().toLowerCase().replace(/^non-craftable\s+/, '');
}

function manncoSlug(item: ManncoPricelistItem): string {
    const name = normaliseListingName(item.name)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `440-${item.craftable ? '' : 'uncraftable-'}${name}`;
}

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

    private itemPricesRetryAt = 0;

    private readonly itemDetailsBySlug = new Map<string, ManncoItemDetails>();

    private data: ManncoStoreData = { listings: {}, buyOrders: {} };

    private readonly pendingDepositAssetIds: string[][] = [];

    constructor(private readonly apiKey: string, private readonly dataPath: string) {
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
        const data: unknown = await files.readFile(this.dataPath, true);
        if (isManncoStoreData(data)) {
            this.data = data;
        }
        await this.login();
        log.debug('Mannco.store manager initialised');
    }

    async getDepositableAssets(game = 440): Promise<ManncoDepositAsset[]> {
        const depositInformation = await this.request<ManncoDepositInformation>('get', `/deposit/${game}`);

        return depositInformation.informations.flatMap(information =>
            information.assetid
                .split(';')
                .filter(assetid => assetid.length > 0 && information.depositkey[assetid] !== undefined)
                .map(assetid => ({
                    assetid,
                    depositkey: information.depositkey[assetid],
                    itemId: information.item_id
                }))
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

    async getOnSaleItems(): Promise<ManncoOnSaleItem[]> {
        const content = await this.request<{ items: ManncoOnSaleItem[] }>('get', '/inventory/onSale');
        return content.items || [];
    }

    async getBalance(): Promise<number> {
        const content = await this.request<{ balance: number }>('get', '/user/balance');
        if (!Number.isSafeInteger(content.balance) || content.balance < 0) {
            throw new Error('Mannco.store returned an invalid balance');
        }

        return content.balance;
    }

    async getSalesHistory(page = 0, limit = 10): Promise<ManncoSalesHistory> {
        const content = await this.request<ManncoSalesHistory>(
            'get',
            `/user/getSalesHistory?page=${page}&perpage=${limit}&range=1W`
        );
        return { values: Array.isArray(content.values) ? content.values : [], count: content.count || 0 };
    }

    private async getInventoryItems(): Promise<ManncoInventoryItem[]> {
        const content = await this.request<{ items: ManncoInventoryItem[] }>('get', '/inventory/onInventory');
        return content.items || [];
    }

    async withdrawInventory(assetIds: string[]): Promise<unknown> {
        if (assetIds.length === 0) {
            throw new Error('At least one Mannco.store inventory asset is required');
        }

        const response = await this.request<unknown>('post', '/inventory/withdraw', { ids: assetIds.join(',') });
        this.removeListingAssets(assetIds);
        return response;
    }

    registerListingAssets(sku: string, assetIds: string[]): void {
        this.listedAssetsBySku.set(sku, assetIds);
        this.data.listings[sku] = { assetIds };
        void this.saveData();
    }

    private removeListingAssets(assetIds: string[]): void {
        let changed = false;
        for (const sku of Object.keys(this.data.listings)) {
            const remaining = this.data.listings[sku].assetIds.filter(assetId => !assetIds.includes(assetId));
            if (remaining.length === this.data.listings[sku].assetIds.length) continue;

            changed = true;
            if (remaining.length === 0) {
                delete this.data.listings[sku];
                this.listedAssetsBySku.delete(sku);
            } else {
                this.data.listings[sku].assetIds = remaining;
                this.listedAssetsBySku.set(sku, remaining);
            }
        }
        if (changed) void this.saveData();
    }

    /** Wait for a deposit, list its assets, then retain the SKU-to-asset mapping for repricing. */
    async depositAndList(sku: string, assets: ManncoDepositAsset[], price: number): Promise<ManncoDepositTrade> {
        const prices: Record<string, number> = {};
        const depositKeys: Record<string, string> = {};

        for (const asset of assets) {
            prices[asset.assetid] = price;
            depositKeys[asset.assetid] = asset.depositkey;
        }

        const steamAssetIds = assets.map(asset => asset.assetid);
        this.pendingDepositAssetIds.push(steamAssetIds);
        const inventoryBefore = await this.getInventoryItems();

        let trade: ManncoDepositTrade;
        try {
            trade = await this.createDepositTrade(prices, depositKeys);
        } catch (err) {
            this.removePendingDeposit(steamAssetIds);
            throw err;
        }
        const completed = await this.waitForDepositCompletion(trade.id);
        if (!completed) {
            this.removePendingDeposit(steamAssetIds);
            throw new Error(`Mannco.store deposit ${trade.id} did not complete`);
        }

        const manncoAssetIds = this.findNewManncoAssetIds(inventoryBefore, await this.getInventoryItems(), assets);
        if (manncoAssetIds.length !== assets.length) {
            log.warn(`Could not uniquely map all deposited Mannco.store assets for ${sku}; automatic repricing is disabled for them`);
        } else {
            await this.listInventory(manncoAssetIds, price);
            this.registerListingAssets(sku, manncoAssetIds);
        }
        this.emit('listingCreated', { sku, assetIds: manncoAssetIds, price, tradeId: trade.id });
        return trade;
    }

    private findNewManncoAssetIds(
        inventoryBefore: ManncoInventoryItem[],
        inventoryAfter: ManncoInventoryItem[],
        depositedAssets: ManncoDepositAsset[]
    ): string[] {
        const beforeIds = new Set(inventoryBefore.flatMap(item => item.ids.split(';')));
        const depositedItemIds = new Set(depositedAssets.map(asset => asset.itemId));
        return inventoryAfter
            .filter(item => depositedItemIds.has(item.item_id))
            .flatMap(item => item.ids.split(';'))
            .filter(assetId => assetId.length > 0 && !beforeIds.has(assetId));
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
    async repriceSku(sku: string, price: number, pricelistItem?: ManncoPricelistItem): Promise<void> {
        let assetIds = this.listedAssetsBySku.get(sku) || this.data.listings[sku]?.assetIds;
        if ((!assetIds || assetIds.length === 0) && pricelistItem) {
            assetIds = await this.findAndRegisterOnSaleAssets(pricelistItem);
        }
        if (!assetIds || assetIds.length === 0) {
            return;
        }

        await this.listInventory(assetIds, price);
        this.emit('listingUpdated', { sku, assetIds, price });
    }

    /**
     * A price update must not depend on startup reconciliation having already
     * completed. Resolve the SKU's canonical Mannco slug and verify the item ID
     * returned for every currently on-sale asset before recording it.
     */
    private async findAndRegisterOnSaleAssets(pricelistItem: ManncoPricelistItem): Promise<string[]> {
        const slug = manncoSlug(pricelistItem);
        let details: ManncoItemDetails;
        try {
            details = await this.getItemDetails(slug, true);
        } catch {
            return [];
        }

        const assetIds = (await this.getOnSaleItems())
            .filter(item => item.game === 440 && item.item_id === details.informations.id)
            .flatMap(item => item.ids.split(/[;,]/))
            .filter(assetId => assetId.length > 0);
        if (assetIds.length > 0) {
            this.listedAssetsBySku.set(pricelistItem.sku, assetIds);
            this.data.listings[pricelistItem.sku] = { assetIds, slug };
            await this.saveData();
        }

        return assetIds;
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

    async upsertBuyOrder(sku: string, itemId: number, amount: number, value: number, name?: string): Promise<void> {
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
        this.data.buyOrders[sku] = { itemId, amount, name: name || this.data.buyOrders[sku]?.name || sku };
        await this.saveData();
        this.emit('buyOrderUpdated', { sku, itemId, amount, value });
    }

    getBuyOrder(sku: string): { itemId: number; amount: number; name: string } | undefined {
        return this.data.buyOrders[sku];
    }

    /**
     * Preserve current Mannco inventory IDs separately from the pricelist.
     * Existing listings are imported only where an exact item name identifies one
     * pricelist SKU; this avoids automatically repricing an ambiguous listing.
     */
    async reconcileListings(
        onSaleItems: ManncoOnSaleItem[],
        pricelistItems: ManncoPricelistItem[] = []
    ): Promise<ManncoListingReconciliation> {
        const onSaleAssetIds = new Set(
            onSaleItems.flatMap(item => item.ids.split(/[;,]/).filter(assetId => assetId.length > 0))
        );
        let changed = false;
        const noLongerOnSaleSkus: string[] = [];
        for (const sku of Object.keys(this.data.listings)) {
            const assetIds = this.data.listings[sku].assetIds.filter(assetId => onSaleAssetIds.has(assetId));
            if (assetIds.length === 0) {
                delete this.data.listings[sku];
                this.listedAssetsBySku.delete(sku);
                changed = true;
                noLongerOnSaleSkus.push(sku);
            } else {
                if (assetIds.length !== this.data.listings[sku].assetIds.length) {
                    this.data.listings[sku].assetIds = assetIds;
                    changed = true;
                    noLongerOnSaleSkus.push(sku);
                }
                this.listedAssetsBySku.set(sku, assetIds);
            }
        }

        const importedSkus = new Set<string>();
        const skuByAssetId = new Map<string, string>();
        for (const [sku, listing] of Object.entries(this.data.listings)) {
            for (const assetId of listing.assetIds) {
                skuByAssetId.set(assetId, sku);
            }
        }

        for (const item of onSaleItems) {
            if (item.game !== 440) continue;

            const match = await this.findPricelistMatch(item, pricelistItems);
            if (match === null) continue;

            const { sku, slug } = match;
            const assetIds = item.ids.split(/[;,]/).filter(assetId => assetId.length > 0);
            const safeAssetIds = assetIds.filter(assetId => {
                const owner = skuByAssetId.get(assetId);
                return owner === undefined || owner === sku;
            });
            if (safeAssetIds.length === 0) continue;

            const listing = this.data.listings[sku] || { assetIds: [] };
            const merged = [...new Set([...listing.assetIds, ...safeAssetIds])];
            if (merged.length !== listing.assetIds.length || listing.slug !== slug || !this.data.listings[sku]) {
                this.data.listings[sku] = { assetIds: merged, slug };
                this.listedAssetsBySku.set(sku, merged);
                safeAssetIds.forEach(assetId => skuByAssetId.set(assetId, sku));
                importedSkus.add(sku);
                changed = true;
            }
        }

        if (changed) await this.saveData();
        if (noLongerOnSaleSkus.length > 0) {
            this.emit('listingsNoLongerOnSale', noLongerOnSaleSkus);
        }
        return { importedSkus: [...importedSkus], noLongerOnSaleSkus };
    }

    /** Resolve Mannco's canonical slug, then verify its internal item ID before importing a listing. */
    private async findPricelistMatch(
        onSaleItem: ManncoOnSaleItem,
        pricelistItems: ManncoPricelistItem[]
    ): Promise<{ sku: string; slug: string } | null> {
        const matchingPricelistItems = pricelistItems.filter(
            item => normaliseListingName(item.name) === normaliseListingName(onSaleItem.name)
        );
        if (matchingPricelistItems.length === 0) return null;

        const matches: Array<{ sku: string; slug: string }> = [];
        for (const pricelistItem of matchingPricelistItems) {
            const slug = manncoSlug(pricelistItem);
            try {
                const details = await this.getItemDetails(slug, true);
                if (details.informations.id === onSaleItem.item_id) {
                    matches.push({ sku: pricelistItem.sku, slug });
                }
            } catch {
                // A listing with a non-standard Mannco slug remains unmanaged.
            }
        }

        return matches.length === 1 ? matches[0] : null;
    }

    private saveData(): Promise<void> {
        return files.writeFile(this.dataPath, this.data, true).catch(err => {
            log.warn('Failed to save Mannco.store data:', err);
        });
    }

    private async getItemPrices(): Promise<ManncoPriceItem[]> {
        if (this.itemPrices !== null && Date.now() < this.itemPricesExpiresAt) {
            return this.itemPrices;
        }

        if (Date.now() < this.itemPricesRetryAt) {
            throw new Error('Mannco.store item catalogue is rate limited; reconciliation will retry automatically');
        }

        try {
            this.itemPrices = await this.request<ManncoPriceItem[]>('get', '/item/prices?game=440&outofstock=1');
            this.itemPricesExpiresAt = Date.now() + 5 * 60 * 1000;
            return this.itemPrices;
        } catch (err) {
            const status = (err as AxiosError).response?.status;
            if (status === 429) {
                this.itemPricesRetryAt = Date.now() + 5 * 60 * 1000;
            }
            throw err;
        }
    }

    private async getItemDetails(slug: string, suppressError = false): Promise<ManncoItemDetails> {
        const cached = this.itemDetailsBySlug.get(slug);
        if (cached) return cached;

        const details = await this.request<ManncoItemDetails>(
            'get',
            `/item/details/${encodeURIComponent(slug)}`,
            undefined,
            true,
            !suppressError
        );
        this.itemDetailsBySlug.set(slug, details);
        return details;
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

    private async request<T>(
        method: 'get' | 'post',
        path: string,
        data?: unknown,
        retry = true,
        emitError = true
    ): Promise<T> {
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
                return this.request<T>(method, path, data, false, emitError);
            }

            const filtered = filterAxiosError(err as AxiosError);
            if (emitError) {
                this.emit('error', filtered);
            }
            throw filtered;
        }
    }
}
