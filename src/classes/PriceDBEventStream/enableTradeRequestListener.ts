import Bot from '../Bot';
import { OnHeartBeat } from './OnHeartBeat';
import { OnTradeRequest } from './OnTradeRequest';
import { PriceDBEventStreamListener } from './PriceDBEventStreamListener';
import { PriceDBEventStreamLogger } from './PriceDBEventStreamLogger';

export function enableTradeRequestListener(bot: Bot) {
    const logger = new PriceDBEventStreamLogger();
    const eventStreamUrl = process.env.TRADE_REQUEST_EVENT_STREAM_URL;
    if (!eventStreamUrl) {
        logger.warn('Not starting because TRADE_REQUEST_EVENT_STREAM_URL not configured.');
        return;
    }

    const stream = new PriceDBEventStreamListener(bot, eventStreamUrl, logger);
    stream.addOnTradeRequestProcessor(new OnTradeRequest(bot, logger));
    stream.addOnHeartBeatProcessor(new OnHeartBeat(bot, logger));

    void stream.start().catch(err => {
        logger.error('Trade request listener stopped with an error', err);
    });
}
