import axios, { AxiosError, AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import filterAxiosError from '@tf2autobot/filter-axios-error';
import log from '../lib/logger';
import * as files from '../lib/files';

interface ManncoResponse<T> {
    err: boolean;
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

export interface ManncoDepositTrade {
    id: string | number;
    [key: string]: unknown;
}

export type ManncoDepositStatus = -1 | 0 | 3;

interface ManncoDepositStatusTrade {
    id?: string | number;
    status?: ManncoDepositStatus;
    items_received?: string;
    item_to_received?: string;
    state?: number;
    game?: number;
    offerid?: string | number;
}

interface ManncoDepositStatusResponse {
    trade?: ManncoDepositStatusTrade & { trade?: ManncoDepositStatusTrade };
}

export interface ManncoOperation {
    id: string;
    type: 'deposit' | 'withdrawal';
    status: 'creating' | 'pending' | 'matched' | 'accepted' | 'completed' | 'failed';
    createdAt: number;
    expectedSteamAssetIds: string[];
    manncoAssetIds: string[];
    sku?: string;
    price?: number;
    offerId?: string;
    lastError?: string;
}

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
    sellUsd?: number;
}

export interface ManncoSalesHistory {
    values: unknown[];
    count: number;
}

export interface ManncoBuyOrder {
    id: number;
    itemid: number;
    price: number;
    amount: number;
    name: string;
    game: number;
}

export interface ManncoListingReconciliation {
    importedSkus: string[];
    noLongerOnSaleSkus: string[];
}

interface ManncoInventoryItem {
    ids: string;
    item_id: number;
}

interface ManncoTrade {
    id?: string | number;
    status: ManncoDepositStatus;
    offerid?: string;
    game: number;
    items_received?: string;
    items_send?: string;
}

interface ManncoWithdrawResponse {
    message: string;
    updated: number;
    locked: number;
}

interface ManncoStoreData {
    listings: Record<string, { assetIds: string[] }>;
    buyOrders: Record<string, { itemId: number; amount: number; name: string }>;
    manncoItems: Record<string, number>;
    operations: Record<string, ManncoOperation>;
}

interface PriceDbManncoItem {
    sku: string;
    manncoId: number;
}

const MANNCO_PRICEDB_API_URL = 'https://pricedb.io/api';

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

    const hasValidManncoItems =
        value.manncoItems === undefined ||
        (isRecord(value.manncoItems) &&
            Object.values(value.manncoItems).every(
                itemId => typeof itemId === 'number' && Number.isSafeInteger(itemId) && itemId > 0
            ));

    const hasValidOperations =
        value.operations === undefined ||
        (isRecord(value.operations) &&
            Object.values(value.operations).every(
                operation =>
                    isRecord(operation) &&
                    typeof operation.id === 'string' &&
                    (operation.type === 'deposit' || operation.type === 'withdrawal') &&
                    Array.isArray(operation.expectedSteamAssetIds) &&
                    Array.isArray(operation.manncoAssetIds)
            ));

    return hasValidListings && hasValidBuyOrders && hasValidManncoItems && hasValidOperations;
}

/**
 * Mannco.store API client. Deposits intentionally remain a separate workflow
 * from Backpack.tf listings because an accepted deposit transfers ownership.
 */
export default class ManncoStoreManager extends EventEmitter {
    private readonly api: AxiosInstance;

    private readonly priceDbApi: AxiosInstance;

    private jwt: string | null = null;

    private readonly listedAssetsBySku = new Map<string, string[]>();

    private readonly buyOrderValuesBySku = new Map<string, string>();

