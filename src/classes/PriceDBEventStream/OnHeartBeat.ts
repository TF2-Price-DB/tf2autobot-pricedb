import Bot from '../Bot';
import { PriceDBEventStreamLogger } from './PriceDBEventStreamLogger';
import { RestartConnectionError } from './RestartConnectionError';
import { HeartBeatEventEnvelope } from './types';

export class OnHeartBeat {
    constructor(private bot: Bot, private logger: PriceDBEventStreamLogger) {}

    async process(_: HeartBeatEventEnvelope) {
        if (!(await this.bot.pricedbStoreManager.sendDeadMansRequest())) {
            this.logger.warn('Connection is not okay');
            throw new RestartConnectionError();
        }

        this.logger.debug('The connection is okay');
    }
}
