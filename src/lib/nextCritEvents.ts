/** Decode SSE data events without assuming that network chunks end at line boundaries. */
export default class NextCritEvents {
    private buffer = '';

    private data: string[] = [];

    private event = '';

    private size = 0;

    private firstLine = true;

    constructor(private readonly onMessage: (data: string) => void) {}

    push(chunk: string): void {
        this.size += chunk.length;
        if (this.size > 1024 * 1024) throw new Error('NextCrit event is too large');
        this.buffer += chunk;
        for (;;) {
            const match = /\r\n|\r|\n/.exec(this.buffer);
            if (!match || (match[0] === '\r' && match.index === this.buffer.length - 1)) return;
            let line = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            if (this.firstLine) {
                line = line.replace(/^\uFEFF/, '');
                this.firstLine = false;
            }
            if (line === '') {
                if (this.data.length > 0 && (this.event === '' || this.event === 'message')) {
                    this.onMessage(this.data.join('\n'));
                }
                this.data = [];
                this.event = '';
                this.size = this.buffer.length;
                continue;
            }
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'data') this.data.push(value);
            if (field === 'event') this.event = value;
        }
    }
}
