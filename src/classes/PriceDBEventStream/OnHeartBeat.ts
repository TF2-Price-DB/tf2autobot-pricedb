import Bot from '../Bot';
import { PriceDBEventStreamLogger } from './PriceDBEventStreamLogger';
import { HeartBeatEventEnvelope } from './types';

export class OnHeartBeat {
    constructor(private bot: Bot, private logger: PriceDBEventStreamLogger) {}

    async process(_: HeartBeatEventEnvelope) {
        if (!(await this.bot.pricedbStoreManager.sendDeadMansRequest())) {
            this.logger.warn('Connection is not okay');
            return;
        }

        this.logger.debug('The connection is okay');
    }
}
