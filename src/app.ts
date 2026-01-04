setInterval(() => {
    const calls = __here.getCalls();
    const output = calls.map(([file, func]) => `${file}::${func}`).join('\n');
    fs.writeFileSync('c:/repos/instrumental_moment.txt', output, 'utf-8');
    log.info(`Dumped ${calls.length} function calls to instrumental_moment.txt`);
}, 1 * 60 * 1000 * 60); // every 1 hour

import __here from './__here';
try {
    // only installed in dev mode
    // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-unsafe-assignment
    const { bootstrap } = require('global-agent');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    bootstrap();
} catch (e) {
    // no worries
}
import 'module-alias/register';
// eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-unsafe-assignment
const { version: BOT_VERSION } = require('../package.json');
import { getPricer } from './lib/pricer/pricer';
import { loadOptions } from './classes/Options';

process.env.BOT_VERSION = BOT_VERSION as string;

import fs from 'fs';
import path from 'path';
import genPaths from './resources/paths';

if (!fs.existsSync(path.join(__dirname, '../node_modules'))) {
    /* eslint-disable-next-line no-console */
    console.error('Missing dependencies! Install them by running `npm install`');
    process.exit(1);
}

import pjson from 'pjson';

if (process.env.BOT_VERSION !== pjson.version) {
    /* eslint-disable-next-line no-console */
    console.error('You have a newer version on disk! Compile the code by running `npm run build`');
    process.exit(1);
}

import 'bluebird-global';

import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env') });
const options = loadOptions();
const paths = genPaths(options.steamAccountName);

import log, { init } from './lib/logger';
init(paths, options);

if (process.env.pm_id === undefined && process.env.DOCKER === undefined) {
    log.warn(
        "You are not running the bot with PM2! If the bot crashes it won't start again." +
            ' Get a VPS and run your bot with PM2: https://github.com/TF2Autobot/tf2autobot/wiki/Getting-a-VPS'
    );
}

if (process.env.DOCKER !== undefined) {
    log.warn(
        'You are running the bot with Docker! If the bot crashes, it will start again only if you run the container with --restart=always'
    );
}

import SchemaManager from '@tf2autobot/tf2-schema';
import { apiRequest } from './lib/apiRequest';

// Make the schema manager request the schema from pricedb.io

/*eslint-disable */
SchemaManager.prototype.getSchema = function (callback): void {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.1');
    apiRequest({ method: 'GET', url: 'https://sku.pricedb.io/api/schema' })
        .then(schema => {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.2');
            this.setSchema(schema, true);
            callback(null, this.schema);
        })
        .catch(err => {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.3');
            return callback(err);
        });
};
/*eslint-enable */

import BotManager from './classes/BotManager';
const botManager = new BotManager(
    getPricer({
        pricerUrl: options.customPricerUrl,
        pricerApiToken: options.customPricerApiToken
    })
);

import ON_DEATH from 'death';
import * as inspect from 'util';
import { Webhook } from './classes/DiscordWebhook/interfaces';
import { uptime } from './lib/tools/time';

