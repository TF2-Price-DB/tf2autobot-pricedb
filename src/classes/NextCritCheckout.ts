import type { Readable } from 'node:stream';
import SteamID from 'steamid';
import type Bot from './Bot';
import type NextCritDriver from './NextCritDriver';
import NextCritCheckoutCart from './Carts/NextCritCheckoutCart';
import NextCritEvents from '../lib/nextCritEvents';
import log from '../lib/logger';

export default class NextCritCheckout {
    private connection: AbortController | undefined;

    private stream: Readable | undefined;

    private reconnectTimer: NodeJS.Timeout | undefined;

    private running = false;

    constructor(private readonly bot: Bot, private readonly driver: NextCritDriver) {}

    start(): void {
        if (this.running || !this.available) return;
        this.running = true;
        void this.connect();
    }

    stop(): void {
        this.running = false;
        clearTimeout(this.reconnectTimer);
        this.connection?.abort();
        this.stream?.destroy();
        this.connection = undefined;
        this.stream = undefined;
    }

    private get available(): boolean {
        return this.bot.isReady && !this.bot.isHalted && !this.bot.botManager.isStopping;
    }

    private async connect(): Promise<void> {
        if (!this.running || !this.available) return;
        const connection = new AbortController();
        this.connection = connection;
        let finished = false;
        const reconnect = (): void => {
            if (finished) return;
            finished = true;
            connection.abort();
            if (this.connection !== connection) return;
            if (!this.running) return;
            this.stream?.destroy();
            this.stream = undefined;
            this.reconnectTimer = setTimeout(() => void this.connect(), 3000);
        };
        try {
            const stream = await this.driver.openEventStream(connection.signal);
            if (this.connection !== connection || !this.running) {
                stream.destroy();
                return;
            }
            this.stream = stream;
            const parser = new NextCritEvents(data => this.handleMessages(data));
            stream.setEncoding('utf8');
            stream.on('data', (chunk: string) => {
                if (finished || this.connection !== connection || !this.running) return;
                try {
                    parser.push(chunk);
                } catch {
                    log.warn('NextCrit checkout received an invalid event stream');
                    reconnect();
                }
            });
            stream.on('error', () => reconnect());
            stream.on('end', reconnect);
            stream.on('close', reconnect);
        } catch {
            // Stream errors can contain authenticated URLs. Do not log the original error.
            if (this.connection === connection && this.running) {
                log.warn('NextCrit checkout event stream disconnected; reconnecting');
            }
            reconnect();
        }
    }

    private handleMessages(data: string): void {
        if (!this.running || !this.available) return;
        try {
            const envelopes: unknown = JSON.parse(data);
            if (!Array.isArray(envelopes)) throw new Error('Invalid NextCrit envelopes');
            const steam64 = this.bot.client.steamID.getSteamID64();
            for (const envelope of envelopes as unknown[]) {
                if (!envelope || typeof envelope !== 'object') continue;
                const targets: unknown = Reflect.get(envelope, 'steam64s');
                const message: unknown = Reflect.get(envelope, 'message');
                if (!Array.isArray(targets) || !targets.includes(steam64) || typeof message !== 'string') continue;
                const requests: unknown = JSON.parse(message);
                if (!Array.isArray(requests)) throw new Error('Invalid NextCrit messages');
                for (const request of requests as unknown[]) {
                    try {
                        this.enqueue(request);
                    } catch {
                        log.warn('NextCrit checkout rejected an invalid or unavailable sell request');
                    }
                }
            }
        } catch {
            log.warn('NextCrit checkout received an invalid message');
        }
    }

    private enqueue(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        if (Reflect.get(value, 'type') !== 'trade_request' || Reflect.get(value, 'listing_type') !== 'sell') return;
        const requester: unknown = Reflect.get(value, 'requester_steam64');
        const tradeUrl: unknown = Reflect.get(value, 'trade_offer_url');
        const assetIds: unknown = Reflect.get(value, 'asset_ids');
        const quantity: unknown = Reflect.get(value, 'quantity');
        if (
            typeof requester !== 'string' ||
            !/^7656119\d{10}$/.test(requester) ||
            typeof tradeUrl !== 'string' ||
            !Array.isArray(assetIds) ||
            assetIds.length === 0 ||
            quantity !== assetIds.length ||
            assetIds.some((id: unknown) => typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) ||
            new Set(assetIds).size !== assetIds.length
        )
            throw new Error('Invalid NextCrit checkout request');
        const partner = new SteamID(requester);
        const url = new URL(tradeUrl);
        const token = url.searchParams.get('token');
        if (
            !partner.isValid() ||
            requester === this.bot.client.steamID.getSteamID64() ||
            url.protocol !== 'https:' ||
            url.hostname !== 'steamcommunity.com' ||
            url.port !== '' ||
            url.username !== '' ||
            url.password !== '' ||
            url.pathname !== '/tradeoffer/new/' ||
            url.searchParams.getAll('partner').length !== 1 ||
            url.searchParams.get('partner') !== String(partner.accountid) ||
            url.searchParams.getAll('token').length !== 1 ||
            !token
        )
            throw new Error('NextCrit checkout trade URL does not match the buyer');
        if (this.bot.handler.cartQueue.getPosition(partner) !== -1 || this.bot.trades.getActiveOffer(partner)) return;
        const cart = new NextCritCheckoutCart(partner, token, this.bot, this.driver, assetIds as string[]);
        this.bot.handler.cartQueue.enqueue(cart, false, false);
    }
}