    private data: ManncoStoreData = { listings: {}, buyOrders: {}, manncoItems: {}, operations: {} };

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
        this.priceDbApi = axios.create({
            baseURL: MANNCO_PRICEDB_API_URL,
            timeout: 30000,
            headers: { 'User-Agent': `TF2AutobotPriceDB@${process.env.BOT_VERSION}` }
        });
    }

    async init(): Promise<void> {
        const data: unknown = await files.readFile(this.dataPath, true);
        if (isManncoStoreData(data)) {
            this.data = {
                listings: data.listings,
                buyOrders: data.buyOrders,
                manncoItems: data.manncoItems || {},
                operations: data.operations || {}
            };
        }
        await this.login();
        try {
            await this.reconcileOperations();
        } catch (err) {
            log.warn('Could not restore pending Mannco.store withdrawals:', err);
        }
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

    async getDepositTradeStatus(tradeId: string): Promise<ManncoDepositStatusResponse> {
        const content = await this.request<ManncoDepositStatusResponse>('get', `/deposit/tradeStatus/${tradeId}`);
        if (!content.trade) {
            throw new Error(`Mannco.store returned an invalid status for deposit ${tradeId}`);
        }

        // Mannco creates the outer deposit record before it creates the nested
        // Steam trade. This is a valid pending state, not an API error.
        const hasSteamTrade = content.trade.trade !== undefined;
        const trade = content.trade.trade || content.trade;
        if (!hasSteamTrade && trade.status === undefined) return { trade: { ...trade, status: 0 } };
        if (![-1, 0, 3].includes(trade.status))
            throw new Error(`Mannco.store returned an invalid status for deposit ${tradeId}`);

        const manncoAssetIds = this.getManncoAssetIds(trade.item_to_received);
        return {
            trade: {
                ...trade,
                // Nested responses expose the original Steam IDs in items_received.
                // Prefer the replacement Mannco inventory IDs when available.
                items_received: manncoAssetIds.join(',') || trade.items_received
            }
        };
    }

    async listInventory(assetIds: string[], price: number): Promise<unknown> {
        if (!Number.isSafeInteger(price) || price < 1 || price > 5000000) {
            throw new Error('Mannco.store listing price must be a whole number from 1 to 5000000 cents');
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

    private async areAssetsOnSale(assetIds: string[]): Promise<boolean> {
        const onSaleAssetIds = new Set((await this.getOnSaleItems()).flatMap(item => this.splitAssetIds(item.ids)));
        return assetIds.every(assetId => onSaleAssetIds.has(assetId));
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

    async getBuyOrders(page = 0): Promise<ManncoBuyOrder[]> {
        if (!Number.isSafeInteger(page) || page < 0) {
            throw new Error('Mannco.store buy-order page must be a non-negative whole number');
        }

        const content = await this.request<{ values: ManncoBuyOrder[] }>(
            'get',
            `/user/getBuyorder?page=${page}&count=50`
        );
        return content.values || [];
    }

    async removeBuyOrder(itemId: number): Promise<void> {
        if (!Number.isSafeInteger(itemId) || itemId <= 0) {
            throw new Error('Mannco.store buy-order item ID is invalid');
        }

        await this.request('post', '/item/buyorder/remove', { itemid: itemId });
        let changed = false;
        for (const [sku, buyOrder] of Object.entries(this.data.buyOrders)) {
            if (buyOrder.itemId !== itemId) continue;

            delete this.data.buyOrders[sku];
            this.buyOrderValuesBySku.delete(sku);
            changed = true;
        }
        if (changed) await this.saveData();
    }

    private async getInventoryItems(): Promise<ManncoInventoryItem[]> {
        const content = await this.request<{ items: ManncoInventoryItem[] }>('get', '/inventory/onInventory');
        return content.items || [];
    }

    async withdrawInventory(assetIds: string[]): Promise<ManncoWithdrawResponse> {
        if (assetIds.length === 0) {
            throw new Error('At least one Mannco.store inventory asset is required');
        }

        const response = await this.request<ManncoWithdrawResponse>('post', '/inventory/withdraw', {
            ids: assetIds.join(',')
        });
        if (!Number.isSafeInteger(response.updated) || response.updated === 0) {
            throw new Error('Mannco.store did not find a withdrawable item with that asset ID');
        }
        this.removeListingAssets(assetIds);
        const operation = this.createOperation('withdrawal', assetIds);
        operation.status = 'pending';
        await this.saveData();
        await this.reconcileOperations();
        return response;
    }

    /** Restore and refresh persisted operations after startup and while the bot is running. */
    async reconcileOperations(): Promise<void> {
        // Active trades let us match a newly-arrived Steam offer, while the
        // complete history is the authoritative source after Steam accepts it.
        // A withdrawal can otherwise be accepted as a normal gift before its
        // Mannco offer ID has been recorded, leaving it pending forever.
        const [content, history] = await Promise.all([
            this.request<{ trades: ManncoTrade[] }>('get', '/trades/active'),
            this.request<{ trades: ManncoTrade[] }>('get', '/trades/all')
        ]);
        const activeTrades = (content.trades || []).filter(trade => trade.game === 440 && trade.status === 0);
        const tradeHistory = (history.trades || []).filter(trade => trade.game === 440);
        let changed = false;

        for (const operation of Object.values(this.data.operations)) {
            if (operation.status === 'completed' || operation.status === 'failed') continue;

            if (operation.type === 'deposit' && /^deposit:\d+$/.test(operation.id)) {
                try {
                    const status = await this.getDepositTradeStatus(operation.id.slice('deposit:'.length));
                    const trade = status.trade;
                    if (trade.items_received) {
                        operation.manncoAssetIds = this.splitAssetIds(trade.items_received);
                    }
                    if (trade.offerid) operation.offerId = String(trade.offerid);
                    if (trade.status === -1) operation.status = 'failed';
                    if (trade.status === 3) {
                        if (
                            operation.sku &&
                            operation.price !== undefined &&
                            operation.manncoAssetIds.length === operation.expectedSteamAssetIds.length
                        ) {
                            if (!(await this.areAssetsOnSale(operation.manncoAssetIds)))
                                await this.listInventory(operation.manncoAssetIds, operation.price);
                            this.registerListingAssets(operation.sku, operation.manncoAssetIds);
                        }
                        operation.status = 'completed';
                        operation.lastError = undefined;
                    }
                    changed = true;
                } catch (err) {
                    operation.lastError = (err as Error).message;
                    changed = true;
                }
            }

            if (operation.type === 'withdrawal') {
                const relatedTrade = [...activeTrades, ...tradeHistory].find(trade => {
                    if (typeof trade.offerid === 'string' && this.isOfferTracked(trade.offerid)) {
                        return trade.offerid === operation.offerId;
                    }
                    const assetIds = this.splitAssetIds(`${trade.items_received || ''},${trade.items_send || ''}`);
                    return (
                        assetIds.length > 0 &&
                        operation.expectedSteamAssetIds.every(assetId => assetIds.includes(assetId))
                    );
                });

                if (relatedTrade) {
                    if (relatedTrade.offerid && operation.offerId !== relatedTrade.offerid) {
                        operation.offerId = relatedTrade.offerid;
                        changed = true;
                    }
                    if (relatedTrade.status === 3 && operation.status !== 'completed') {
                        operation.status = 'completed';
                        operation.lastError = undefined;
                        changed = true;
                    } else if (relatedTrade.status === -1 && operation.status !== 'failed') {
                        operation.status = 'failed';
                        operation.lastError = 'Mannco.store reported that the withdrawal trade failed';
                        changed = true;
                    } else if (relatedTrade.status === 0 && !['matched', 'accepted'].includes(operation.status)) {
                        operation.status = 'pending';
                        changed = true;
                    }
                }
            }
        }
        if (changed) await this.saveData();
    }

    async resendTrade(tradeId: number): Promise<void> {
        if (!Number.isSafeInteger(tradeId) || tradeId <= 0) {
            throw new Error('Mannco.store trade ID must be a positive whole number');
        }
        await this.request('get', `/trade/resend?id=${tradeId}`);
    }

    getOperations(): ManncoOperation[] {
        return Object.values(this.data.operations).sort((a, b) => b.createdAt - a.createdAt);
    }

    private createOperation(type: ManncoOperation['type'], expectedSteamAssetIds: string[]): ManncoOperation {
        const id = `${type}:creating:${Date.now()}:${randomUUID()}`;
        const operation: ManncoOperation = {
            id,
            type,
            status: 'creating',
            createdAt: Date.now(),
            expectedSteamAssetIds: [...expectedSteamAssetIds],
            manncoAssetIds: []
        };
        this.data.operations[id] = operation;
        return operation;
    }

    private isOfferTracked(offerId: string): boolean {
        return Object.values(this.data.operations).some(operation => operation.offerId === offerId);
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
        const operation = this.createOperation('deposit', steamAssetIds);
        operation.sku = sku;
        operation.price = price;
        await this.saveData();
        const inventoryBefore = await this.getInventoryItems();

        let trade: ManncoDepositTrade;
        try {
            trade = await this.createDepositTrade(prices, depositKeys);
        } catch (err) {
            operation.status = 'failed';
            operation.lastError = (err as Error).message;
            await this.saveData();
            throw err;
        }
        delete this.data.operations[operation.id];
        operation.id = `deposit:${trade.id}`;
        operation.status = 'pending';
        this.data.operations[operation.id] = operation;
        await this.saveData();

        const status = await this.waitForDepositCompletion(String(trade.id));
        if (status.status !== 3) {
            operation.status = 'failed';
            operation.lastError = `Mannco.store deposit ${trade.id} did not complete`;
            await this.saveData();
            throw new Error(`Mannco.store deposit ${trade.id} did not complete`);
        }

        const manncoAssetIds =
            status.items_received.length > 0
                ? status.items_received
                : this.findNewManncoAssetIds(inventoryBefore, await this.getInventoryItems(), assets);
        operation.manncoAssetIds = manncoAssetIds;
        if (manncoAssetIds.length !== assets.length) {
            log.warn(
                `Could not uniquely map all deposited Mannco.store assets for ${sku}; automatic repricing is disabled for them`
            );
        } else {
            if (!(await this.areAssetsOnSale(manncoAssetIds))) await this.listInventory(manncoAssetIds, price);
            this.registerListingAssets(sku, manncoAssetIds);
            const itemIds = [...new Set(assets.map(asset => asset.itemId))];
            if (itemIds.length === 1) {
                this.data.manncoItems[sku] = itemIds[0];
                await this.saveData();
            }
        }
        operation.status = 'completed';
        await this.saveData();
        this.emit('listingCreated', { sku, assetIds: manncoAssetIds, price, tradeId: trade.id });
        return trade;
    }

    private findNewManncoAssetIds(
        inventoryBefore: ManncoInventoryItem[],
        inventoryAfter: ManncoInventoryItem[],
        depositedAssets: ManncoDepositAsset[]
    ): string[] {
        const beforeIds = new Set(inventoryBefore.flatMap(item => this.splitAssetIds(item.ids)));
        const depositedItemIds = new Set(depositedAssets.map(asset => asset.itemId));
        return inventoryAfter
            .filter(item => depositedItemIds.has(item.item_id))
            .flatMap(item => this.splitAssetIds(item.ids))
            .filter(assetId => assetId.length > 0 && !beforeIds.has(assetId));
    }

    /** Only accepts an incoming offer when it contains precisely a persisted bot-initiated deposit's assets. */
    matchesPendingDepositOffer(offer: {
        id?: string;
        itemsToGive: Array<{ assetid: string }>;
        itemsToReceive: unknown[];
    }): boolean {
        if (offer.itemsToReceive.length !== 0) {
            return false;
        }

        const offerAssetIds = offer.itemsToGive.map(item => item.assetid).sort((a, b) => a.localeCompare(b));
        const operation = Object.values(this.data.operations).find(candidate => {
            if (candidate.type !== 'deposit' || !['creating', 'pending', 'matched'].includes(candidate.status))
                return false;
            const expected = candidate.expectedSteamAssetIds.slice().sort((a, b) => a.localeCompare(b));
            return (
                expected.length === offerAssetIds.length && expected.every((assetId, i) => assetId === offerAssetIds[i])
            );
        });

        if (!operation) {
            return false;
        }

        operation.status = 'matched';
        if (offer.id) operation.offerId = String(offer.id);
        void this.saveData();
        return true;
    }

    /** Accept only the exact active Mannco withdrawal offer returned by their trade API. */
    matchesPendingWithdrawalOffer(offer: { id: string; itemsToGive: unknown[]; itemsToReceive: unknown[] }): boolean {
        if (
            offer.itemsToGive.length !== 0 ||
            offer.itemsToReceive.length === 0 ||
            !Object.values(this.data.operations).some(
                operation =>
                    operation.type === 'withdrawal' &&
                    operation.offerId === String(offer.id) &&
                    ['pending', 'matched'].includes(operation.status)
            )
        ) {
            return false;
        }

        const operation = Object.values(this.data.operations).find(candidate => candidate.offerId === String(offer.id));
        if (operation) {
            operation.status = 'matched';
            void this.saveData();
        }
        return true;
    }

    /**
     * A withdrawal offer can arrive between the command's initial reconciliation
     * and the next periodic check. Refresh active trades at offer-arrival time so
     * the offer ID is persisted before the normal gift handler sees it.
     */
    async reconcileAndMatchPendingWithdrawalOffer(offer: {
        id: string;
        itemsToGive: unknown[];
        itemsToReceive: unknown[];
    }): Promise<boolean> {
        const hasPendingWithdrawal = Object.values(this.data.operations).some(
            operation =>
                operation.type === 'withdrawal' &&
                ['pending', 'matched'].includes(operation.status) &&
                !operation.offerId
        );
        if (!hasPendingWithdrawal) return this.matchesPendingWithdrawalOffer(offer);

        await this.reconcileOperations();
        return this.matchesPendingWithdrawalOffer(offer);
    }

    async markOfferAccepted(offerId: string): Promise<void> {
        const operation = Object.values(this.data.operations).find(candidate => candidate.offerId === offerId);
        if (!operation) return;
        operation.offerId = offerId;
        operation.status = 'accepted';
        operation.lastError = undefined;
        await this.saveData();
    }

    async markOfferAcceptanceFailed(offerId: string, err: Error): Promise<void> {
        const operation = Object.values(this.data.operations).find(candidate => candidate.offerId === offerId);
        if (!operation) return;
        operation.offerId = offerId;
        operation.status = 'matched';
        operation.lastError = err.message;
        await this.saveData();
    }

    /** Update already-listed Mannco assets when their pricelist USD sell price changes. */
    async repriceSku(sku: string, price: number): Promise<void> {
        const assetIds = this.listedAssetsBySku.get(sku) || this.data.listings[sku]?.assetIds;
        if (!assetIds || assetIds.length === 0) {
            return;
        }

        await this.listInventory(assetIds, price);
        this.emit('listingUpdated', { sku, assetIds, price });
    }

    /**
     * A price update must not depend on startup reconciliation having already
     * completed. Resolve the SKU through PriceDB and verify the Mannco item ID
     * returned for every currently on-sale asset before recording it.
     */
    private async findAndRegisterOnSaleAssets(pricelistItem: ManncoPricelistItem): Promise<string[]> {
        const itemId = await this.resolveManncoItemId(pricelistItem.sku);

        const assetIds = (await this.getOnSaleItems())
            .filter(item => item.game === 440 && item.item_id === itemId)
            .flatMap(item => item.ids.split(/[;,]/))
            .filter(assetId => assetId.length > 0);
        if (assetIds.length > 0) {
            this.listedAssetsBySku.set(pricelistItem.sku, assetIds);
            this.data.listings[pricelistItem.sku] = { assetIds };
            await this.saveData();
        }

        return assetIds;
    }

    async resolveManncoItemId(sku: string): Promise<number> {
        const cached = this.data.manncoItems[sku];
        if (Number.isSafeInteger(cached) && cached > 0) {
            return cached;
        }

        let response: PriceDbManncoItem;
        try {
            response = (await this.priceDbApi.get<PriceDbManncoItem>(`/mannco/${encodeURIComponent(sku)}`)).data;
        } catch (err) {
            const status = (err as AxiosError).response?.status;
            if (status === 404) {
                throw new Error(`PriceDB has no Mannco mapping for ${sku}`);
            }
            throw new Error(`Could not resolve Mannco mapping for ${sku} from PriceDB`);
        }

        if (response.sku !== sku || !Number.isSafeInteger(response.manncoId) || response.manncoId <= 0) {
            throw new Error(`PriceDB returned an invalid Mannco mapping for ${sku}`);
        }

        this.data.manncoItems[sku] = response.manncoId;
        await this.saveData();
        return response.manncoId;
    }

    async upsertBuyOrder(sku: string, itemId: number, amount: number, value: number, name?: string): Promise<void> {
        if (
            !Number.isSafeInteger(itemId) ||
            itemId <= 0 ||
            !Number.isSafeInteger(amount) ||
            amount < 1 ||
            amount > 5000
        ) {
            throw new Error('Mannco.store buy-order item ID and amount are invalid');
        }
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error('Mannco.store buy-order value must be a positive integer number of cents');
        }

        const key = `${itemId}:${amount}:${value}`;
        if (this.buyOrderValuesBySku.get(sku) === key) {
            return;
        }

        const existingOrder = (await this.getBuyOrders()).some(order => order.itemid === itemId);
        await this.request('post', existingOrder ? '/item/buyorder/update' : '/item/buyorder', {
            itemid: itemId,
            value,
            amount
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
     * Existing listings are imported only where PriceDB resolves one SKU to the
     * exact Mannco item ID; this avoids display-name-based matches.
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

        const skusByManncoItemId = new Map<number, string[]>();
        for (const pricelistItem of pricelistItems) {
            try {
                const itemId = await this.resolveManncoItemId(pricelistItem.sku);
                const skus = skusByManncoItemId.get(itemId) || [];
                skus.push(pricelistItem.sku);
                skusByManncoItemId.set(itemId, skus);
            } catch (err) {
                log.debug(
                    `Could not resolve PriceDB Mannco mapping for ${pricelistItem.sku}: ${(err as Error).message}`
                );
            }
        }

        for (const item of onSaleItems) {
            if (item.game !== 440) continue;

            const matches = skusByManncoItemId.get(item.item_id);
            if (!matches || matches.length !== 1) continue;

            const sku = matches[0];
            const assetIds = item.ids.split(/[;,]/).filter(assetId => assetId.length > 0);
            const safeAssetIds = assetIds.filter(assetId => {
                const owner = skuByAssetId.get(assetId);
                return owner === undefined || owner === sku;
            });
            if (safeAssetIds.length === 0) continue;

            const listing = this.data.listings[sku] || { assetIds: [] };
            const merged = [...new Set([...listing.assetIds, ...safeAssetIds])];
            if (merged.length !== listing.assetIds.length || !this.data.listings[sku]) {
                this.data.listings[sku] = { assetIds: merged };
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

    private saveData(): Promise<void> {
        return files.writeFile(this.dataPath, this.data, true).catch(err => {
            log.warn('Failed to save Mannco.store data:', err);
        });
    }

    private splitAssetIds(ids: string): string[] {
        return ids.split(/[;,]/).filter(assetId => assetId.length > 0);
    }

    private getManncoAssetIds(items: string | undefined): string[] {
        if (!items) return [];
        try {
            const parsed: unknown = JSON.parse(items);
            if (!Array.isArray(parsed)) return [];
            return parsed.flatMap(item => {
                if (isRecord(item) && typeof item.new_assetid === 'string') {
                    return [item.new_assetid];
                }
                return [];
            });
        } catch {
            return [];
        }
    }

    private async waitForDepositCompletion(
        tradeId: string
    ): Promise<{ status: ManncoDepositStatus; items_received: string[] }> {
        const deadline = Date.now() + 15 * 60 * 1000;
        while (Date.now() < deadline) {
            const response = await this.getDepositTradeStatus(tradeId);
            const trade = response.trade;
            if (trade.status === 3) {
                return { status: trade.status, items_received: this.splitAssetIds(trade.items_received || '') };
            }
            if (trade.status === -1) {
                return { status: trade.status, items_received: [] };
            }
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        return { status: -1, items_received: [] };
    }

    private async login(): Promise<void> {
        try {
            const response = await this.api.post<ManncoResponse<{ jwt: string }>>('/user/login', {
                apiKey: this.apiKey
            });
            if (!response.data.success || !response.data.content?.jwt) {
                throw new Error(
                    typeof response.data.content === 'string' ? response.data.content : 'Mannco.store login failed'
                );
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
                const content = response.data.content;
                throw new Error(
                    typeof content === 'string' ? `Mannco.store: ${content}` : 'Mannco.store rejected the request'
                );
            }

            return response.data.content;
        } catch (err) {
            const axiosError = err as AxiosError<ManncoResponse<unknown>>;
            const status = axiosError.response?.status;
            const message = err instanceof Error ? err.message : '';
            const sessionRejected = /need to be connected to access this resource/i.test(message);
            if (retry && (status === 401 || sessionRejected)) {
                this.jwt = null;
                await this.login();
                return this.request<T>(method, path, data, false, emitError);
            }

            if (retry && status === 429) {
                const retryAfter = Number(axiosError.response?.headers?.['retry-after']);
                const delay = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 60) * 1000 : 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.request<T>(method, path, data, false, emitError);
            }

            const content = axiosError.response?.data?.content;
            const apiMessage =
                typeof content === 'string'
                    ? content
                    : typeof axiosError.response?.data?.message === 'string'
                    ? axiosError.response.data.message
                    : null;
            const filtered = apiMessage ? new Error(`Mannco.store: ${apiMessage}`) : filterAxiosError(axiosError);
            if (emitError) {
                this.emit('error', filtered);
            }
            throw filtered;
        }
    }
}
