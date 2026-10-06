import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import Currencies from '../lib/currencies';
import { Agent } from 'https';

export interface NextCritSellAsset {
    assetId: string;
    currencies: Currencies;
}

export interface NextCritPrice {
    keys: number;
    half_scrap: number;
}

export interface NextCritSellListing {
    asset_id: string;
    price: NextCritPrice;
    hat?: string;
}

interface ListingsResponse {
    success: boolean;
    listings: NextCritSellListing[];
}

export class NextCritRequestError extends Error {
    constructor(readonly status: number | undefined, code: string | undefined) {
        super(`NextCrit request failed (${status ?? code ?? 'network error'})`);
    }
}

/** Publishes inventory assets through NextCrit's v2 sell-listing API. */
export default class NextCritDriver {
    private readonly http: AxiosInstance;

    private token = '';

    private tokenExpiresAt = 0;

    private lastInventoryRefresh = 0;

    private queue: Promise<unknown> = Promise.resolve();

    private readonly published = new Map<string, NextCritPrice>();

    constructor(private readonly apiKey: string, baseUrl = 'https://next.crittf.tf', allowSelfSigned = false) {
        if (!apiKey) throw new Error('NextCrit requires an API key');
        this.http = axios.create({
            baseURL: baseUrl,
            timeout: 30000,
            maxRedirects: 0,
            httpsAgent: new Agent({ rejectUnauthorized: !allowSelfSigned })
        });
    }

    createOrUpdateListing(assetId: string, currencies: Currencies, steam64?: string): Promise<void> {
        const price = NextCritDriver.toPrice(currencies);
        NextCritDriver.validateAssetId(assetId);
        return this.enqueue(async () => {
            const previous = this.published.get(assetId);
            if (previous?.keys === price.keys && previous.half_scrap === price.half_scrap) return;
            const config: AxiosRequestConfig = {
                method: 'POST',
                url: '/api/v2/sell-listings',
                data: [{ asset_id: assetId, price }]
            };
            let response: ListingsResponse;
            try {
                response = await this.request<ListingsResponse>(config);
            } catch (err) {
                if (!(err instanceof NextCritRequestError) || err.status !== 404 || !steam64) throw err;
                await this.refreshInventoryNow(steam64);
                response = await this.request<ListingsResponse>(config);
            }
            if (!response.success) throw new Error('NextCrit did not publish the sell listing');
            this.published.set(assetId, price);
        });
    }

    syncSellListings(assets: NextCritSellAsset[], steam64: string): Promise<void> {
        const desired = new Map<string, NextCritSellListing>();
        for (const { assetId, currencies } of assets) {
            NextCritDriver.validateAssetId(assetId);
            if (desired.has(assetId)) throw new Error('Duplicate NextCrit asset ID');
            desired.set(assetId, { asset_id: assetId, price: NextCritDriver.toPrice(currencies) });
        }
        return this.enqueue(async () => {
            const response = await this.request<ListingsResponse>({ method: 'GET', url: '/api/v2/sell-listings/my' });
            if (!response.success || !Array.isArray(response.listings)) {
                throw new Error('NextCrit did not return sell listings');
            }
            const existing = new Map(response.listings.map(listing => [listing.asset_id, listing]));
            const obsolete = response.listings.filter(listing => !desired.has(listing.asset_id));
            if (obsolete.length > 0) {
                const removed = await this.request<{ success: boolean }>({
                    method: 'DELETE',
                    url: '/api/v2/sell-listings',
                    params: { asset_ids: obsolete.map(listing => listing.asset_id).join(',') }
                });
                if (!removed.success) throw new Error('NextCrit did not delete obsolete sell listings');
                for (const listing of obsolete) this.published.delete(listing.asset_id);
            }
            const changed = [...desired.values()].filter(listing => {
                const previous = existing.get(listing.asset_id);
                return (
                    previous?.price.keys !== listing.price.keys ||
                    previous.price.half_scrap !== listing.price.half_scrap
                );
            });
            if (changed.length === 0) return;
            const config: AxiosRequestConfig = { method: 'POST', url: '/api/v2/sell-listings', data: changed };
            let result: ListingsResponse;
            try {
                result = await this.request<ListingsResponse>(config);
            } catch (err) {
                if (!(err instanceof NextCritRequestError) || err.status !== 404) throw err;
                await this.refreshInventoryNow(steam64);
                result = await this.request<ListingsResponse>(config);
            }
            if (!result.success) throw new Error('NextCrit did not publish sell listings');
            for (const listing of changed) this.published.set(listing.asset_id, listing.price);
        });
    }

