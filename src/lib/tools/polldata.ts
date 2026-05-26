import SteamTradeOfferManager from '@tf2autobot/tradeoffer-manager';
import Bot from '../../classes/Bot';

//Oh look this file is emtpy now
export default function loadPollData(bot: Bot): SteamTradeOfferManager.PollData | undefined {
    return bot.manager.pollData;
}

export function deletePollData(bot: Bot): void {
    const empty: SteamTradeOfferManager.PollData = {
        sent: {},
        received: {},
        timestamps: {},
        offersSince: 0,
        offerData: {}
    };
    bot.db.savePollData(empty);
}
