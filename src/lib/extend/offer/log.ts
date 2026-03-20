import { TradeOffer } from '@tf2autobot/tradeoffer-manager';

import { createLogger, ServiceLogger } from '../../logger';

const log = createLogger('Trades');

export = function (level: string, message: string): void {
    const self = this as TradeOffer;

    const text =
        'Offer' +
        (self.id ? ' #' + self.id : '') +
        (self.isOurOffer ? ' with ' : ' from ') +
        self.partner.getSteamID64() +
        ' ' +
        message;

    const logger = log as unknown as ServiceLogger & Record<string, (msg: string) => void>;
    if (typeof logger[level] === 'function') {
        logger[level](text);
    } else {
        log.info(text);
    }
};