    getListings(): Promise<NextCritSellListing[]> {
        return this.enqueue(async () => {
            const response = await this.request<ListingsResponse>({ method: 'GET', url: '/api/v2/sell-listings/my' });
            if (!response.success) throw new Error('NextCrit did not return sell listings');
            return response.listings;
        });
    }

    deleteListing(assetId: string): Promise<void> {
        NextCritDriver.validateAssetId(assetId);
        return this.enqueue(async () => {
            const response = await this.request<{ success: boolean }>({
                method: 'DELETE',
                url: '/api/v2/sell-listings',
                params: { asset_ids: assetId }
            });
            if (!response.success) throw new Error('NextCrit did not delete the sell listing');
            this.published.delete(assetId);
        });
    }

    deleteAllListings(): Promise<void> {
        return this.enqueue(async () => {
            const response = await this.request<{ success: boolean }>({
                method: 'DELETE',
                url: '/api/v2/sell-listings/my'
            });
            if (!response.success) throw new Error('NextCrit did not delete sell listings');
            this.published.clear();
        });
    }

    refreshInventory(steam64: string): Promise<void> {
        return this.enqueue(() => this.refreshInventoryNow(steam64));
    }

    static toPrice(currencies: Currencies): NextCritPrice {
        // Refined prices use TF2's truncated decimal notation, e.g. 0.11 ref = one scrap.
        const halfScrap = Currencies.toHalfScrap(currencies.metal);
        if (
            !Number.isInteger(currencies.keys) ||
            currencies.keys < 0 ||
            !Number.isFinite(currencies.metal) ||
            currencies.metal < 0 ||
            halfScrap < 0
        ) {
            throw new Error('Invalid NextCrit sell-listing price');
        }
        return { keys: currencies.keys, half_scrap: halfScrap };
    }

    private async refreshInventoryNow(steam64: string): Promise<void> {
        if (!/^7656119\d{10}$/.test(steam64)) throw new Error('Invalid NextCrit Steam ID');
        if (Date.now() - this.lastInventoryRefresh < 60000) return;
        await this.request({ method: 'GET', url: `/api/v2/inventories/${steam64}/0/refresh` });
        this.lastInventoryRefresh = Date.now();
    }

    private static validateAssetId(assetId: string): void {
        if (!/^[1-9]\d*$/.test(assetId)) {
            throw new Error('Invalid NextCrit asset ID');
        }
    }

    // Keep writes ordered so an earlier publish cannot finish after a deletion.
    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async authenticate(): Promise<void> {
        const response = await this.http.post<{ token: string }>('/api/v2/auth', undefined, {
            headers: { 'X-API-KEY': this.apiKey }
        });
        if (typeof response.data.token !== 'string' || !response.data.token) {
            throw new Error('NextCrit returned an invalid authentication token');
        }
        this.token = response.data.token;
        // NextCrit tokens last 15 minutes; renew with a minute to spare.
        this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
    }

    private async request<T>(config: AxiosRequestConfig): Promise<T> {
        try {
            if (Date.now() >= this.tokenExpiresAt) await this.authenticate();
            try {
                return (await this.http.request<T>({ ...config, headers: { Authorization: `Bearer ${this.token}` } }))
                    .data;
            } catch (err) {
                if (!axios.isAxiosError(err) || err.response?.status !== 401) throw err;
                this.tokenExpiresAt = 0;
                await this.authenticate();
                return (await this.http.request<T>({ ...config, headers: { Authorization: `Bearer ${this.token}` } }))
                    .data;
            }
        } catch (err) {
            // Axios errors include request headers. Never pass API keys or tokens to the logger.
            if (axios.isAxiosError(err)) {
                throw new NextCritRequestError(err.response?.status, err.code);
            }
            throw err;
        }
    }
}
