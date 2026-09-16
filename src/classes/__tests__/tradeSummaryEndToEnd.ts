/* eslint-disable no-console */
import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { TradeOffer } from '@tf2autobot/tradeoffer-manager';
import Bot from '../Bot';
import sendTradeSummary, { buildItemLinkBlocks, buildTradeCardPayload } from '../DiscordWebhook/sendTradeSummary';
import { Webhook, Container, MediaGallery, Separator, TextDisplay } from '../DiscordWebhook/interfaces';
import { getFilesPath } from '../Options';

/**
 * Drives the real sendTradeSummary against a local server and captures the exact
 * multipart body Discord would receive. Hits sku.pricedb.io for item art, so it
 * stays out of the default suite.
 *
 * Run with: TRADE_SUMMARY_E2E=/path/to/outdir npx jest tradeSummaryEndToEnd
 */
const outDir = process.env.TRADE_SUMMARY_E2E;
const e2e = outDir ? it : it.skip;

const ACCOUNT = '__tradesummary_e2e__';

// app.ts sets these at startup and never runs under jest, so the footer's identity
// line would otherwise read "undefined" — confusing in a live probe.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
process.env.BOT_VERSION = (require('../../../package.json') as { version: string }).version;
process.env.BOT_VERSION_LABEL = `PDB-${process.env.BOT_VERSION}`;

let server: http.Server;
let url: string;
const requests: { contentType: string; body: Buffer }[] = [];

jest.setTimeout(120000);

beforeAll(done => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c as Buffer));
        req.on('end', () => {
            requests.push({ contentType: req.headers['content-type'] ?? '', body: Buffer.concat(chunks) });
            res.writeHead(204).end();
        });
    });
    server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
        done();
    });
});

afterAll(done => {
    server.close(() => {
        done();
    });
});

const KEY = '5021;6';
const REF = '5002;6';
const UNUSUAL = '378;5;u13';
const STRANGE = '199;11;kt-3';

describe('buildTradeCardPayload', () => {
    it('serializes names for every traded SKU, not only the priced ones', () => {
        const payload = buildTradeCardPayload(
            makeOffer(),
            makeBot(),
            { showQualityBorders: true, maxItemsPerSide: 8 },
            {
                timeTakenToComplete: 0,
                isOfferSent: false,
                net: null
            }
        );
        const names = payload.bot.names as Record<string, string>;

        expect(names[STRANGE]).toBe('Item 199');
        expect(names[REF]).toBe('Item 5002');
    });

    it('maps a generic price record to the actual traded SKU for the card only', () => {
        const pipBoy = '30666;6';
        const offer = {
            id: '1',
            data: (key: string) =>
                ({
                    dict: { our: { [pipBoy]: 1 }, their: { [REF]: 4 } },
                    prices: { [REF]: { buy: { keys: 0, metal: 4.44 }, sell: { keys: 0, metal: 4.66 } } }
                })[key]
        } as unknown as TradeOffer;
        const bot = makeBot();
        bot.pricelist.getPrice = ({ priceKey }: { priceKey: string }) =>
            priceKey === pipBoy ? ({ sku: REF } as any) : null;

        const payload = buildTradeCardPayload(offer, bot, { showQualityBorders: true, maxItemsPerSide: 8 }, {
            timeTakenToComplete: 0,
            isOfferSent: false,
            net: null
        });

        expect((payload.offer.prices as Record<string, unknown>)[pipBoy]).toEqual({
            buy: { keys: 0, metal: 4.44 },
            sell: { keys: 0, metal: 4.66 }
        });
    });

    it('maps a lone misplaced payment price to the trade focus without guessing multi-item trades', () => {
        const mistakenMovember = '31039;11';
        const offer = {
            id: '1',
            data: (key: string) =>
                ({
                    dict: { our: { [KEY]: 1, [REF]: 3 }, their: { [mistakenMovember]: 1 } },
                      prices: {
                          [KEY]: { buy: { keys: 1, metal: 3 }, sell: { keys: 1, metal: 6.33 } },
                          [REF]: { buy: { keys: 0, metal: 0.1 }, sell: { keys: 0, metal: 0.11 } }
                      }
                })[key]
        } as unknown as TradeOffer;

        const payload = buildTradeCardPayload(offer, makeBot(), { showQualityBorders: true, maxItemsPerSide: 8 }, {
            timeTakenToComplete: 0,
            isOfferSent: false,
            net: null
        });

        expect((payload.offer.prices as Record<string, unknown>)[mistakenMovember]).toEqual({
            buy: { keys: 1, metal: 3 },
            sell: { keys: 1, metal: 6.33 }
        });
    });
});

