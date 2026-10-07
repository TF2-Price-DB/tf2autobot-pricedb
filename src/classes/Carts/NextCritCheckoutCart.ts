import SteamID from 'steamid';
import UserCart from './UserCart';
import type Bot from '../Bot';
import NextCritDriver, { NextCritPrice } from '../NextCritDriver';
import nextCritSellAssets from '../nextCritSellAssets';

/** A normal user cart that must deliver every requested asset at its advertised price. */
export default class NextCritCheckoutCart extends UserCart {
    private readonly prices = new Map<string, NextCritPrice>();

    constructor(
        partner: SteamID,
        token: string,
        bot: Bot,
        private readonly driver: NextCritDriver,
        private readonly assetIds: string[]
    ) {
        super(partner, token, bot, bot.craftWeapons, bot.uncraftWeapons);
        for (const assetId of assetIds) this.addOurItem(assetId);
    }

    async constructOffer(): Promise<string> {
        this.validateAvailability();
        const listings = await this.driver.getListings();
        for (const assetId of this.assetIds) {
            const listing = listings.find(candidate => candidate.asset_id === assetId);
            if (!listing) throw new Error('NextCrit checkout listing is no longer available');
            this.prices.set(assetId, { ...listing.price });
        }
        this.validateAvailability();
        const altered = await super.constructOffer();
        if (altered) throw new Error('NextCrit checkout cannot fulfill the requested quantity');
        this.validateAvailability();
        for (const assetId of this.assetIds) {
            if (!this.offer?.itemsToGive.some(item => item.assetid === assetId)) {
                throw new Error('NextCrit checkout is missing a requested asset');
            }
        }
        this.offer.data('nextCritCheckout', true);
        return altered;
    }

    protected async preSendOffer(): Promise<void> {
        await super.preSendOffer();
        // Recheck after inventory, reputation, and escrow requests have had time to finish.
        this.validateAvailability();
        if (this.offer.itemsToGive.some(item => this.bot.trades.isInTrade(item.assetid))) {
            throw new Error('NextCrit checkout items are already reserved');
        }
    }

    private validateAvailability(): void {
        if (!this.bot.isReady || this.bot.isHalted || this.bot.botManager.isStopping) {
            throw new Error('NextCrit checkout is unavailable while the bot is stopped');
        }
        if (this.bot.trades.getActiveOffer(this.partner)) {
            throw new Error('NextCrit checkout buyer already has an active offer');
        }
        const eligible = new Map(nextCritSellAssets(this.bot, true).map(asset => [asset.assetId, asset.currencies]));
        for (const assetId of this.assetIds) {
            const currencies = eligible.get(assetId);
            if (!currencies || this.bot.trades.isInTrade(assetId)) {
                throw new Error('NextCrit checkout asset is no longer sellable');
            }
            const price = this.prices.get(assetId);
            const current = NextCritDriver.toPrice(currencies);
            if (price && (current.keys !== price.keys || current.half_scrap !== price.half_scrap)) {
                throw new Error('NextCrit checkout price has changed');
            }
        }
    }
}
