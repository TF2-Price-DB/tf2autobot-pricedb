import { UnknownDictionaryKnownValues } from 'src/types/common';
import Bot from '../Bot';
import InventoryApi from './InventoryApi';

export default class SteamBotInfo extends InventoryApi {
    constructor(bot: Bot) {
        super(bot, 'steamBotInfo');
    }

    protected getURLAndParams(
        steamID: string,
        appID: number,
        contextID: string
    ): [string, UnknownDictionaryKnownValues] {
        const apiKey = encodeURIComponent(this.getApiKey());
        return [
            `https://api.steambot.info/v1/${apiKey}/inventory/${steamID}/${appID}/${contextID}`,
            { count: 2000, language: 'en' }
        ];
    }

    protected normalizeResponse(data: unknown): unknown {
        const response = data as UnknownDictionaryKnownValues;
        if (response?.success === true && response.data && typeof response.data === 'object') {
            return { ...(response.data as UnknownDictionaryKnownValues), success: 1 };
        }
        return data;
    }
}
