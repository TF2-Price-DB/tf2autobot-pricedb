import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Bot from '../Bot';
import NextCritDriver from '../NextCritDriver';
import NextCritCheckout from '../NextCritCheckout';
import NextCritCheckoutCart from '../Carts/NextCritCheckoutCart';

jest.mock('../Carts/NextCritCheckoutCart');
jest.mock('../../lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

test('authenticates and consumes a fragmented checkout event over a real HTTP stream', async () => {
    const owner = '76561198000000000';
    const token = 'listener-token&needs=encoding';
    const received: { token?: string; apiKey?: string; accept?: string } = {};
    let queued: () => void;
    const enqueued = new Promise<void>(resolve => {
        queued = resolve;
    });
    const enqueue = jest.fn(() => {
        queued();
        return 0;
    });
    const bot = {
        isReady: true,
        isHalted: false,
        botManager: { isStopping: false },
        client: { steamID: { getSteamID64: () => owner } },
        handler: { cartQueue: { enqueue, getPosition: () => -1 } },
        trades: { getActiveOffer: () => null }
    } as unknown as Bot;
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/api/v2/auth') {
            received.apiKey = req.headers['x-api-key'] as string;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token }));
        } else if (url.pathname === '/api/events/v2') {
            received.token = url.searchParams.get('token');
            received.accept = req.headers.accept;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(': connected\r\n\r\n');
            const data = JSON.stringify([
                {
                    steam64s: [owner],
                    message: JSON.stringify([
                        {
                            type: 'trade_request',
                            listing_type: 'sell',
                            quantity: 1,
                            requester_steam64: '76561198000000001',
                            asset_ids: ['101'],
                            trade_offer_url:
                                'https://steamcommunity.com/tradeoffer/new/?partner=39734273&token=trade-token'
                        }
                    ])
                }
            ]);
            res.write(`da`);
            setImmediate(() => res.write(`ta: ${data.slice(0, 50)}`));
            setImmediate(() => res.write(`${data.slice(50)}\r\n\r\n`));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const checkout = new NextCritCheckout(bot, new NextCritDriver('test-api-key', `http://127.0.0.1:${port}`));
    let timeout: NodeJS.Timeout;
    try {
        checkout.start();
        await Promise.race([
            enqueued,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Checkout event not received')), 3000);
            })
        ]);
        expect(received).toEqual({ token, apiKey: 'test-api-key', accept: 'text/event-stream' });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(NextCritCheckoutCart).toHaveBeenCalledWith(expect.anything(), 'trade-token', bot, expect.anything(), [
            '101'
        ]);
    } finally {
        clearTimeout(timeout);
        checkout.stop();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
