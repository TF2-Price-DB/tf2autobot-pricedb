import { createLogger, ServiceLogger } from '../../lib/logger';

const _log = createLogger('CritTFEventStream');

export class CritTFEventStreamLogger implements ServiceLogger {
    debug(message: string, ...details: unknown[]) {
        _log.debug(message, ...details);
    }

    verbose(message: string, ...details: unknown[]) {
        _log.verbose(message, ...details);
    }

    info(message: string, ...details: unknown[]) {
        _log.info(message, ...details);
    }

    warn(message: string, ...details: unknown[]) {
        _log.warn(message, ...details);
    }

    trade(message: string, ...details: unknown[]) {
        _log.trade(message, ...details);
    }

    error(message: string, ...details: unknown[]) {
        _log.error(message, ...details);
    }
}
