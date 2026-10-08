import SteamCommunity from '@tf2autobot/steamcommunity';

type FormRequest = { form?: Record<string, unknown> };

export default function omitAbsentFormFields(community: SteamCommunity): void {
    const hookedCommunity = community as SteamCommunity & {
        onPreHttpRequest?: (requestID: number, source: string, options: FormRequest) => void;
    };

    hookedCommunity.onPreHttpRequest = (_requestID, _source, options) => {
        if (!options.form) {
            return;
        }

        for (const key of Object.keys(options.form)) {
            if (options.form[key] === undefined || options.form[key] === null) {
                delete options.form[key];
            }
        }
    };
}
