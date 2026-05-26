import Bot from '../Bot';
import { OnHeartBeat } from './OnHeartBeat';
import { OnTradeRequest } from './OnTradeRequest';
import { CritTFEventStreamListener } from './CritTFEventStreamListener';
import { CritTFEventStreamLogger } from './CritTFEventStreamLogger';

export function enableTradeRequestListener(bot: Bot) {
    const logger = new CritTFEventStreamLogger();
    const eventStreamUrl = process.env.TRADE_REQUEST_EVENT_STREAM_URL ?? 'https://events.pricedb.io/event-stream';
    if (!eventStreamUrl) {
        logger.warn('Not starting because TRADE_REQUEST_EVENT_STREAM_URL not configured.');
        return;
    }

    const stream = new CritTFEventStreamListener(bot, eventStreamUrl, logger);
    stream.addOnTradeRequestProcessor(new OnTradeRequest(bot, logger));
    stream.addOnHeartBeatProcessor(new OnHeartBeat(bot, logger));

    void stream.start().catch(err => {
        logger.error('Trade request listener stopped with an error', err);
    });
}
