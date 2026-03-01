import log from '../../lib/logger';

export class PriceDBEventStreamLogger {
    debug(message: string, ...details: unknown[]) {
        log.debug('[PriceDBEventStream]: ' + message, ...details);
    }

    info(message: string, ...details: unknown[]) {
        log.info('[PriceDBEventStream]: ' + message, ...details);
    }

    warn(message: string, ...details: unknown[]) {
        log.warn('[PriceDBEventStream]: ' + message, ...details);
    }

    error(message: string, ...details: unknown[]) {
        log.error('[PriceDBEventStream]: ' + message, ...details);
    }
}
