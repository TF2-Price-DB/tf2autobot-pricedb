/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-misused-promises */

import { CardRenderRequest, CardRenderResult, TradeCardPayload } from './cardRenderProtocol';

function reply(result: CardRenderResult): void {
    if (process.send) process.send(result, () => process.exit(0));
    else process.exit(0);
}

function restoreTrade(payload: TradeCardPayload): { offer: any; bot: any } {
    const offerData = new Map<string, unknown>([
        ['dict', payload.offer.dict],
        ['value', payload.offer.value],
        ['highValue', payload.offer.highValue],
        ['prices', payload.offer.prices]
    ]);
    const botData = payload.bot as any;
    const names = botData.names as Record<string, string>;
    const bot = {
        ...botData,
        schema: { getName: (sku: { toString: () => string }) => names[sku.toString()] ?? 'Unknown item' },
        pricelist: { ...botData.pricelist, getPrice: () => null },
        inventoryManager: {
            getInventory: {
                getCurrencies: () => botData.inventory.currencies,
                getTotalItems: botData.inventory.totalItems
            }
        }
    };
    return { offer: { id: payload.offer.id, data: (key: string) => offerData.get(key) }, bot };
}

process.once('message', async (request: CardRenderRequest) => {
    try {
        let image: Buffer | null;
        switch (request.type) {
            case 'price': {
                const renderer = await import('./renderPriceCard');
                image = await renderer.default(
                    request.sku,
                    request.name,
                    request.buy,
                    request.sell,
                    request.stock,
                    request.limits,
                    request.intent,
                    request.autoprice,
                    request.updated,
                    request.accountName,
                    request.showQualityBorders
                );
                break;
            }
            case 'pure': {
                const renderer = await import('./renderPureStockCard');
                image = await renderer.default(request.stock, request.accountName);
                break;
            }
            case 'rate': {
                const renderer = await import('./renderRateCard');
                image = await renderer.default(request.buy, request.sell, request.source, request.accountName);
                break;
            }
            case 'sku-chart': {
                const renderer = await import('./renderSkuChart');
                image = await renderer.default(request.sku, request.keyRate);
                break;
            }
            case 'stock': {
                const renderer = await import('./renderStockCards');
                image = await renderer.renderStockCardPage(
                    request.entries,
                    request.accountName,
                    request.title,
                    request.pageIndex,
                    request.pageSize,
                    request.showQualityBorders
                );
                break;
            }
            case 'trade': {
                const renderer = await import('./renderTradeCard');
                const restored = restoreTrade(request.payload);
                image = await renderer.default(
                    restored.offer,
                    restored.bot,
                    request.payload.options as any,
                    request.payload.meta as any
                );
                break;
            }
            case 'stats': {
                const renderer = await import('./renderStatsCard');
                image = await renderer.default(request.readings);
                break;
            }
        }
        reply(
            image ? { ok: true, image: image.toString('base64') } : { ok: false, error: 'renderer returned no image' }
        );
    } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : 'unknown renderer error' });
    }
});
