import SteamID from 'steamid';

/**
 * Parse a Steam trade offer URL and extract the SteamID and trade token
 *
 * @param url - Trade URL (e.g., https://steamcommunity.com/tradeoffer/new/?partner=12345&token=abc123)
 * @returns Object containing SteamID and token, or throws error if invalid
 *
 * @example
 * const parsed = parseTradeUrl('https://steamcommunity.com/tradeoffer/new/?partner=12345&token=abc123');
 * // Returns: \{ steamID: SteamID, token: 'abc123' \}
 */
export function parseTradeUrl(url: string): { steamID: SteamID; token: string } {
    try {
        const urlObj = new URL(url);

        // Validate it's a Steam trade offer URL
        if (!urlObj.hostname.includes('steamcommunity.com') || !urlObj.pathname.includes('/tradeoffer/')) {
            throw new Error('Invalid trade URL: must be a steamcommunity.com/tradeoffer URL');
        }

        // Extract partner and token from query parameters
        const partner = urlObj.searchParams.get('partner');
        const token = urlObj.searchParams.get('token');

        if (!partner || !token) {
            throw new Error('Invalid trade URL: missing partner or token parameter');
        }

        // Validate partner account ID as digits and convert via SteamID parser
        if (!/^\d+$/.test(partner)) {
            throw new Error('Invalid trade URL: partner must be a number');
        }

        // Avoid JS integer precision issues with large SteamID64 math by using account format directly
        const steamID = new SteamID(`[U:1:${partner}]`);

        return {
            steamID,
            token
        };
    } catch (err) {
        if (err instanceof Error) {
            throw err;
        }
        throw new Error('Failed to parse trade URL');
    }
}

/**
 * Validate if a URL is a valid Steam trade offer URL
 * @param url - URL to validate
 * @returns true if valid, false otherwise
 */
export function isValidTradeUrl(url: string): boolean {
    try {
        parseTradeUrl(url);
        return true;
    } catch {
        return false;
    }
}
