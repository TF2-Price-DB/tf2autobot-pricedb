import Bot from './Bot';
import UserCart from './Carts/UserCart';
import { createEventSource } from 'eventsource-client';
import log from '../lib/logger';
import { parseTradeUrl } from '../lib/tools/parseTradeUrl';

interface TradeRequestEventEnvelope {
    kind: string;
    trade_request?: TradeRequestPayload;
}

interface TradeRequestPayload {
    trade_offer_url: string;
    items_to_give: TradeRequestItem[];
    items_to_receive?: TradeRequestItem[];
    reserved_assets?: string[];
}

interface TradeRequestItem {
    kind: 'sku' | 'assetid' | string;
    sku?: string;
    amount?: number;
    assetid?: string;
}

const CURRENCY_SKUS = new Set(['5021;6', '5002;6', '5001;6', '5000;6']);

export default class TradeRequestListener {
    constructor(private readonly bot: Bot, private readonly eventStreamUrl: string) {}

    async start(): Promise<void> {
        const eventSource = createEventSource(this.eventStreamUrl);

        log.info(`Trade request listener connected to ${this.eventStreamUrl}`);

        for await (const { data, event, id } of eventSource) {
            try {
                this.handleRawEvent(data);
            } catch (err) {
                log.warn('Failed to handle trade request event', {
                    error: err instanceof Error ? err.message : String(err),
                    event,
                    id,
                    data
                });
            }
        }
    }

    private handleRawEvent(rawData: unknown): void {
        if (typeof rawData !== 'string' || rawData.trim() === '') {
            return;
        }

        const parsed = JSON.parse(rawData) as TradeRequestEventEnvelope;

        if (parsed.kind !== 'trade_request' || !parsed.trade_request) {
            return;
        }

        this.handleTradeRequest(parsed.trade_request);
    }

    private handleTradeRequest(payload: TradeRequestPayload): void {
        if (!this.bot.options.commands.buy.enable) {
            log.warn('Ignoring trade request event because buy command is disabled');
            return;
        }

        const { steamID, token } = parseTradeUrl(payload.trade_offer_url);

        const cart = new UserCart(
            steamID,
            token,
            this.bot,
            this.bot.options.miscSettings.weaponsAsCurrency.enable ? this.bot.craftWeapons : [],
            this.bot.options.miscSettings.weaponsAsCurrency.enable &&
            this.bot.options.miscSettings.weaponsAsCurrency.withUncraft
                ? this.bot.uncraftWeapons
                : []
        );

        const ourItems = payload.items_to_give ?? [];
        if (ourItems.length === 0) {
            throw new Error('trade_request.items_to_give is empty');
        }

        const ourInventory = this.bot.inventoryManager.getInventory;

        for (const item of ourItems) {
            if (item.kind === 'assetid') {
                if (!item.assetid) {
                    throw new Error('Trade request assetid item is missing assetid');
                }

                const sku = ourInventory.findByAssetid(item.assetid);
                if (sku === null) {
                    throw new Error(`Bot inventory does not contain tradable assetid ${item.assetid}`);
                }

                if (CURRENCY_SKUS.has(sku)) {
                    cart.addOurItem(sku, 1);
                    continue;
                }

                const entry = this.bot.pricelist.getPriceBySkuOrAsset({
                    priceKey: sku,
                    onlyEnabled: true,
                    getGenericPrice: false
                });

                if (entry === null) {
                    throw new Error(`Asset ${item.assetid} (${sku}) is not in enabled pricelist`);
                }

                if (this.bot.options.commands.buy.disableForSKU.includes(entry.sku)) {
                    throw new Error(`Buy command is disabled for ${entry.name}`);
                }

                cart.addOurItem(entry.sku, 1);
                continue;
            }

            if (item.kind === 'sku') {
                if (!item.sku) {
                    throw new Error('Trade request sku item is missing sku');
                }

                if (CURRENCY_SKUS.has(item.sku)) {
                    const amount = Number.isInteger(item.amount) && item.amount > 0 ? item.amount : 1;
                    cart.addOurItem(item.sku, amount);
                    continue;
                }

                const entry = this.bot.pricelist.getPriceBySkuOrAsset({
                    priceKey: item.sku,
                    onlyEnabled: true,
                    getGenericPrice: false
                });

                if (entry === null) {
                    throw new Error(`Item ${item.sku} is not in enabled pricelist`);
                }

                if (this.bot.options.commands.buy.disableForSKU.includes(entry.sku)) {
                    throw new Error(`Buy command is disabled for ${entry.name}`);
                }

                const amount = Number.isInteger(item.amount) && item.amount > 0 ? item.amount : 1;
                cart.addOurItem(entry.sku, amount);
                continue;
            }

            throw new Error(`Unsupported items_to_give kind: ${item.kind}`);
        }

        for (const item of payload.items_to_receive ?? []) {
            if (item.kind === 'assetid') {
                throw new Error(
                    'items_to_receive.kind=assetid is not supported in event listener yet; use sku for receive side'
                );
            }

            if (item.kind !== 'sku') {
                throw new Error(`Unsupported items_to_receive kind: ${item.kind}`);
            }

            if (!item.sku) {
                throw new Error('Trade request receive sku item is missing sku');
            }

            if (CURRENCY_SKUS.has(item.sku)) {
                const amount = Number.isInteger(item.amount) && item.amount > 0 ? item.amount : 1;
                cart.addTheirItem(item.sku, amount);
                continue;
            }

            const entry = this.bot.pricelist.getPriceBySkuOrAsset({
                priceKey: item.sku,
                onlyEnabled: true,
                getGenericPrice: false
            });

            if (entry === null) {
                throw new Error(`Receive item ${item.sku} is not in enabled pricelist`);
            }

            const amount = Number.isInteger(item.amount) && item.amount > 0 ? item.amount : 1;
            cart.addTheirItem(entry.sku, amount);
        }

        const position = this.bot.handler.cartQueue.enqueue(cart, false, false);
        if (position === -1) {
            throw new Error(`Partner ${steamID.getSteamID64()} already has an active cart in queue`);
        }

        log.info('Enqueued trade request from event stream', {
            partner: steamID.getSteamID64(),
            queuePosition: position,
            ourItemsCount: ourItems.length,
            receiveAssetCount: payload.items_to_receive?.length ?? 0,
            reservedAssetCount: payload.reserved_assets?.length ?? 0
        });
    }
}