function makeOffer(): TradeOffer {
    const data: Record<string, unknown> = {
        dict: { our: { [UNUSUAL]: 1, [STRANGE]: 2, [KEY]: 3 }, their: { [KEY]: 12, [REF]: 11 } },
        value: { our: { keys: 12, metal: 0, total: 6480 }, their: { keys: 12, metal: 11, total: 6579 }, rate: 60 },
        prices: { [UNUSUAL]: { buy: { keys: 8, metal: 0 }, sell: { keys: 12, metal: 0 } } },
        // Spell + strange part + sheen + paint, so the card fills every icon slot.
        highValue: {
            items: {
                our: {
                    [UNUSUAL]: {
                        s: { 's-1009-1': true },
                        sp: { 'sp-13': false },
                        ks: { 'ks-3': true },
                        p: { p5322826: false }
                    }
                },
                their: {}
            },
            isMention: { our: true, their: false }
        },
        action: { action: 'accept' },
        processOfferTime: 3200
    };

    return {
        id: '7788990011',
        message: 'thanks man!',
        state: 3,
        partner: { toString: () => '76561198000000000', getSteamID64: () => '76561198000000000' },
        data: (key: string) => data[key]
    } as unknown as TradeOffer;
}

function makeBot(): Bot {
    const keyPrice = { keys: 0, metal: 60 };
    return {
        options: {
            steamAccountName: ACCOUNT,
            autokeys: { enable: true },
            miscSettings: { pricedbStore: { enable: true } },
            // Only read by sendToAdmin, the Steam-chat fallback path.
            steamChat: { customInitializer: { acceptedTradeSummary: '/me' } },
            tradeSummary: {
                showProperName: false,
                showOfferMessage: true,
                showDetailedTimeTaken: true,
                showTimeTakenInMS: false,
                showItemPrices: true,
                showStockChanges: true,
                showPureInEmoji: false,
                customText: {
                    summary: { steamChat: 'Summary', discordWebhook: '__**Summary**__' },
                    asked: { steamChat: '• Asked:', discordWebhook: '**• Asked:**' },
                    offered: { steamChat: '• Offered:', discordWebhook: '**• Offered:**' },
                    offerMessage: { steamChat: '💬 Offer message:', discordWebhook: '💬 **Offer message:**' },
                    profitFromOverpay: { steamChat: '📈 Profit:', discordWebhook: '📈 ***Profit:***' },
                    lossFromUnderpay: { steamChat: '📉 Loss:', discordWebhook: '📉 ***Loss:***' },
                    timeTaken: { steamChat: '⏱ Time taken:', discordWebhook: '⏱ **Time taken:**' },
                    keyRate: { steamChat: '🔑 Key rate:', discordWebhook: '🔑 Key rate:' },
                    pureStock: { steamChat: '💰 Pure stock:', discordWebhook: '💰 Pure stock:' },
                    totalItems: { steamChat: '🎒 Total items:', discordWebhook: '🎒 Total items:' }
                }
            },
            discordWebhook: {
                ownerID: ['111222333'],
                displayName: 'TestBot',
                avatarURL: '',
                embedColor: '9171753',
                tradeSummary: {
                    url: [url],
                    misc: {
                        showQuickLinks: true,
                        showKeyRate: true,
                        showPureStock: true,
                        showInventory: true,
                        note: ''
                    },
                    mentionOwner: { enable: false, itemSkus: [], tradeValueInRef: 0 },
                    tradeCard: { enable: true, showQualityBorders: true, maxItemsPerSide: 8 }
                }
            }
        },
        pricelist: {
            getKeyPrices: { buy: keyPrice, sell: keyPrice, src: 'ptf' },
            getKeyPrice: { metal: 60 },
            isUseCustomPricer: false,
            getPrice: () => null,
            // Only the strange rifle is in the pricelist, so only it earns a `/max`.
            getPriceBySkuOrAsset: ({ priceKey }: { priceKey: string }) =>
                priceKey === STRANGE ? { sku: STRANGE, max: 5 } : null
        },
        handler: {
            getBotInfo: {
                name: 'TestBot',
                avatarURL: '',
                steamID: { getSteamID64: () => '76561198999999999' }
            },
            autokeys: {
                isEnabled: true,
                getActiveStatus: true,
                getOverallStatus: { isBuyingKeys: true, isBankingKeys: false },
                userPure: { minKeys: 1, maxKeys: 5, minRefs: 20, maxRefs: 80 }
            }
        },
        tf2: { backpackSlots: 2500 },
        craftWeapons: [],
        inventoryManager: {
            getInventory: {
                getTotalItems: 1234,
                // The inventory already reflects the accepted trade, so this is
                // the *new* stock — the summary reconstructs the old one from it.
                // Pure is held in bulk; a flat 2 would make the received keys
                // reconstruct to a negative old stock.
                getAmount: ({ priceKey }: { priceKey: string }) => (priceKey.startsWith('50') ? 30 : 2),
                // Bot holds 3 keys and 12.33 ref.
                getCurrencies: () => ({
                    '5021;6': new Array(3).fill(''),
                    '5002;6': new Array(12).fill(''),
                    '5001;6': new Array(1).fill(''),
                    '5000;6': new Array(0).fill('')
                })
            }
        },
        schema: { getName: (item: { defindex: number }) => `Item ${item.defindex}` },
        community: {
            getSteamUser: (_id: unknown, cb: (e: Error | null, u: unknown) => void) =>
                cb(null, { name: 'Scrapbank_Tim', getAvatarURL: () => 'https://example.invalid/avatar.jpg' })
        },
        getPricedbStoreUrl: () => 'https://store.pricedb.io/testbot'
    } as unknown as Bot;
}

