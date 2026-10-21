import type Bot from './Bot';
import type { Entry } from './Pricelist';
import type { NextCritSellAsset } from './NextCritDriver';

type SellGroup = { entry: Entry; assetIds: string[]; pendingSales: number };

/** Select every tradable asset covered by an enabled sell entry, up to its stock limit. */
export default function nextCritSellAssets(bot: Bot, forCheckout = false): NextCritSellAsset[] {
    const assets: NextCritSellAsset[] = [];
    for (const [priceKey, { entry, assetIds, pendingSales }] of collectSellGroups(bot, forCheckout)) {
        const amountCanSell = bot.inventoryManager.amountCanTrade({ priceKey, tradeIntent: 'selling' });
        // Outgoing offers still appear in inventory, but consume the checkout stock budget.
        const capacity = Math.max(0, amountCanSell - pendingSales);
        // Keep the selection stable as inventory ordering changes, preserving stock reserved by min.
        assetIds.sort(compareAssetIds);
        for (const assetId of assetIds.slice(0, capacity)) {
            assets.push({ assetId, currencies: entry.sell });
        }
    }
    return assets;
}

function collectSellGroups(bot: Bot, forCheckout: boolean): Map<string, SellGroup> {
    const groups = new Map<string, SellGroup>();
    for (const [sku, items] of Object.entries(bot.inventoryManager.getInventory.getItems)) {
        for (const item of items) {
            const entry = findSellEntry(bot, sku, item.id);
            if (!entry) continue;
            const priceKey = entry.id ?? entry.sku;
            let group = groups.get(priceKey);
            if (!group) {
                group = { entry, assetIds: [], pendingSales: 0 };
                groups.set(priceKey, group);
            }
            if (bot.trades.isInTrade(item.id)) {
                if (forCheckout) group.pendingSales++;
                if (forCheckout || bot.options.miscSettings.skipItemsInTrade.enable) continue;
            }
            group.assetIds.push(item.id);
        }
    }
    return groups;
}

function findSellEntry(bot: Bot, sku: string, assetId: string): Entry | null {
    let entry =
        bot.pricelist.getPrice({ priceKey: assetId, onlyEnabled: false }) ??
        bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: false });
    if (!entry && bot.options.normalize.painted.our) {
        entry = bot.pricelist.getPrice({ priceKey: sku.replace(/;p\d+/, ''), onlyEnabled: false });
    }
    if (!entry?.enabled || (entry.intent !== 1 && entry.intent !== 2)) return null;
    return entry;
}

function compareAssetIds(a: string, b: string): number {
    const first = BigInt(a);
    const second = BigInt(b);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
}
