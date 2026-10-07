import SteamID from 'steamid';
import { ItemsDict, Prices } from '@tf2autobot/tradeoffer-manager';
import UserCart from './UserCart';
import type Bot from '../Bot';
import NextCritDriver, { NextCritBuyListing } from '../NextCritDriver';
import { nextCritBuyListingEntries } from '../nextCritBuyListings';

/** Buy the requested quantity through the normal cart at the advertised order price. */
export default class NextCritBuyCheckoutCart extends UserCart {
    private listing: NextCritBuyListing | undefined;

    private sku: string | undefined;

    constructor(
        partner: SteamID,
        token: string,
        bot: Bot,
        private readonly driver: NextCritDriver,
        private readonly listingId: number,
        private readonly quantity: number
    ) {
        super(partner, token, bot, bot.craftWeapons, bot.uncraftWeapons);
    }

    async constructOffer(): Promise<string> {
        this.validateAvailability();
        this.listing = (await this.driver.getBuyListings()).find(listing => listing.id === this.listingId);
        if (!this.listing || this.listing.amount < this.quantity) {
            throw new Error('NextCrit checkout buy order is no longer available');
        }
        this.validateAvailability();
        this.sku = this.validateListing();
        this.addTheirItem(this.sku, this.quantity);
        const altered = await super.constructOffer();
        if (altered) throw new Error('NextCrit checkout cannot fulfill the requested quantity');
        this.validateAvailability();
        this.validateListing();
        this.validateOffer();
        this.offer.data('nextCritCheckout', true);
        return altered;
    }

    protected async preSendOffer(): Promise<void> {
        await super.preSendOffer();
        this.validateAvailability();
        this.validateListing();
        this.validateOffer();
        if (this.offer.itemsToGive.some(item => this.bot.trades.isInTrade(item.assetid))) {
            throw new Error('NextCrit checkout payment is already reserved');
        }
    }

    private validateAvailability(): void {
        if (!this.bot.isReady || this.bot.isHalted || this.bot.botManager.isStopping) {
            throw new Error('NextCrit checkout is unavailable while the bot is stopped');
        }
        if (this.bot.trades.getActiveOffer(this.partner)) {
            throw new Error('NextCrit checkout seller already has an active offer');
        }
    }

    private validateListing(): string {
        if (!this.listing) throw new Error('NextCrit checkout advertised buy order is missing');
        const key = NextCritDriver.buyKey(this.listing);
        const matches = nextCritBuyListingEntries(this.bot).filter(
            entry => NextCritDriver.buyKey(entry.listing) === key
        );
        if (matches.length !== 1) throw new Error('NextCrit checkout buy criteria are unavailable or ambiguous');
        const { sku, listing } = matches[0];
        if (this.sku && this.sku !== sku) throw new Error('NextCrit checkout buy entry has changed');
        if (
            listing.price.keys !== this.listing.price.keys ||
            listing.price.half_scrap !== this.listing.price.half_scrap
        ) {
            throw new Error('NextCrit checkout buy price has changed');
        }
        const pollData = this.bot.manager.pollData;
        const active = this.bot.trades.getActiveOffers(pollData);
        const pending = [...active.sent, ...active.received].reduce((amount, id) => {
            const dict: ItemsDict | undefined = pollData.offerData?.[id]?.dict;
            return (
                amount +
                Object.entries(dict?.their ?? {}).reduce((count, [priceKey, quantity]) => {
                    const matches =
                        priceKey === sku ||
                        this.bot.pricelist.getPrice({
                            priceKey,
                            onlyEnabled: true,
                            getGenericPrice: true
                        })?.sku === sku;
                    return count + (matches ? quantity : 0);
                }, 0)
            );
        }, 0);
        if (listing.amount - pending < this.quantity)
            throw new Error('NextCrit checkout buy stock limit has been reached');
        return sku;
    }

    private validateOffer(): void {
        const dict = this.offer.data('dict') as ItemsDict;
        const prices = this.offer.data('prices') as Prices;
        if (dict?.their[this.sku] !== this.quantity || this.offer.itemsToReceive.length < this.quantity) {
            throw new Error('NextCrit checkout cannot fulfill the requested quantity');
        }
        const price = prices?.[this.sku]?.buy;
        if (!price) throw new Error('NextCrit checkout offer buy price is missing');
        const current = NextCritDriver.toPrice(price);
        if (current.keys !== this.listing.price.keys || current.half_scrap !== this.listing.price.half_scrap) {
            throw new Error('NextCrit checkout offer buy price has changed');
        }
    }
}
