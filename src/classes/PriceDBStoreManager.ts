import axios, { AxiosInstance, AxiosError } from 'axios';
import Currencies from '@tf2autobot/tf2-currencies';
import { EventEmitter } from 'events';
import { createLogger } from '../lib/logger';
const log = createLogger('PriceDBStoreManager');
import filterAxiosError from '@tf2autobot/filter-axios-error';

/**
 * Wraps a promise and logs a "still waiting" message every `intervalMs` if it has
 * not resolved yet. Clears the interval whether the promise resolves or rejects.
 */
function withProgressLog<T>(label: string, promise: Promise<T>, intervalMs = 20000): Promise<T> {
    const timer = setInterval(() => log.debug(`Waiting for ${label}...`), intervalMs);
    return promise.finally(() => {
        log.debug(`${label} completed`);
        clearInterval(timer);
    });
}

export interface PriceDBListing {
    id?: number;
    steam_id?: string;
    item_name?: string;
    item_image?: string;
    asset_id: string;
    price_keys: number;
    price_metal: string | number; // API returns string, but we may send as number
    quality?: string;
    type?: string;
    unusual_effect?: string | null;
    paint?: string | null;
    spell?: string | null;
    wear?: string | null;
    killstreak_tier?: string | null;
    australium?: boolean;
    strange?: boolean;
    craftable?: boolean;
    tradable?: boolean;
    marketable?: boolean;
    descriptions?: string;
    store_group_id?: number | null;
    created_by_steam_id?: string | null;
    created_at?: string;
    market_name?: string;
    sku?: string;
}

export interface PriceDBListingResponse {
    success: boolean;
    message?: string;
    listing?: PriceDBListing;
    count?: number;
    listings?: PriceDBListing[];
}

export interface PriceDBInventoryResponse {
    success: boolean;
    message?: string;
    count?: number;
    item_count?: number;
    refresh_count?: number;
    from_cache?: boolean;
    cached_at?: string;
    items?: any[];
}

export interface PriceDBUserResponse {
    success: boolean;
    user?: {
        steam_id: string;
        display_name: string;
        avatar_url: string;
        trade_url: string;
        created_at: string;
        rate_limit: number;
    };
}

export interface PriceDBGroupMember {
    id: number;
    store_group_id: number;
    steam_id: string;
    role: 'owner' | 'member';
    invite_status: 'pending' | 'accepted' | 'declined';
    invited_by: string;
    invited_at: string;
    responded_at?: string;
    display_name: string;
    avatar_url: string;
}

export interface PriceDBGroup {
    id: number;
    owner_steam_id: string;
    group_name: string;
    description: string;
    banner_url: string | null;
    links: Array<{
        url: string;
        label: string;
    }>;
    theme_settings: {
        preset: string;
    };
    is_active: boolean;
    view_count: number;
    is_featured: boolean;
    created_at: string;
    updated_at: string;
    custom_store_slug: string | null;
    owner_name: string;
    owner_avatar: string;
    members: PriceDBGroupMember[];
}

export interface PriceDBGroupResponse {
    success: boolean;
    message?: string;
    group?: PriceDBGroup;
}

export interface PriceDBInvite {
    id: number;
    store_group_id: number;
    steam_id: string;
    role: string;
    invite_status: string;
    invited_by: string;
    invited_at: string;
    responded_at: string | null;
    group_name: string;
    description: string;
    banner_url: string | null;
    inviter_name: string;
    inviter_avatar: string;
    owner_name: string;
    owner_avatar: string;
}

export interface PriceDBInvitesResponse {
    success: boolean;
    count: number;
    invites: PriceDBInvite[];
}

export interface PriceDBAcceptInviteResponse {
    success: boolean;
    message: string;
    membership: {
        id: number;
        store_group_id: number;
        steam_id: string;
        role: string;
        invite_status: string;
        invited_by: string;
        invited_at: string;
        responded_at: string;
    };
}

export interface PriceDBInviteCreateResponse {
    success: boolean;
    message: string;
    invite?: {
        id: number;
        group_id: number;
        invitee_steam_id: string;
        status: string;
        created_at: string;
    };
}