function emptyAccepted() {
    return {
        invalidItems: [],
        disabledItems: [],
        overstocked: [],
        understocked: [],
        highValue: [],
        isMention: false
    };
}

/** The shape processAccepted builds: name in italics, one attachment per line. */
function acceptedWithHighValue() {
    return {
        ...emptyAccepted(),
        highValue: ['_Item 378_\n🎃 Spells: Exorcism\n🎰 Parts: Kills\n✨ Sheen: Manndarin'],
        isMention: true
    };
}

e2e('produces a Components V2 multipart payload with the card attached', async () => {
    requests.length = 0;

    await sendTradeSummary(makeOffer(), acceptedWithHighValue(), makeBot(), 4200, 3200, undefined, false, false);

    // sendWebhook fires without being awaited by the caller; give it a moment to land.
    await new Promise(resolve => setTimeout(resolve, 3000));

    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);

    // latin1 for binary-safe boundary/PNG searching; utf8 for the JSON itself,
    // which is full of emoji.
    const raw = req.body.toString('latin1');
    const payload = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(req.body.toString('utf8'));
    const webhook = JSON.parse(payload[1]) as Webhook;

    console.log('\n===== PAYLOAD DISCORD WOULD RECEIVE =====');
    console.log(JSON.stringify(webhook, null, 2));
    console.log('=========================================\n');

    // No embeds at all — the IS_COMPONENTS_V2 flag disables them entirely.
    expect(webhook.embeds).toBeUndefined();
    expect(webhook.flags).toBe(1 << 15);
    expect(webhook.allowed_mentions).toEqual({ parse: [], users: ['111222333'] });

    // isMention (high value) is true and ownerID is set, so a mention block
    // leads the message, ahead of the container.
    expect(webhook.components).toHaveLength(2);
    const [mention, container] = webhook.components as [TextDisplay, Container];
    expect(mention.type).toBe(10);
    expect(mention.content).toContain('<@!111222333>');
    expect(mention.content).toContain('High Value item');

    expect(container.type).toBe(17);
    expect(container.accent_color).toBe(9171753);

    // header, divider, image, their block, spacer, our block, divider, detail,
    // divider, subtext — exactly the container's 10-child ceiling.
    expect(container.components).toHaveLength(10);
    const [header, div1, gallery, theirBlock, div2, ourBlock, div3, detail, div4, subtext] = container.components as [
        TextDisplay,
        Separator,
        MediaGallery,
        TextDisplay,
        Separator,
        TextDisplay,
        Separator,
        TextDisplay,
        Separator,
        TextDisplay
    ];

    expect(header.type).toBe(10);
    expect(header.content).toContain('### ✅ Accepted (offer)');
    expect(header.content).toContain('📈 +');
    // The name carries the Steam link itself, so there is no separate one, and
    // all three destinations share a single line.
    // Underscore escaped so the persona name can't break the surrounding bold/link markup.
    expect(header.content).toContain('**[Scrapbank\\_Tim](https://steamcommunity.com/');
    expect(header.content).toContain('[backpack.tf](');
    expect(header.content).toContain('[rep.tf](');
    expect(header.content).not.toContain('[Steam](');
    expect(header.content.split('\n')).toHaveLength(2);

    expect(div1.type).toBe(14);
    expect(div1.divider).toBe(true);

    expect(gallery.type).toBe(12);
    expect(gallery.items[0].media.url).toBe('attachment://trade-7788990011.png');

    // Their side is pure only and still earns a block — pure is linked
    // alongside real items, same vocabulary the card's bands use.
    expect(theirBlock.type).toBe(10);
    expect(theirBlock.content.startsWith('📥 **They Sent**')).toBe(true);
    // Items came in, so the old stock is the current one *minus* the amount.
    expect(theirBlock.content).toContain('[Item 5021](https://pricedb.io/item/5021;6) ×12 (18 → 30)');
    // Keys before ref on their side.
    expect(theirBlock.content.indexOf('5021;6')).toBeLessThan(theirBlock.content.indexOf('5002;6'));

    expect(div2.type).toBe(14);
    expect(div2.divider).toBe(false);

    expect(ourBlock.type).toBe(10);
    expect(ourBlock.content.startsWith('📤 **For Our**')).toBe(true);
    // We gave both away, so the old stock is the current one plus the amount —
    // the bot's inventory already reflects the completed trade.
    expect(ourBlock.content).toContain('[Item 378](https://pricedb.io/item/378;5;u13) (3 → 2)');
    expect(ourBlock.content).toContain('[Item 199](https://pricedb.io/item/199;11;kt-3) ×2 (4 → 2/5)');
    // Pure sorts after real items on our side.
    expect(ourBlock.content.indexOf('378;5;u13')).toBeLessThan(ourBlock.content.indexOf('5021;6'));

    expect(div3.type).toBe(14);
    expect(div3.divider).toBe(true);

    expect(detail.type).toBe(10);
    expect(detail.content).toContain('💬 **Offer message:** "thanks man!"');
    // A small trade leaves the budget room to name the flagged items in full,
    // so the old `listItems` block replaces the count and high-value lines —
    // verbatim, markdown and all (its `@` field splitter is stripped).
    expect(detail.content).toContain('🔶`_HIGH_VALUE_ITEMS`');
    expect(detail.content).toContain('🎃 Spells: Exorcism');
    expect(detail.content).toContain('_Item 378_');
    // Prices never repeat in the text when the card rendered — they already
    // live on the card's PRICES section. The verbose listItems reuses only its
    // flag/high-value naming; key-rate and autokeys similarly stay on the card.
    expect(detail.content).not.toContain('📜 **Item prices**');
    expect(detail.content).not.toContain('🔑 Key rate');
    expect(detail.content).not.toContain('#7788990011');

    expect(div4.type).toBe(14);
    expect(div4.divider).toBe(true);

    expect(subtext.type).toBe(10);
    expect(subtext.content).toContain('-# 🤖 [Backpack](');
    expect(subtext.content).toContain('[Store](');
    expect(subtext.content).toContain('#7788990011');
    expect(subtext.content).toContain('76561198000000000');
    // Both the absolute and the relative form of the native timestamp.
    expect(subtext.content).toMatch(/<t:\d+:f>/);
    expect(subtext.content).toMatch(/<t:\d+:R>/);

    // Combined Text Display content must clear Discord's 4000-character ceiling.
    const totalText = [header, theirBlock, ourBlock, detail, subtext].reduce((n, c) => n + c.content.length, 0);
    expect(totalText).toBeLessThanOrEqual(4000);

    // The attached PNG must actually be present in the body.
    expect(raw).toContain('filename="trade-7788990011.png"');
    const pngStart = req.body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(pngStart).toBeGreaterThan(-1);

    const dir = path.resolve(outDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'e2e-payload.json'), JSON.stringify(webhook, null, 2));
    console.log(`payload written to ${path.join(dir, 'e2e-payload.json')}`);

    await fs.rm(getFilesPath(ACCOUNT), { recursive: true, force: true });
});

