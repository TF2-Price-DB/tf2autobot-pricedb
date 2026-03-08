import Bot from './Bot';
import log from '../lib/logger';

const CURRENT_DIFF_VERSION = 2;

/**
 * FIFO entry for tracking item cost basis with distributed overpay/underpay
 */
export interface FIFOEntry {
    sku: string;
    costKeys: number;
    costMetal: number;
    diffKeys: number; // Distributed (actual - pricelist) delta in keys, negative means we underpaid
    diffMetal: number; // Distributed (actual - pricelist) delta in refined, negative means we underpaid
    tradeId: string;
    timestamp: number;
    diffVersion?: number;
}

/**
 * Manages inventory cost basis using FIFO (First In, First Out) accounting..
 */
export default class InventoryCostBasis {
    private readonly bot: Bot;

    constructor(bot: Bot) {
        this.bot = bot;
    }

    /**
     * We have SQLite now no need to handle this in memory
     */
    async load(): Promise<void> {
        log.debug(`Cost basis: ready — entries stored live in SQLite (${this.bot.db.accountName})`);
    }

    /**
     * Add an item to FIFO inventory.
     * @param sku - Item SKU
     * @param costKeys - Pricelist cost in keys at time of purchase
     * @param costMetal - Pricelist cost in metal at time of purchase
     * @param diffKeys - Distributed overpay/underpay in keys from multi-item trade
     * @param diffMetal - Distributed overpay/underpay in refined from multi-item trade
     * @param tradeId - Trade offer ID
     */
    async addItem(
        sku: string,
        costKeys: number,
        costMetal: number,
        diffKeys: number,
        diffMetal: number,
        tradeId: string
    ): Promise<void> {
        const entry: FIFOEntry = {
            sku,
            costKeys,
            costMetal,
            diffKeys,
            diffMetal,
            tradeId,
            timestamp: Math.floor(Date.now() / 1000), // Unix seconds — consistent with cost_basis schema
            diffVersion: CURRENT_DIFF_VERSION
        };

        this.bot.db.addCostBasisEntry(entry);

        log.debug(
            `Added FIFO entry: ${sku} @ ${costKeys}k ${costMetal}r (diff: ${diffKeys}k ${diffMetal}r) [${tradeId}]`
        );
    }

    /**
     * Remove items from FIFO inventory (oldest first).
     * Fallback to pricelist if entries are missing (shouldn't happen but handles edge cases).
     * @param sku - Item SKU
     * @param quantity - Number of items to remove
     * @param fallbackBuyPrice - Optional pricelist buy price for fallback (if FIFO missing)
     * @returns Object with removed entries and flag indicating if estimates were used
     */
    async removeItem(
        sku: string,
        quantity: number,
        fallbackBuyPrice?: { keys: number; metal: number }
    ): Promise<{ entries: FIFOEntry[]; hasEstimates: boolean }> {
        const removed: FIFOEntry[] = [];
        let remaining = quantity;
        let hasEstimates = false;

        // Pop entries for this SKU in FIFO order (lowest row_id first)
        while (remaining > 0) {
            const entry = this.bot.db.removeOldestCostBasisEntry(sku);

            if (entry === null) {
                // FIFO entry missing - use fallback if available
                if (fallbackBuyPrice) {
                    log.warn(
                        `FIFO entry not found for ${sku}. Using pricelist fallback for ${remaining} items (ESTIMATE).`
                    );

                    for (let i = 0; i < remaining; i++) {
                        removed.push({
                            sku,
                            costKeys: fallbackBuyPrice.keys,
                            costMetal: fallbackBuyPrice.metal,
                            diffKeys: 0,
                            diffMetal: 0,
                            tradeId: 'ESTIMATE',
                            timestamp: Math.floor(Date.now() / 1000), // Unix seconds — consistent with cost_basis schema
                            diffVersion: CURRENT_DIFF_VERSION
                        });
                    }
                    hasEstimates = true;
                    remaining = 0;
                } else {
                    log.error(
                        `FIFO entry not found for ${sku} and no fallback price provided. ${remaining} items missing!`
                    );
                }
                break;
            }

            removed.push(entry);
            remaining--;
        }

        if (removed.length > 0) {
            log.debug(`Removed ${removed.length} FIFO entries for ${sku}`);
        }

        return { entries: removed, hasEstimates };
    }

    /**
     * Get the current FIFO cost for an item (without removing it).
     * @param sku - Item SKU
     * @returns First FIFO entry for this SKU, or null if not found
     */
    peekItem(sku: string): FIFOEntry | null {
        return this.bot.db.peekCostBasisEntry(sku);
    }

    /**
     * Get the count of items in FIFO for a specific SKU.
     * @param sku - Item SKU
     * @returns Number of entries
     */
    getItemCount(sku: string): number {
        return this.bot.db.getCostBasisCountForSku(sku);
    }

    /**
     * Get total inventory value (unrealised cost basis).
     * @returns Total cost basis in keys and metal
     */
    getInventoryValue(): { keys: number; metal: number } {
        return this.bot.db.getCostBasisInventoryValue();
    }

    /**
     * Get all FIFO entries (for debugging/inspection).
     */
    getAllEntries(): FIFOEntry[] {
        return this.bot.db.getCostBasisEntries();
    }

    /**
     * Clear all FIFO entries (use with caution!).
     */
    async clear(): Promise<void> {
        this.bot.db.clearCostBasisEntries();
        log.warn('Cleared all FIFO entries');
    }
}