interface QueuedRequest {
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
}

export default class PriceDBStoreManager extends EventEmitter {
    private readonly apiKey: string;

    private readonly baseURL: string = 'https://crit.tf/api/v2';

    private axiosInstance: AxiosInstance;

    private steamID: string;

    private listings: Map<string, PriceDBListing> = new Map(); // assetId -> listing

    private lastInventoryRefresh: Date | null = null;

    private storeSlug: string | null = null; // cached store slug from group

    private lastGroupCheckTime = 0; // timestamp of last group check

    private groupCheckCooldownMs = 300000; // 5 minutes cooldown between group checks when not in group

    private isNotInGroup = false; // flag to indicate user is not in a group

    private requestQueue: QueuedRequest[] = [];

    private isProcessingQueue = false;

    private readonly requestDelayMs: number = 100; // 100ms delay between requests = max 10 requests/second

    private priceDbStoreApiUrl: string;

    constructor(apiKey: string, steamID: string, priceDbStoreApiUrl: string | null | undefined) {
        super();
        this.apiKey = apiKey;
        this.steamID = steamID;
        this.priceDbStoreApiUrl = priceDbStoreApiUrl || PriceDBStoreManager.DEFAULT_BASE_URI;

        this.axiosInstance = this.createAxiosClient(undefined);
    }