e2e('drops the profit chip when the trade is exactly even', async () => {
    requests.length = 0;

    const offer = makeOffer();
    const readable = offer as unknown as { data: (key: string) => unknown };
    const original = readable.data.bind(readable);
    const even = { ...(original('value') as object), their: { keys: 12, metal: 0, total: 6480 } };
    readable.data = (key: string) => (key === 'value' ? even : original(key));

    await sendTradeSummary(offer, emptyAccepted(), makeBot(), 4200, 3200, undefined, false, false);
    await new Promise(resolve => setTimeout(resolve, 3000));

    const payload = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(requests[0].body.toString('utf8'));
    const webhook = JSON.parse(payload[1]) as Webhook;

    // No mention on this fixture (no invalid items, no high-value mention), so
    // the container leads the components array directly.
    const container = webhook.components[0] as Container;
    const header = container.components[0] as TextDisplay;

    console.log('even-trade header:', JSON.stringify(header.content));
    expect(header.content).not.toContain('📈');
    expect(header.content).not.toContain('📉');
});

e2e('omits the media gallery and falls back to plain JSON when tradeCard.enable is false', async () => {
    requests.length = 0;

    const bot = makeBot();
    bot.options.discordWebhook.tradeSummary.tradeCard.enable = false;

    await sendTradeSummary(makeOffer(), emptyAccepted(), bot, 4200, 3200, undefined, false, false);
    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(requests).toHaveLength(1);
    // No attachment to upload, so this stays a plain JSON body rather than multipart.
    expect(requests[0].contentType).toContain('application/json');

    const webhook = JSON.parse(requests[0].body.toString('utf8')) as Webhook;
    const container = webhook.components[0] as Container;

    console.log(
        'no-card children:',
        container.components.map(c => c.type)
    );

    // No card, no attachment — so no media gallery component at all, but the
    // item links and detail still carry the same information as text.
    expect(container.components.some(c => c.type === 12)).toBe(false);
    // The status text folds into the existing detail child, never a new one.
    expect(container.components.length).toBeLessThanOrEqual(10);

    const theirBlock = container.components.find((c): c is TextDisplay => c.type === 10 && c.content.startsWith('📥'));
    expect(theirBlock?.content).toContain('Item 5021');

    const ourBlock = container.components.find((c): c is TextDisplay => c.type === 10 && c.content.startsWith('📤'));
    expect(ourBlock?.content).toContain('Item 378');

    // Without the card, the bot's status and the priced items fall back to the
    // detail text, drawn from the same readings the card would have used.
    const detail = container.components.find(
        (c): c is TextDisplay => c.type === 10 && c.content.includes('💬 **Offer message:**')
    );
    expect(detail?.content).toContain('🔑 Key rate:');
    expect(detail?.content).toContain('💰 Pure stock:');
    expect(detail?.content).toContain('🎒 Total items:');
    expect(detail?.content).toContain('⏱ **Time taken:**');
    expect(detail?.content).toContain('📜 **Item prices**');
});

