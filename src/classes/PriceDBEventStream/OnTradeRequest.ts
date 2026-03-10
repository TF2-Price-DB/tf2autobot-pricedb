import Bot from '../Bot';
import UserCart from '../Carts/UserCart';
import { createLogger } from '../../lib/logger';
const log = createLogger('PriceDBEventStream');
import { parseTradeUrl } from '../../lib/tools/parseTradeUrl';
import Inventory from '../Inventory';
import { assertUnreachable } from '../../lib/assertUnreachable';
import { TradeRequestAssetIdItem, TradeRequestEventEnvelope, TradeRequestSkuItem } from './types';
import { PriceDBEventStreamLogger } from './PriceDBEventStreamLogger';

const CURRENCY_SKUS = new Set(['5021;6', '5002;6', '5001;6', '5000;6']);

export class OnTradeRequest {
    constructor(private readonly bot: Bot, private logger: PriceDBEventStreamLogger) {}

    process(payload: TradeRequestEventEnvelope): void {
        if (!this.bot.options.commands.buy.enable) {
            this.logger.warn('Ignoring trade request event because buy command is disabled');
            return;
        }

        const {
            items_to_give: ourItems,
            trade_offer_url: tradeOfferUrl,
            items_to_receive: itemsToReceive
        } = payload.trade_request;

        const { steamID, token } = parseTradeUrl(tradeOfferUrl);

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

        const ourInventory = this.bot.inventoryManager.getInventory;

        for (const item of ourItems) {
            switch (item.kind) {
                case 'sku':
                    this.addOurSkudItem(item, cart);
                    break;
                case 'assetid':
                    this.addOurAssetById(item, ourInventory, cart);
                    break;
                default:
                    return assertUnreachable(item, 'Unknown item kind encountered, an upgrade may be required...');
            }
        }

        for (const item of itemsToReceive) {
            switch (item.kind) {
                case 'assetid':
                    throw new Error(`Unsupported items_to_receive kind: ${item.kind}`);
                case 'sku':
                    this.addTheirSkudItem(item, cart);
                    break;
            }
        }

        const position = this.bot.handler.cartQueue.enqueue(cart, false, false);
        if (position === -1) {
            this.logger.warn(`Partner ${steamID.getSteamID64()} already has an active cart in queue`);
            return;
        }

        log.info('Enqueued trade request from event stream', {
            partner: steamID.getSteamID64(),
            queuePosition: position,
            ourItemsCount: ourItems.length,
            receiveAssetCount: itemsToReceive.length
        });
    }

    private addTheirSkudItem(item: TradeRequestSkuItem, cart: UserCart) {
        if (CURRENCY_SKUS.has(item.sku)) {
            const amount = Number.isInteger(item.amount) && item.amount > 0 ? item.amount : 1;
            cart.addTheirItem(item.sku, amount);
            return;
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

    private addOurAssetById(item: TradeRequestAssetIdItem, ourInventory: Inventory, cart: UserCart) {
        const sku = ourInventory.findByAssetid(item.assetid);
        if (sku === null) {
            throw new Error(`Bot inventory does not contain tradable assetid ${item.assetid}`);
        }

        if (CURRENCY_SKUS.has(sku)) {
            cart.addOurItem(sku, 1);
            return;
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
    }

    private addOurSkudItem(item: TradeRequestSkuItem, cart: UserCart) {
        if (CURRENCY_SKUS.has(item.sku)) {
            const amount = Number.isInteger(item.amount) && item.amount > 0 ? item.amount : 1;
            cart.addOurItem(item.sku, amount);
            return;
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
    }
}