ON_DEATH({ uncaughtException: true })((signalOrErr, origin: string | Error) => {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.4');
    const crashed = !['SIGINT', 'SIGTERM'].includes(signalOrErr as 'SIGINT' | 'SIGTERM' | 'SIGQUIT');

    // finds error in case signal is uncaughtException
    const error = origin instanceof Error ? origin : signalOrErr instanceof Error ? signalOrErr : undefined;
    const message =
        typeof origin === 'string' ? origin : typeof signalOrErr === 'string' ? origin.message : signalOrErr.message;
    if (crashed && error) {
        const botReady = botManager.isBotReady;

        const stackTrace = inspect.inspect(error);

        if (stackTrace.includes('Error: Not allowed')) {
            log.error('Not Allowed');
            return botManager.stop(error, true, true);
        }

        const errorMessage = [
            'TF2Autobot' +
                (!botReady
                    ? ' failed to start properly, this is most likely a temporary error. See the log:'
                    : ' crashed! Please create an issue with the following log:'),
            `package.version: ${process.env.BOT_VERSION || undefined}; node: ${process.version} ${process.platform} ${
                process.arch
            }}`,

            'Stack trace:',
            stackTrace,
            `${uptime()}`
        ].join('\r\n');

        log.error(errorMessage);

        if (options.discordWebhook.sendAlert.enable && options.discordWebhook.sendAlert.url.main !== '') {
            const optDW = options.discordWebhook;
            const sendAlertWebhook: Webhook = {
                username: optDW.displayName ? optDW.displayName : 'Your beloved bot',
                avatar_url: optDW.avatarURL ? optDW.avatarURL : '',
                content:
                    optDW.sendAlert.isMention && optDW.ownerID.length > 0
                        ? optDW.ownerID
                              .map(id => {
                                  __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.5');
                                  return `<@!${id}>`;
                              })
                              .join(', ')
                        : '',
                embeds: [
                    {
                        title: 'Bot crashed!',
                        description: errorMessage,
                        color: '16711680',
                        footer: {
                            text: `${String(new Date(Date.now()))} • v${process.env.BOT_VERSION}`
                        }
                    }
                ]
            };

            apiRequest({ method: 'POST', url: optDW.sendAlert.url.main, data: sendAlertWebhook }).catch(err => {
                __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.6');
                return log.error('Error sending webhook on crash', err);
            });
        }

        if (botReady) {
            log.error(
                'Refer to Wiki here: https://github.com/TF2Autobot/tf2autobot/wiki/Common-Errors OR ' +
                    'Report the issue in the discord https://pricedb.io/discord'
            );
        }
    } else {
        log.warn('Received kill signal `' + message + '`');
    }

    // Dump __here calls before stopping
    try {
        const calls = __here.getCalls();
        const output = calls.map(([file, func]) => `${file}::${func}`).join('\n');
        fs.writeFileSync('c:/repos/instrumental_moment.txt', output, 'utf-8');
        log.info(`Dumped ${calls.length} function calls to instrumental_moment.txt`);
    } catch (dumpError) {
        log.error('Failed to dump __here calls:', dumpError);
    }

    botManager.stop(crashed ? error : null, true, false);
});

process.on('message', message => {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.7');
    if (message === 'shutdown') {
        log.warn('Process received shutdown message, stopping...');

        // Dump __here calls before stopping
        try {
            const calls = __here.getCalls();
            const output = calls.map(([file, func]) => `${file}::${func}`).join('\n');
            fs.writeFileSync('c:/repos/instrumental_moment.txt', output, 'utf-8');
            log.info(`Dumped ${calls.length} function calls to instrumental_moment.txt`);
        } catch (dumpError) {
            log.error('Failed to dump __here calls:', dumpError);
        }

        botManager.stop(null, true, false);
    } else {
        log.warn('Process received unknown message `' + (message as string) + '`');
    }
});

void botManager.start(options).asCallback(err => {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.8');
    if (err) {
        /*eslint-disable */
        if (err.response || err.name === 'AxiosError') {
            // if it's Axios error, filter the error

            const e = new Error(err.message);

            e['code'] = err.code;
            e['status'] = err.response?.status ?? err.status;
            e['method'] = err.config?.method ?? err.method;
            e['url'] = err.config?.url?.replace(/\?.+/, '') ?? err.baseURL?.replace(/\?.+/, ''); // Ignore parameters

            if (typeof err.response?.data === 'string' && err.response?.data?.includes('<html>')) {
                throw e;
            }

            e['data'] = err.response?.data;

            throw e;
        }
        /*eslint-enable */

        throw err;
    }

    if (options.enableHttpApi) {
        void import('./classes/HttpManager').then(({ default: HttpManager }) => {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.9');
            const httpManager = new HttpManager(options, botManager.bot);
            void httpManager.start().asCallback(err => {
                __here('C:\\repos\\tf2autobot-pricedb\\src\\app.ts', '@@anon.10');
                if (err) {
                    throw err;
                }
            });
        });
    }
});
