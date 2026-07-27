import Bot from '../Bot';
import { ManncoTransactionEvent } from '../ManncoStoreManager';
import { Webhook } from './interfaces';
import { sendWebhook } from './utils';
import log from '../../lib/logger';

export default function sendManncoTransaction(event: ManncoTransactionEvent, bot: Bot): void {
    const options = bot.options.discordWebhook;
    if (!options.tradeSummary.enable || options.tradeSummary.url.length === 0) return;

    const action = event.type === 'sale' ? 'Sold' : 'Buy order completed';
    const details = [
        `Quantity: ${event.quantity}`,
        `Price: $${(event.price / 100).toFixed(2)}`,
        event.sku ? `SKU: ${event.sku}` : '',
        event.assetIds.length > 0 ? `Asset IDs: ${event.assetIds.join(', ')}` : ''
    ]
        .filter(Boolean)
        .join('\n');
    const webhook: Webhook = {
        username: options.displayName || bot.handler.getBotInfo.name,
        avatar_url: options.avatarURL || bot.handler.getBotInfo.avatarURL,
        embeds: [
            {
                title: `Mannco.store: ${action}`,
                description: `**${event.name}**\n${details}`,
                color: options.embedColor
            }
        ]
    };

    options.tradeSummary.url.forEach((url, index) => {
        sendWebhook(url, webhook, 'trade-summary', index).catch(err =>
            log.warn(`Failed to send Mannco.store transaction webhook (${event.id}):`, err)
        );
    });
}
