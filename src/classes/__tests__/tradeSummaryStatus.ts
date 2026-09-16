import { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import Bot from '../Bot';
import { buildStatusBlock } from '../DiscordWebhook/sendTradeSummary';
import {
    collectPricedItems,
    collectStatReadings,
    MAX_PRICE_ROWS,
    PricedItem,
    priceRows,
    StatMeta
} from '../DiscordWebhook/tradeCard/offerFacts';

/**
 * The card's text fallback: builds the same readings (so they can never drift
 * on a `misc.*` toggle), then formats them as one markdown line each.
 * Pure builder — no server, no canvas.
 */
function meta(): StatMeta {
    return {
        timeTakenToComplete: 4200,
        timeTakenToProcessOrConstruct: 3200,
        timeTakenToCounterOffer: 2600,
        isOfferSent: false
    };
}

const KEY = '5021;6';
const UNUSUAL = '378;5;u13';

/** A bot wired just deep enough for collectStatReadings' reads. */
function makeBot(t: {
    showKeyRate?: boolean;
    showPureStock?: boolean;
    showInventory?: boolean;
    showItemPrices?: boolean;
    detailed?: boolean;
    showMs?: boolean;
    keyRateLabel?: string;
    pureStockLabel?: string;
    totalItemsLabel?: string;
    timeTakenLabel?: string;
}): Bot {
    const keyPrice = { keys: 0, metal: 60 };
    return {
        options: {
            tradeSummary: {
                showDetailedTimeTaken: t.detailed ?? true,
                showTimeTakenInMS: t.showMs === true,
                showItemPrices: t.showItemPrices ?? true,
                customText: {
                    keyRate: { discordWebhook: t.keyRateLabel },
                    pureStock: { discordWebhook: t.pureStockLabel },
                    totalItems: { discordWebhook: t.totalItemsLabel },
                    timeTaken: { discordWebhook: t.timeTakenLabel }
                }
            },
            discordWebhook: {
                tradeSummary: {
                    misc: {
                        showKeyRate: t.showKeyRate ?? true,
                        showPureStock: t.showPureStock ?? true,
                        showInventory: t.showInventory ?? true
                    }
                }
            }
        },
        pricelist: {
            getKeyPrice: { metal: 60 },
            getKeyPrices: { buy: keyPrice, sell: { keys: 0, metal: 61 }, src: 'ptf' },
            isUseCustomPricer: false,
            getPrice: () => null
        },
        handler: {
            autokeys: {
                isEnabled: true,
                getActiveStatus: true,
                getOverallStatus: { isBankingKeys: false, isBuyingKeys: true }
            }
        },
        tf2: { backpackSlots: 2500 },
        craftWeapons: [],
        schema: { getName: () => `Item ${UNUSUAL}` },
        inventoryManager: {
            getInventory: {
                getTotalItems: 1234,
                getCurrencies: () => ({
                    [KEY]: new Array(3).fill(''),
                    '5002;6': new Array(12).fill(''),
                    '5001;6': new Array(1).fill(''),
                    '5000;6': new Array(0).fill('')
                })
            }
        }
    } as unknown as Bot;
}

function pricedOffer(skus: Record<string, unknown> = {}): TradeOffer {
    return {
        id: '1',
        data: (key: string) =>
            key === 'prices'
                ? { [UNUSUAL]: { buy: { keys: 8, metal: 0 }, sell: { keys: 12, metal: 0 } }, ...skus }
                : undefined
    } as unknown as TradeOffer;
}

const PRICES: PricedItem[] = [
    { name: 'Item 378;5;u13', buy: '8 keys', sell: '12 keys', value: 720 },
    { name: 'Item 199', buy: '44.66 ref', sell: '47.77 ref', value: 30 }
];

describe('buildStatusBlock', () => {
    it('returns an empty string for no readings and no prices', () => {
        expect(buildStatusBlock([], [])).toBe('');
    });

    it('builds one line per reading, in card order', () => {
        const bot = makeBot({});
        const readings = collectStatReadings(bot, meta());

        expect(readings.map(r => r.kind)).toEqual(['keyRate', 'pureStock', 'totalItems', 'timeTaken']);

        const block = buildStatusBlock(readings, []);
        const lines = block.split('\n').filter(l => l.length > 0);
        expect(lines[0]).toBe('🔑 Key rate: 60 / 61 ref  ·  PriceDB.IO');
        expect(lines[1]).toContain('💰 Pure stock: 3 keys');
        expect(lines[1]).toContain('12.33 ref (12/1/0)');
        // Detailed time-taken reads one line per row, under the label.
        expect(lines[2]).toBe('🎒 Total items: 1234 of 2500 slots');
        expect(lines[3]).toBe('⏱ **Time taken:**');
        expect(lines).toContain('- To process: 3.2s');
        expect(lines).toContain('- To counter: 2.6s');
        expect(lines).toContain('- To complete: 4.2s');
    });

    it('drops exactly its own reading for each disabled misc.* toggle', () => {
        const kindsOf = (bot: Bot) => collectStatReadings(bot, meta()).map(r => r.kind);

        expect(kindsOf(makeBot({ showKeyRate: false }))).not.toContain('keyRate');
        expect(kindsOf(makeBot({ showPureStock: false }))).not.toContain('pureStock');
        expect(kindsOf(makeBot({ showInventory: false }))).not.toContain('totalItems');

        // All three off leaves only the time-taken block, none of the others.
        const bot = makeBot({ showKeyRate: false, showPureStock: false, showInventory: false });
        const block = buildStatusBlock(collectStatReadings(bot, meta()), []);
        expect(block).not.toContain('Key rate');
        expect(block).not.toContain('Pure stock');
        expect(block).not.toContain('Total items');
        expect(block).toContain('Time taken');
    });

    it('renders the priced items as the card would, caption over overflow', () => {
        const block = buildStatusBlock([], PRICES);

        expect(block).toContain('📜 **Item prices**');
        expect(block).toContain('- **Item 378;5;u13** 8 keys / 12 keys');
        expect(block).toContain('- **Item 199** 44.66 ref / 47.77 ref');
    });

    it('collapses priced items past five into a +N more line', () => {
        const many: PricedItem[] = Array.from({ length: 8 }, (_, i) => ({
            name: `Item ${i}`,
            buy: '1 ref',
            sell: '2 ref',
            value: 10 - i
        }));

        const block = buildStatusBlock([], many);
        const lines = block.split('\n');
        // The card's own cut: the last of the five slots goes to the count.
        expect(lines.filter(l => l.startsWith('- **'))).toHaveLength(MAX_PRICE_ROWS - 1);
        expect(lines).toContain('+4 more priced items');
        // And it is literally the card's cut, not a second one that agrees today.
        expect(lines).toHaveLength(priceRows(many).length + 1);
    });

    it('is gated on showItemPrices at the source', () => {
        const withPrices = collectPricedItems(pricedOffer(), makeBot({ showItemPrices: true }), 60);
        expect(withPrices.length).toBeGreaterThan(0);
        expect(buildStatusBlock([], withPrices)).toContain('📜 **Item prices**');

        const withoutPrices = collectPricedItems(pricedOffer(), makeBot({ showItemPrices: false }), 60);
        expect(withoutPrices).toEqual([]);
        expect(buildStatusBlock([], withoutPrices)).not.toContain('📜');

        // And the gate reads the same into the verbose item list, because it is
        // not this builder but the option itself that suppresses prices.
        expect(collectPricedItems(pricedOffer(), makeBot({}), 60).length).toBeGreaterThan(0);
    });

    it('can exclude pure currency for the rendered trade card', () => {
        const prices = collectPricedItems(
            pricedOffer({
                '5002;6': { buy: { keys: 0, metal: 8 }, sell: { keys: 0, metal: 9 } }
            }),
            makeBot({}),
            60,
            true
        );

        expect(prices).toHaveLength(1);
        expect(prices[0].name).toBe(`Item ${UNUSUAL}`);
    });

    it('only displays prices for the items actually in the trade card', () => {
        const offer = {
            id: '1',
            data: (key: string) => {
                if (key === 'prices') {
                    return {
                        [UNUSUAL]: { buy: { keys: 8, metal: 0 }, sell: { keys: 12, metal: 0 } },
                        '199;6': { buy: { keys: 0, metal: 1 }, sell: { keys: 0, metal: 2 } }
                    };
                }
                if (key === 'dict') {
                    return { our: { [UNUSUAL]: 1 }, their: { '5002;6': 4 } };
                }
                return undefined;
            }
        } as unknown as TradeOffer;

        const prices = collectPricedItems(offer, makeBot({}), 60, true);

        expect(prices).toHaveLength(1);
        expect(prices[0].name).toBe(`Item ${UNUSUAL}`);
    });

    it('retains the key price for a pure autokeys trade', () => {
        const offer = {
            id: '1',
            data: (key: string) => {
                if (key === 'prices') {
                    return { [KEY]: { buy: { keys: 0, metal: 59 }, sell: { keys: 0, metal: 60 } } };
                }
                if (key === 'dict') {
                    return { our: { [KEY]: 1 }, their: { '5002;6': 60 } };
                }
                return undefined;
            }
        } as unknown as TradeOffer;

        const prices = collectPricedItems(offer, makeBot({}), 60, true);

        expect(prices).toHaveLength(1);
        expect(prices[0]).toMatchObject({ buy: '59 ref', sell: '60 ref' });
    });

    it('honors customText.*.discordWebhook verbatim for the labels', () => {
        const bot = makeBot({
            keyRateLabel: '🔑 **Custom key rate:**',
            pureStockLabel: '💰 Custom pure',
            totalItemsLabel: '🎒 Custom total',
            timeTakenLabel: '⏱ Custom time'
        });
        const block = buildStatusBlock(collectStatReadings(bot, meta()), []);
        expect(block).toContain('🔑 **Custom key rate:** 60 / 61 ref');
        expect(block).toContain('💰 Custom pure 3 keys');
        expect(block).toContain('🎒 Custom total 1234');
        expect(block).toContain('⏱ Custom time');
    });

    it('falls back to the built-in labels when customText is absent', () => {
        // makeBot builds customText entries with undefined values; a bot that
        // never sets customText behaves the same (optional read).
        const bot = makeBot({});
        const block = buildStatusBlock(collectStatReadings(bot, meta()), []);
        expect(block).toContain('🔑 Key rate:');
        expect(block).toContain('💰 Pure stock:');
        expect(block).toContain('🎒 Total items:');
        expect(block).toContain('⏱ **Time taken:**');
    });

    it('collapses time-taken to one line when showDetailedTimeTaken is off', () => {
        const bot = makeBot({ detailed: false });
        const block = buildStatusBlock(collectStatReadings(bot, meta()), []);
        expect(block).not.toContain('To process');
        expect(block).not.toContain('To counter');
        expect(block).toContain('⏱ **Time taken:** 4.2s');
    });

    it('keeps upstream’s parenthetical milliseconds when showTimeTakenInMS is on', () => {
        const bot = makeBot({ showMs: true });
        const block = buildStatusBlock(collectStatReadings(bot, meta()), []);
        expect(block).toContain('- To complete: 4.2s (4200 ms)');
        expect(block).toContain('- To process: 3.2s (3200 ms)');
    });

    it('clamps an absurdly long priced-item name', () => {
        const block = buildStatusBlock([], [{ name: 'A'.repeat(200), buy: '1 ref', sell: '2 ref', value: 1 }]);
        expect(block).toContain('…');
    });
});
