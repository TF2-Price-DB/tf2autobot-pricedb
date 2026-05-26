import Bot from '../Bot';
import { CritTFEventStreamLogger } from './CritTFEventStreamLogger';
import { RestartConnectionError } from './RestartConnectionError';
import { HeartBeatEventEnvelope } from './types';

export class OnHeartBeat {
    constructor(private bot: Bot, private logger: CritTFEventStreamLogger) {}

    async process(_: HeartBeatEventEnvelope) {
        if (!(await this.bot.critTFStoreManager.sendDeadMansRequest())) {
            throw new RestartConnectionError();
        }

        this.logger.debug('The connection is okay');
    }
}
