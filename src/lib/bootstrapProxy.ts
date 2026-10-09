/** Enable the optional development proxy while respecting clients with explicit agents. */
export default function bootstrapProxy(): void {
    try {
        // Only installed in dev mode.
        // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-unsafe-assignment
        const { bootstrap }: { bootstrap: (options: { forceGlobalAgent: boolean }) => void } = require('global-agent');
        bootstrap({ forceGlobalAgent: false });
    } catch {
        // The bot can run without the optional proxy dependency.
    }
}
