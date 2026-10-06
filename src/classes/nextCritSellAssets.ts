import type Bot from './Bot';
import type { Entry } from './Pricelist';
import type { NextCritSellAsset } from './NextCritDriver';

type SellGroup = { entry: Entry; assetIds: string[] };

/** Select every tradable asset covered by an enabled sell entry, up to its stock limit. */
export default function nextCritSellAssets(bot: Bot): NextCritSellAsset[] {
    const assets: NextCritSellAsset[] = [];
    for (const [priceKey, { entry, assetIds }] of collectSellGroups(bot)) {
        const amountCanSell = bot.inventoryManager.amountCanTrade({ priceKey, tradeIntent: 'selling' });
        // Keep the selection stable as inventory ordering changes, preserving stock reserved by min.
        assetIds.sort(compareAssetIds);
        for (const assetId of assetIds.slice(0, amountCanSell)) {
            assets.push({ assetId, currencies: entry.sell });
        }
    }
    return assets;
}

function collectSellGroups(bot: Bot): Map<string, SellGroup> {
    const groups = new Map<string, SellGroup>();
    for (const [sku, items] of Object.entries(bot.inventoryManager.getInventory.getItems)) {
        for (const item of items) {
            const entry = findSellEntry(bot, sku, item.id);
            if (!entry) continue;
            if (bot.options.miscSettings.skipItemsInTrade.enable && bot.trades.isInTrade(item.id)) continue;
            const priceKey = entry.id ?? entry.sku;
            let group = groups.get(priceKey);
            if (!group) {
                group = { entry, assetIds: [] };
                groups.set(priceKey, group);
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
