import Bot from '../Bot';
import { createEventSource } from 'eventsource-client';
import { PriceDBEventStreamLogger } from './PriceDBEventStreamLogger';
import { HeartBeatEventEnvelope, TradeRequestEventEnvelope } from './types';
import { Handler as Processor } from './Processor';
import { RestartConnectionError } from './RestartConnectionError';

export class PriceDBEventStreamListener {
    private onTradeRequest: Set<Processor<TradeRequestEventEnvelope>> = new Set();

    private onHeartBeat: Set<Processor<HeartBeatEventEnvelope>> = new Set();

    constructor(
        private readonly bot: Bot,
        private readonly eventStreamUrl: string,
        private readonly logger: PriceDBEventStreamLogger
    ) {}

    async start(): Promise<void> {
        this.logger.info('Initializing...');

        for (;;) {
            try {
                await this.hotLoop();
            } catch (e) {
                if (!(e instanceof RestartConnectionError)) {
                    this.logger.error(
                        'Creating a new connection in 15 seconds because something went very wrong...',
                        e
                    );
                    await new Promise(res => setTimeout(res, 15_000));
                }
            }
        }
    }

    public addOnTradeRequestProcessor(processor: Processor<TradeRequestEventEnvelope>) {
        this.onTradeRequest.add(processor);
    }

    public removeOnTradeRequestProcessor(processor: Processor<TradeRequestEventEnvelope>) {
        this.onTradeRequest.delete(processor);
    }

    public addOnHeartBeatProcessor(processor: Processor<HeartBeatEventEnvelope>) {
        this.onHeartBeat.add(processor);
    }

    public removeHeartBeatProcessor(processor: Processor<HeartBeatEventEnvelope>) {
        this.onHeartBeat.delete(processor);
    }

    private async hotLoop() {
        const authToken = await this.bot.pricedbStoreManager.getAuthToken();
        if (!authToken.ok) {
            throw new Error('Auth Token could not be fetched');
        }
        this.logger.info('Collected Auth Token...');

        const url = new URL(this.eventStreamUrl);
        url.searchParams.set('token', authToken.token);

        const eventSource = createEventSource(url);
        this.logger.info('Created connection...');

        try {
            for await (const { data, event } of eventSource) {
                await this.process(JSON.parse(data), event);
            }
        } finally {
            eventSource.close();
        }
    }

    private async process(data: unknown, event: string) {
        try {
            switch (event) {
                case 'heartbeat':
                    await this.processWith(this.onHeartBeat, data);
                    break;
                case 'trade_request':
                    await this.processWith(this.onTradeRequest, data);
                    break;
                default:
                    this.logger.warn('Unknown event type encountered, an upgrade may be required...', event);
            }
        } catch (e) {
            if (e instanceof RestartConnectionError) {
                throw e;
            }
            this.logger.error(`Could not handle event ${event}, an error occurred`, e);
        }
    }

    // This method is not typesafe, the inferred generic T is almost always unknown.
    // You can pass a Set<Processor<Dog>> and a Cat for T, and Typescript will infer.
    // processWith<unknown>(processor: Set<Processor<unknown>, data: unknown).
    private async processWith<T>(processors: Set<Processor<T>>, data: T) {
        return await Promise.all([...processors].map(p => p.process(data)));
    }
}