    /**
     * Add a request to the queue and process it with rate limiting
     */
    private async queueRequest<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ fn, resolve, reject });
            void this.processQueue();
        });
    }

    /**
     * Process the request queue with delays to avoid rate limiting
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            if (!request) break;

            try {
                const result = await request.fn();
                request.resolve(result);
            } catch (error) {
                request.reject(error);
            }

            // Wait before processing next request to avoid rate limit
            if (this.requestQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
            }
        }

        this.isProcessingQueue = false;
    }

    /**
     * Set the Steam ID for the store manager
     */
    setSteamID(steamID: string): void {
        this.steamID = steamID;
    }

    /**
     * Initialize the store manager by fetching existing listings
     */
    async init(): Promise<void> {
        try {
            log.debug('Initialising...');
            await this.getAuthToken();
            await this.fetchMyListings();

            if (this.listings.size > 0) {
                log.info(`Clearing ${this.listings.size} pre-existing pricedb.io listings on startup...`);
                await this.deleteAllListings();
            }

            // Fetch group info to cache the store slug for friendly URLs
            try {
                const group = await this.getMyGroup();
                if (group && group.custom_store_slug) {
                    log.debug(`Cached store slug: ${group.custom_store_slug}`);
                }
            } catch (err) {
                // Not being in a group is not a critical error
                log.debug('No group found or failed to fetch group info (this is normal if not in a group)');
            }

            log.info('Initialized successfully');
            this.emit('ready');
        } catch (err) {
            log.error('Failed to initialize:', err);
            this.emit('error', err);
            throw err;
        }
    }

    async getAuthToken() {
        const errReturn = { ok: false, reason: 'Could not get PriceDB AuthToken' } as const;

        try {
            const response = await this.axiosInstance.get<{ ok: true; token: string } | { ok: false; reason: string }>(
                '/bot-api/auth-token'
            );

            if (response.status !== 200 || !response.data.ok) {
                log.error('Could not get PriceDB AuthToken', response);
                return errReturn;
            }

            this.axiosInstance = this.createAxiosClient(response.data.token);
            return response.data;
        } catch (e) {
            const error = filterAxiosError(e as AxiosError);
            log.error('Failed to fetch Auth Token from pricedb.io:', error);
            return errReturn;
        }
    }

    /**
     * Fetch all listings for the authenticated user
     */
    async fetchMyListings(): Promise<PriceDBListing[]> {
        try {
            const response = await this.axiosInstance.get<PriceDBListingResponse>('/listings/my');

            if (response.data.success && response.data.listings) {
                this.listings.clear();
                response.data.listings.forEach(listing => {
                    this.listings.set(listing.asset_id, listing);
                });
                log.debug(`Fetched ${response.data.listings.length} listings from pricedb.io`);
                return response.data.listings;
            }
            return [];
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error('Failed to fetch listings from pricedb.io:', error);
            throw error;
        }
    }

    /**
     * Create a new listing on pricedb.io (queued with rate limiting)
     */
    /**
     * Create a new listing directly without going through the request queue.
     * Used by createOrUpdatePriceDBListing for concurrent operation.
     */
    async createListingDirect(assetId: string, currencies: Currencies): Promise<PriceDBListing | null> {
        const listing: Omit<PriceDBListing, 'id' | 'steam_id' | 'item_name' | 'created_at'> = {
            asset_id: assetId,
            price_keys: currencies.keys,
            price_metal: currencies.metal
        };

        const response = await this.axiosInstance.post<PriceDBListingResponse>('/listings', listing);

        if (response.data.success && response.data.listing) {
            this.listings.set(assetId, response.data.listing);
            this.emit('listingCreated', response.data.listing);
            return response.data.listing;
        }
        return null;
    }

    /**
     * Update an existing listing directly without going through the request queue.
     * Used by createOrUpdatePriceDBListing for concurrent operation.
     */
    async updateListingDirect(assetId: string, currencies: Currencies): Promise<PriceDBListing | null> {
        const existingListing = this.listings.get(assetId);
        if (!existingListing || !existingListing.id) {
            log.warn(`Cannot update listing for asset ${assetId}: listing not found`);
            return null;
        }

        const update = {
            price_keys: currencies.keys,
            price_metal: currencies.metal
        };

        const response = await this.axiosInstance.put<PriceDBListingResponse>(
            `/listings/${existingListing.id}`,
            update
        );
        if (response.data.success && response.data.listing) {
            const updatedListing = { ...existingListing, ...response.data.listing };
            this.listings.set(assetId, updatedListing);
            this.emit('listingUpdated', updatedListing);
            return updatedListing;
        }
        return null;
    }

    /**
     * Create a new listing on pricedb.io (queued with rate limiting)
     */
    async createListing(assetId: string, currencies: Currencies): Promise<PriceDBListing | null> {
        return this.queueRequest(async () => {
            try {
                return await this.createListingDirect(assetId, currencies);
            } catch (err) {
                const error = filterAxiosError(err as AxiosError);
                log.error(`Failed to create listing on pricedb.io for asset ${assetId}:`, error);
                this.emit('listingCreateError', { assetId, error });
                throw error;
            }
        });
    }

    /**
     * Update an existing listing on pricedb.io (queued with rate limiting)
     */
    async updateListing(assetId: string, currencies: Currencies): Promise<PriceDBListing | null> {
        return this.queueRequest(async () => {
            try {
                return await this.updateListingDirect(assetId, currencies);
            } catch (err) {
                const error = filterAxiosError(err as AxiosError);
                log.error(`Failed to update listing on pricedb.io for asset ${assetId}:`, error);
                this.emit('listingUpdateError', { assetId, error });
                throw error;
            }
        });
    }

    /**
     * Delete a listing from pricedb.io (queued with rate limiting)
     */
    async deleteListing(assetId: string): Promise<boolean> {
        return this.queueRequest(async () => {
            try {
                return await this.deleteListingDirect(assetId);
            } catch (err) {
                const error = filterAxiosError(err as AxiosError);
                log.error(`Failed to delete listing on pricedb.io for asset ${assetId}:`, error);
                this.emit('listingDeleteError', { assetId, error });
                throw error;
            }
        });
    }

    /**
     * Delete a listing directly without going through the request queue.
     * Used by deleteAllListings for concurrent bulk cleanup.
     */
    private async deleteListingDirect(assetId: string): Promise<boolean> {
        const existingListing = this.listings.get(assetId);
        if (!existingListing) {
            log.warn(`Cannot delete asset ${assetId}: not in local listings map`);
            return false;
        }
        if (!existingListing.id) {
            log.warn(
                `Cannot delete asset ${assetId}: listing has no server-side id (data: ${JSON.stringify(
                    existingListing
                )})`
            );
            return false;
        }

        const response = await withProgressLog(
            `DELETE /listings/${existingListing.id} (asset ${assetId})`,
            this.axiosInstance.delete<PriceDBListingResponse>(`/listings/${existingListing.id}`)
        );

        // axios only resolves for 2xx responses, so trust the HTTP status.
        // Some endpoints return 200 with success:false in the body — ignore that field.
        if (response.status >= 200 && response.status < 300) {
            log.debug(
                `Deleted listing ${existingListing.id} (asset ${assetId}), ` +
                    `HTTP ${response.status}, body: ${JSON.stringify(response.data)}`
            );
            this.listings.delete(assetId);
            this.emit('listingDeleted', assetId);
            return true;
        }

        log.warn(
            `Unexpected HTTP ${response.status} deleting listing ${existingListing.id}, ` +
                `body: ${JSON.stringify(response.data)}`
        );
        return false;
    }

    /**
     * Delete all listings from pricedb.io using a concurrent worker pool.
     * Bypasses the per-request rate-limit queue — bulk startup cleanup should be
     * as fast as the API allows, not serialised at 100ms/request.
     * priedb has a rate limit 600 requests for minute. 50 should be safe
     */
    async deleteAllListings(concurrency = 50): Promise<{ deleted: number; failed: number }> {
        const results = { deleted: 0, failed: 0 };
        const assetIds = Array.from(this.listings.keys());

        if (assetIds.length === 0) {
            log.debug('No listings to delete');
            return results;
        }

        log.info(`Deleting ${assetIds.length} listings from pricedb.io (concurrency: ${concurrency})...`);

        // Periodic progress ticker so startup logs show the bot is still alive.
        const progressInterval = setInterval(() => {
            const done = results.deleted + results.failed;
            log.info(
                `pricedb.io startup cleanup: ${done} / ${assetIds.length} listings processed (${results.deleted} deleted, ${results.failed} failed)...`
            );
        }, 30000);

        try {
            // Work-stealing pool: each worker grabs the next asset from the shared
            // queue until it's empty, so concurrency workers run simultaneously.
            const workQueue = [...assetIds];

            const worker = async (): Promise<void> => {
                while (workQueue.length > 0) {
                    const assetId = workQueue.shift();
                    if (!assetId) return;
                    try {
                        const deleted = await this.deleteListingDirect(assetId);
                        if (deleted) {
                            results.deleted++;
                        } else {
                            results.failed++;
                        }
                    } catch (err) {
                        results.failed++;
                        log.warn(`Delete threw for asset ${assetId}:`, err);
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(concurrency, assetIds.length) }, () => worker()));
        } finally {
            clearInterval(progressInterval);
        }

        log.info(`Deleted ${results.deleted} listings${results.failed > 0 ? `, ${results.failed} failed` : ''}`);
        return results;
    }

    /**
     * Refresh the cached inventory on pricedb.io (limited to 25 per day)
     */
    async refreshInventory(): Promise<boolean> {
        try {
            // Check rate limit: 1 refresh per 15 minutes
            if (this.lastInventoryRefresh) {
                const now = new Date();
                const timeSinceLastRefresh = now.getTime() - this.lastInventoryRefresh.getTime();
                const fifteenMinutesMs = 15 * 60 * 1000;

                if (timeSinceLastRefresh < fifteenMinutesMs) {
                    const timeRemaining = Math.ceil((fifteenMinutesMs - timeSinceLastRefresh) / 60000);
                    log.debug(
                        `Inventory refresh rate limit: ${timeRemaining} minutes remaining until next allowed refresh`
                    );
                    return false;
                }
            }

            const response = await this.axiosInstance.post<PriceDBInventoryResponse>('/inventory/refresh');

            if (response.data.success) {
                this.lastInventoryRefresh = new Date();
                log.info(`Inventory refreshed on pricedb.io. Items: ${response.data.item_count}`);
                this.emit('inventoryRefreshed', {
                    itemCount: response.data.item_count ?? 0,
                    refreshCount: response.data.refresh_count ?? 0
                });
                return true;
            }
            return false;
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error('Failed to refresh inventory on pricedb.io:', error);
            this.emit('inventoryRefreshError', error);
            throw error;
        }
    }

    /**
     * Get cached inventory from pricedb.io
     */
    async getInventory(): Promise<any[]> {
        try {
            const response = await this.axiosInstance.get<PriceDBInventoryResponse>('/inventory');

            if (response.data.success && response.data.items) {
                log.debug(
                    `Fetched ${response.data.count} items from pricedb.io inventory (cached: ${response.data.from_cache})`
                );
                return response.data.items;
            }
            return [];
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error('Failed to get inventory from pricedb.io:', error);
            throw error;
        }
    }

    /**
     * Get user information from pricedb.io
     */
    async getUserInfo(): Promise<PriceDBUserResponse['user'] | null> {
        try {
            const response = await this.axiosInstance.get<PriceDBUserResponse>('/user');

            if (response.data.success && response.data.user) {
                return response.data.user;
            }
            return null;
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error('Failed to get user info from pricedb.io:', error);
            throw error;
        }
    }

    /**
     * Update trade URL on pricedb.io
     */
    async updateTradeURL(tradeURL: string): Promise<boolean> {
        try {
            const response = await this.axiosInstance.put<PriceDBListingResponse>('/user/trade-url', {
                trade_url: tradeURL
            });

            if (response.data.success) {
                log.info('Trade URL updated on pricedb.io');
                return true;
            }
            return false;
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error('Failed to update trade URL on pricedb.io:', error);
            throw error;
        }
    }

    /**
     * Find a listing by asset ID
     */
    findListing(assetId: string): PriceDBListing | undefined {
        return this.listings.get(assetId);
    }

    /**
     * Get all listings
     */
    getAllListings(): PriceDBListing[] {
        return Array.from(this.listings.values());
    }

    /**
     * Get the count of inventory refreshes today
     */
    getLastInventoryRefresh(): Date | null {
        return this.lastInventoryRefresh;
    }

    /**
     * Get my store group information
     */
    async getMyGroup(): Promise<PriceDBGroup | null> {
        try {
            const response = await this.axiosInstance.get<PriceDBGroupResponse>('/groups/my');

            if (response.data.success && response.data.group) {
                // Cache the store slug for URL generation
                this.storeSlug = response.data.group.custom_store_slug;
                this.isNotInGroup = false; // Reset flag when group is found
                this.lastGroupCheckTime = Date.now();
                log.debug(
                    `Fetched group info - Group: ${response.data.group.group_name}, Slug: ${response.data.group.custom_store_slug}`
                );
                return response.data.group;
            }
            log.debug('No group found in /groups/my response');
            this.isNotInGroup = true;
            this.lastGroupCheckTime = Date.now();
            return null;
        } catch (err) {
            const axiosError = err as AxiosError;
            // 404 is expected when user is not in a group - This really needs changing server-side I will get to it eventually
            if (axiosError?.response?.status === 404) {
                this.isNotInGroup = true;
                this.lastGroupCheckTime = Date.now();
                // Only log once when first detected or after cooldown
                const timeSinceLastCheck = Date.now() - this.lastGroupCheckTime;
                if (timeSinceLastCheck === 0 || timeSinceLastCheck >= this.groupCheckCooldownMs) {
                    log.debug('User is not in a group (404 response)');
                }
                return null;
            }
            const error = filterAxiosError(axiosError);
            log.error('Failed to get group info from pricedb.io:', error);
            throw error;
        }
    }

    /**
     * Invite a user to the store group
     */
    async inviteToGroup(groupId: number, steamId: string): Promise<PriceDBInviteCreateResponse | null> {
        try {
            const response = await this.axiosInstance.post<PriceDBInviteCreateResponse>(`/groups/${groupId}/invite`, {
                steam_id: steamId
            });

            if (response.data.success) {
                log.info(`Invited ${steamId} to group ${groupId}`);
                return response.data;
            }
            return null;
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error(`Failed to invite ${steamId} to group ${groupId}:`, error);
            throw error;
        }
    }

    /**
     * Get pending group invites
     */
    async getPendingInvites(): Promise<PriceDBInvite[]> {
        try {
            const response = await this.axiosInstance.get<PriceDBInvitesResponse>('/groups/invites');

            if (response.data.success && response.data.invites) {
                log.debug(`Fetched ${response.data.count} pending invites`);
                return response.data.invites;
            }
            return [];
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error('Failed to get pending invites from pricedb.io:', error);
            throw error;
        }
    }

    /**
     * Accept a group invite
     */
    async acceptGroupInvite(groupId: number): Promise<boolean> {
        try {
            const response = await this.axiosInstance.post<PriceDBAcceptInviteResponse>(`/groups/${groupId}/accept`);

            if (response.data.success) {
                log.info(`Accepted invite to group ${groupId} - ${response.data.message}`);
                // Reset the not-in-group flag since user just joined
                this.isNotInGroup = false;
                this.lastGroupCheckTime = 0; // Reset cooldown to allow immediate refresh
                // Refresh group info to get the store slug
                await this.getMyGroup();
                return true;
            }
            return false;
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error(`Failed to accept invite to group ${groupId}:`, error);
            throw error;
        }
    }

    /**
     * Leave a group
     */
    async leaveGroup(groupId: number): Promise<boolean> {
        try {
            const response = await this.axiosInstance.post<PriceDBGroupResponse>(`/groups/${groupId}/leave`);

            if (response.data.success) {
                log.info(`Left group ${groupId}`);
                return true;
            }
            return false;
        } catch (err) {
            const error = filterAxiosError(err as AxiosError);
            log.error(`Failed to leave group ${groupId}:`, error);
            throw error;
        }
    }

    /**
     * Get the store slug for generating friendly URLs
     * If not cached, fetch from API
     */
    async getStoreSlug(): Promise<string | null> {
        if (this.storeSlug) {
            return this.storeSlug;
        }

        const group = await this.getMyGroup();
        return group ? group.custom_store_slug : null;
    }

    /**
     * Force refresh group status (useful after joining a group)
     */
    async refreshGroupStatus(): Promise<void> {
        this.isNotInGroup = false;
        this.lastGroupCheckTime = 0;
        this.storeSlug = null;
        await this.getMyGroup();
    }

    /**
     * Get the friendly store URL using slug
     */
    async getStoreURL(): Promise<string> {
        const slug = await this.getStoreSlug();
        if (slug) {
            return `https://crit.tf/sf/${slug}`;
        }
        // Fallback to steamID-based URL
        return `https://crit.tf/store?id=${this.steamID}`;
    }

    /**
     * Get the cached store URL synchronously (for use in templates)
     * Returns null if not yet cached
     */
    getCachedStoreURL(): string | null {
        if (this.storeSlug) {
            return `https://crit.tf/sf/${this.storeSlug}`;
        }

        // Check if we should attempt to fetch group info
        const timeSinceLastCheck = Date.now() - this.lastGroupCheckTime;
        const cooldownExpired = timeSinceLastCheck >= this.groupCheckCooldownMs;

        // If not in a group and cooldown hasn't expired, skip the API call
        if (this.isNotInGroup && !cooldownExpired) {
            return null;
        }

        // If not cached and cooldown expired (or never checked), trigger an async fetch
        // This ensures the cache will be populated for next time
        if (!this.storeSlug && cooldownExpired) {
            void this.getMyGroup().catch(err => {
                log.debug('Failed to fetch group info for cache refresh:', err);
            });
        }

        return null;
    }

    async sendDeadMansRequest() {
        try {
            const result = await this.axiosInstance.post('/bot-api/alive', { alive: true });
            return result.status === 200;
        } catch {
            return false;
        }
    }

    private createAxiosClient(shortLivedToken: string | undefined) {
        return axios.create({
            baseURL: this.priceDbStoreApiUrl || PriceDBStoreManager.DEFAULT_BASE_URI,
            headers: {
                'X-API-Key': this.apiKey,
                'X-Short-Lived-Token': shortLivedToken,
                'Content-Type': 'application/json',
                'User-Agent': 'TF2AutobotPriceDB@' + process.env.BOT_VERSION
            },
            timeout: 30000
        });
    }
}