it('restores the legacy embed when tradeCard.enable is false', async () => {
    requests.length = 0;

    const bot = makeBot();
    bot.options.discordWebhook.tradeSummary.tradeCard.enable = false;

    await sendTradeSummary(makeOffer(), emptyAccepted(), bot, 4200, 3200, undefined, false, false);
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(requests).toHaveLength(1);
    expect(requests[0].contentType).toContain('application/json');

    const webhook = JSON.parse(requests[0].body.toString('utf8')) as Webhook;
    expect(webhook.components).toBeUndefined();
    expect(webhook.flags).toBeUndefined();
    expect(webhook.embeds).toHaveLength(1);
    expect(webhook.embeds![0].author?.name).toBe('Scrapbank_Tim');
    expect(webhook.embeds![0].fields?.map(field => field.name)).toEqual(['__Item list__', '__Status__']);
});

e2e('renders pure as its emoji token when showPureInEmoji is on', async () => {
    requests.length = 0;

    const bot = makeBot();
    // Pure keys become the custom emoji on the card and in the item list alike.
    bot.options.tradeSummary.showPureInEmoji = true;

    await sendTradeSummary(makeOffer(), emptyAccepted(), bot, 4200, 3200, undefined, false, false);
    await new Promise(resolve => setTimeout(resolve, 1500));

    const payload = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(requests[0].body.toString('utf8'));
    const webhook = JSON.parse(payload[1]) as Webhook;
    const container = webhook.components[0] as Container;

    const theirBlock = container.components.find((c): c is TextDisplay => c.type === 10 && c.content.startsWith('📥'));
    // Keys sort first on their side, so the first link's text is the emoji.
    expect(theirBlock?.content).toContain('[<:tf2key:813050393793658930>](https://pricedb.io/item/5021;6)');
});

