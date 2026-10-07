import { PassThrough } from 'node:stream';
import type Bot from '../Bot';
import type NextCritDriver from '../NextCritDriver';
import NextCritCheckout from '../NextCritCheckout';
import NextCritCheckoutCart from '../Carts/NextCritCheckoutCart';

jest.mock('../Carts/NextCritCheckoutCart');
jest.mock('../../lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

const buyer = '76561198000000001';
const owner = '76561198000000000';
const request = {
    type: 'trade_request',
    listing_type: 'sell',
    listing_id: 2,
    quantity: 2,
    requester_steam64: buyer,
    trade_offer_url: 'https://steamcommunity.com/tradeoffer/new/?partner=39734273&token=trade-token',
    asset_ids: ['101', '102']
};

function setup() {
    const stream = new PassThrough();
    const openEventStream = jest.fn().mockResolvedValue(stream);
    const enqueue = jest.fn().mockReturnValue(0);
    const getPosition = jest.fn().mockReturnValue(-1);
    const getActiveOffer = jest.fn().mockReturnValue(null);
    const bot = {
        isReady: true,
        isHalted: false,
        botManager: { isStopping: false },
        client: { steamID: { getSteamID64: () => owner } },
        handler: { cartQueue: { enqueue, getPosition } },
        trades: { getActiveOffer }
    } as unknown as Bot;
    const checkout = new NextCritCheckout(bot, { openEventStream } as unknown as NextCritDriver);
    return { checkout, bot, stream, openEventStream, enqueue, getPosition, getActiveOffer };
}

function event(requests: unknown[], steam64s: string[] | null = [owner]): string {
    return `data: ${JSON.stringify([{ steam64s, message: JSON.stringify(requests) }])}\n\n`;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
});
afterEach(() => {
    jest.useRealTimers();
});

async function start(checkout: NextCritCheckout): Promise<void> {
    checkout.start();
    await Promise.resolve();
}

test('queues exact assets for the authenticated buyer using the trade token', async () => {
    const { checkout, stream, enqueue } = setup();
    await start(checkout);
    stream.write(event([request]));
    expect(NextCritCheckoutCart).toHaveBeenCalledWith(
        expect.objectContaining({ accountid: 39734273 }),
        'trade-token',
        expect.anything(),
        expect.anything(),
        ['101', '102']
    );
    expect(enqueue).toHaveBeenCalledWith(expect.any(NextCritCheckoutCart), false, false);
    checkout.stop();
});

test.each([
    { quantity: 1 },
    { quantity: '2' },
    { asset_ids: [] },
    { asset_ids: [101, 102] },
    { requester_steam64: 123 },
    { asset_ids: ['101', '101'] },
    { asset_ids: ['not-an-id', '102'] },
    { requester_steam64: owner },
    { trade_offer_url: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=x' },
    { trade_offer_url: 'https://steamcommunity.com.evil.invalid/tradeoffer/new/?partner=39734273&token=x' },
    { trade_offer_url: 'https://steamcommunity.com/tradeoffer/new/?partner=39734273' },
    { trade_offer_url: 'https://steamcommunity.com/tradeoffer/new/?partner=39734273&partner=1&token=x' }
])('rejects invalid checkout details %s', async changes => {
    const { checkout, stream, enqueue } = setup();
    await start(checkout);
    stream.write(event([{ ...request, ...changes }]));
    expect(enqueue).not.toHaveBeenCalled();
    checkout.stop();
});

test.each([
    'invalid json',
    JSON.stringify({ steam64s: [owner], message: JSON.stringify([request]) }),
    JSON.stringify([{ steam64s: owner, message: JSON.stringify([request]) }]),
    JSON.stringify([{ steam64s: [owner], message: JSON.stringify(request) }]),
    JSON.stringify([{ steam64s: [owner], message: [request] }])
])('rejects malformed event payloads and processes the next event: %s', async data => {
    const { checkout, stream, enqueue } = setup();
    await start(checkout);
    stream.write(`data: ${data}\n\n`);
    expect(enqueue).not.toHaveBeenCalled();
    stream.write(event([request]));
    expect(enqueue).toHaveBeenCalledTimes(1);
    checkout.stop();
});

test('ignores buys, other message types, broadcasts and messages for another bot', async () => {
    const { checkout, stream, enqueue } = setup();
    await start(checkout);
    stream.write(event([{ ...request, listing_type: 'buy' }, { type: 'price_update' }]));
    stream.write(event([request], [buyer]));
    stream.write(event([request], null));
    expect(enqueue).not.toHaveBeenCalled();
    checkout.stop();
});

test.each(['queued', 'active'])('does not duplicate a buyer with an existing %s trade', async state => {
    const { checkout, stream, enqueue, getPosition, getActiveOffer } = setup();
    if (state === 'queued') getPosition.mockReturnValue(0);
    else getActiveOffer.mockReturnValue('offer-1');
    await start(checkout);
    stream.write(event([request]));
    expect(enqueue).not.toHaveBeenCalled();
    checkout.stop();
});

test('reconnects once after close and keeps a healthy stream open across token expiry', async () => {
    const { checkout, stream, openEventStream } = setup();
    const renewed = new PassThrough();
    openEventStream.mockResolvedValueOnce(stream).mockResolvedValue(renewed);
    await start(checkout);
    stream.emit('end');
    stream.emit('close');
    await jest.advanceTimersByTimeAsync(3000);
    expect(openEventStream).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(14 * 60 * 1000 + 3000);
    expect(openEventStream).toHaveBeenCalledTimes(2);
    checkout.stop();
});

test('aborts an in-flight connection and destroys a stream that arrives after stop', async () => {
    const { checkout, stream, openEventStream, enqueue } = setup();
    let finish: (value: PassThrough) => void;
    openEventStream.mockReturnValue(
        new Promise(resolve => {
            finish = resolve;
        })
    );
    checkout.start();
    const [signal] = openEventStream.mock.calls[0] as [AbortSignal];
    checkout.stop();
    expect(signal.aborted).toBe(true);
    finish(stream);
    await Promise.resolve();
    expect(stream.destroyed).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
});

test('stopped or halted bots do not act on checkout messages', async () => {
    const { checkout, bot, stream, enqueue } = setup();
    await start(checkout);
    Object.assign(bot, { isHalted: true });
    stream.write(event([request]));
    expect(enqueue).not.toHaveBeenCalled();
    checkout.stop();
});
