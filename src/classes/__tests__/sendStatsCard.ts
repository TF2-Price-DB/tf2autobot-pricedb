jest.mock('../../lib/tools/polldata', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../DiscordWebhook/utils', () => ({
    sendWebhook: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../DiscordWebhook/tradeCard/cardRenderClient', () => ({
    renderCard: jest.fn()
}));

import loadPollData from '../../lib/tools/polldata';
import { sendWebhook } from '../DiscordWebhook/utils';
import { renderCard } from '../DiscordWebhook/tradeCard/cardRenderClient';
import sendStats from '../DiscordWebhook/sendStats';
import Bot from '../Bot';
import type { Component, Container, MediaGallery, TextDisplay, Webhook } from '../DiscordWebhook/interfaces';

const loadPollDataMock = loadPollData as jest.MockedFunction<typeof loadPollData>;
const sendWebhookMock = sendWebhook as jest.MockedFunction<typeof sendWebhook>;
const renderCardMock = renderCard as jest.MockedFunction<typeof renderCard>;

const COMPONENTS_V2_FLAG = 1 << 15;
const HOOK_URL = 'https://example/hook';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeBot(): Bot {
    return {
        pricelist: {
            getKeyPrice: { metal: 64.11 },
            getKeyPrices: {
                buy: { metal: 63.88 },
                sell: { metal: 64.11 }
            }
        },
        options: {
            timezone: 'UTC',
            statistics: {
                lastTotalTrades: 0,
                lastTotalProfitMadeInRef: 0,
                profitDataSinceInUnix: 0,
                startingTimeInUnix: 0
            },
            discordWebhook: {
                displayName: 'TestBot',
                avatarURL: 'https://example/avatar.png',
                embedColor: '9171753',
                sendStats: { enable: true, url: HOOK_URL }
            }
        },
        handler: {
            getPaths: { files: { dir: '/tmp/' } },
            getBotInfo: {
                name: 'BotName',
                avatarURL: 'https://example/bot.png',
                steamID: '76561198000000000'
            }
        },
        isAdmin: () => false,
        sendMessage: jest.fn()
    } as unknown as Bot;
}

function emptyPoll(): { offerData: Record<string, never>; timestamps: Record<string, never> } {
    return { offerData: {}, timestamps: {} };
}

function webhookOf(call = 0): Webhook {
    return sendWebhookMock.mock.calls[call][1] as Webhook;
}

function walk(components: Component[] | undefined, visit: (c: Component) => void): void {
    for (const c of components ?? []) {
        visit(c);
        if (c.type === 17) {
            walk((c as Container).components, visit);
        }
    }
}

function textContents(webhook: Webhook): string[] {
    const out: string[] = [];
    walk(webhook.components, c => {
        if (c.type === 10) out.push((c as TextDisplay).content);
    });
    return out;
}

function mediaUrls(webhook: Webhook): string[] {
    const out: string[] = [];
    walk(webhook.components, c => {
        if (c.type === 12) {
            out.push(...(c as MediaGallery).items.map(item => item.media.url));
        }
    });
    return out;
}

function estimatePoll(): { offerData: Record<string, unknown>; timestamps: Record<string, number> } {
    const now = Date.now();
    return {
        offerData: {
            est: {
                handledByUs: true,
                isAccepted: true,
                partner: '76561198000000001',
                handleTimestamp: now,
                tradeProfit: {
                    rawProfit: { keys: 0, metal: 1 },
                    hasEstimates: true,
                    timestamp: now
                }
            }
        },
        timestamps: { est: now }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    loadPollDataMock.mockReturnValue(emptyPoll() as never);
    sendWebhookMock.mockResolvedValue(undefined);
    renderCardMock.mockResolvedValue(null);
});

it('puts key rate, bot version, and timezone time in the footer', async () => {
    process.env.BOT_VERSION_LABEL = 'v-test';
    await sendStats(makeBot());

    const texts = textContents(webhookOf()).join('\n');
    expect(texts).toContain('Key rate 63.88 / 64.11 ref');
    expect(texts).toContain('v-test');
});

it('sends a Components V2 stats card with attachment://stats.png when renderCard returns a buffer', async () => {
    renderCardMock.mockResolvedValue(PNG);

    await sendStats(makeBot());

    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const [url, payload, event, index, attachment] = sendWebhookMock.mock.calls[0];
    expect(url).toBe(HOOK_URL);
    expect(event).toBe('statistics');
    expect(index).toBeUndefined();
    expect(payload.flags).toBe(COMPONENTS_V2_FLAG);
    expect(payload.components).toBeDefined();
    expect(mediaUrls(payload)).toContain('attachment://stats.png');
    expect(attachment).toEqual({ name: 'stats.png', buffer: PNG });
});

it('sends V2 without type 12 media or attachment when renderCard returns null', async () => {
    renderCardMock.mockResolvedValue(null);

    await sendStats(makeBot());

    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const payload = webhookOf();
    expect(payload.flags).toBe(COMPONENTS_V2_FLAG);
    expect(mediaUrls(payload)).toEqual([]);
    expect(sendWebhookMock.mock.calls[0][4]).toBeUndefined();
});

it('does not include the 13-row outcome tree under the card', async () => {
    await sendStats(makeBot());

    const texts = textContents(webhookOf()).join('\n');
    expect(texts).not.toContain('__Type/Duration__');
    expect(texts).not.toContain('**• Processed:**');
});

it('includes the estimates line only when profit() sets hasEstimates', async () => {
    await sendStats(makeBot());
    expect(textContents(webhookOf()).join('\n')).not.toContain('⚠️ Contains estimates');

    sendWebhookMock.mockClear();
    loadPollDataMock.mockReturnValue(estimatePoll() as never);
    await sendStats(makeBot());
    expect(textContents(webhookOf()).join('\n')).toContain('⚠️ Contains estimates');
});

it('does not send a webhook when loadPollData returns null', async () => {
    loadPollDataMock.mockReturnValue(null as never);

    await sendStats(makeBot());

    expect(sendWebhookMock).not.toHaveBeenCalled();
});