e2e('keeps the verbose message within the text budget', async () => {
    requests.length = 0;

    const bot = makeBot();
    bot.options.discordWebhook.tradeSummary.tradeCard.enable = false;
    bot.options.tradeSummary.showPureInEmoji = true;

    // 30 distinct skus a side (none collapsing to pure) so the item links work
    // at their widest; the card is absent, so the status text joins the detail.
    const many = (offset: number): Record<string, number> =>
        Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${1000 + offset + i};6`, 1]));

    const offer = makeOffer();
    const readable = offer as unknown as { data: (key: string) => unknown };
    const original = readable.data.bind(readable);
    const multi = { ...(original('dict') as object), our: many(0), their: many(1000) };
    readable.data = (key: string) => (key === 'dict' ? multi : original(key));

    await sendTradeSummary(offer, emptyAccepted(), bot, 4200, 3200, 2600, false, false);
    await new Promise(resolve => setTimeout(resolve, 1500));

    // No card means no attachment, so the body is plain JSON rather than multipart.
    expect(requests[0]?.contentType).toContain('application/json');
    const webhook = JSON.parse(requests[0].body.toString('utf8')) as Webhook;
    const container = webhook.components[0] as Container;
    const texts = container.components.filter((c): c is TextDisplay => c.type === 10);

    // The status text landed inside the detail child (card absent).
    expect(container.components.length).toBeLessThanOrEqual(10);
    const detail = texts.find(c => c.content.includes('📜 **Item prices**'));
    expect(detail?.content).toContain('Key rate:');

    const total = texts.reduce((n, c) => n + c.content.length, 0);
    expect(total).toBeLessThanOrEqual(4000);

    // Degradation collapses to "+N more" rather than a mid-markdown cut.
    texts.forEach(c => {
        expect(c.content).not.toMatch(/\[[^\]]*$/);
        expect(c.content).not.toMatch(/\]\([^)]*$/);
    });
});

describe('buildItemLinkBlocks', () => {
    function withDict(dict: unknown): TradeOffer {
        const offer = makeOffer();
        const readable = offer as unknown as { data: (key: string) => unknown };
        const original = readable.data.bind(readable);
        readable.data = (key: string) => (key === 'dict' ? dict : original(key));

        return offer;
    }

    it('returns one block per side, theirs first', () => {
        const blocks = buildItemLinkBlocks(makeOffer(), makeBot());

        expect(blocks).toHaveLength(2);
        expect(blocks[0].startsWith('📥 **They Sent**')).toBe(true);
        expect(blocks[1].startsWith('📤 **For Our**')).toBe(true);
    });

    it('omits a side with nothing at all', () => {
        // A gift: nothing came back, so the other side contributes no block.
        const blocks = buildItemLinkBlocks(withDict({ our: { [UNUSUAL]: 1 }, their: {} }), makeBot());

        expect(blocks).toHaveLength(1);
        expect(blocks[0].startsWith('📤 **For Our**')).toBe(true);
    });

    /** Real, and well past both the old 34-character clamp and the tight-budget one. */
    const LONG_NAME = 'Strange Festivized Professional Killstreak Australium Minigun';

    function withLongNames(): Bot {
        const bot = makeBot();
        (bot as unknown as { schema: unknown }).schema = { getName: () => LONG_NAME };
        // Otherwise replace.itemName abbreviates the qualities away and there is
        // nothing long left to clamp.
        bot.options.tradeSummary.showProperName = true;

        return bot;
    }

    it('spells a long item name out in full when the budget allows', () => {
        const blocks = buildItemLinkBlocks(withDict({ our: {}, their: { [STRANGE]: 1 } }), withLongNames());

        expect(blocks[0]).toContain(LONG_NAME);
        expect(blocks[0]).not.toContain('…');
    });

    it('clamps names only once the budget is tight', () => {
        // Small enough to force the stage, large enough that names survive at all.
        const blocks = buildItemLinkBlocks(
            withDict({ our: manySkus(0, 8), their: manySkus(500, 8) }),
            withLongNames(),
            700
        );

        expect(blocks.join('')).toContain('…');
        expect(blocks.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(700);
    });

    /** 30 skus a side, none of which collapse to pure, to force every degradation stage. */
    function manySkus(offset: number, count: number): Record<string, number> {
        const dict: Record<string, number> = {};
        for (let i = 0; i < count; i++) {
            dict[`${1000 + offset + i};6`] = 1;
        }
        return dict;
    }

    it('stays inside the text budget on a huge trade, with no truncated link', () => {
        const offer = withDict({ our: manySkus(0, 30), their: manySkus(1000, 30) });
        const blocks = buildItemLinkBlocks(offer, makeBot());

        const totalLength = blocks.reduce((n, b) => n + b.length, 0);
        expect(totalLength).toBeLessThanOrEqual(3850);

        // A truncated markdown link would leave an unclosed `[` or `(` at the
        // point of the cut, rather than a clean `+N more` collapse.
        blocks.forEach(block => {
            expect(block).not.toMatch(/\[[^\]]*$/);
            expect(block).not.toMatch(/\]\([^)]*$/);
        });
    });

    it('degrades within a tight budget rather than truncating mid-link', () => {
        const offer = withDict({ our: manySkus(0, 30), their: manySkus(1000, 30) });
        const blocks = buildItemLinkBlocks(offer, makeBot(), 300);

        const totalLength = blocks.reduce((n, b) => n + b.length, 0);
        expect(totalLength).toBeLessThanOrEqual(300);
        blocks.forEach(block => {
            expect(block).not.toMatch(/\[[^\]]*$/);
            expect(block).not.toMatch(/\]\([^)]*$/);
        });
    });
});
