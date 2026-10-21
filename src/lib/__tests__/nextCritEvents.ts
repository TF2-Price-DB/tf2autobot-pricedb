import NextCritEvents from '../nextCritEvents';

test('decodes fragmented SSE messages, multiline data, BOM, comments and CRLF', () => {
    const onMessage = jest.fn();
    const parser = new NextCritEvents(onMessage);
    for (const chunk of [
        '\uFEFFretry: 3000\r',
        '\n: connected\r\n\r\n',
        'da',
        'ta: first\r',
        '\ndata: second\r\n\r',
        '\n'
    ]) {
        parser.push(chunk);
    }
    expect(onMessage).toHaveBeenCalledWith('first\nsecond');
    expect(onMessage).toHaveBeenCalledTimes(1);
});

test('handles multiple messages and ignores other event types and heartbeats', () => {
    const onMessage = jest.fn();
    const parser = new NextCritEvents(onMessage);
    parser.push(': keep-alive\n\nevent: other\ndata: ignored\n\ndata: a\n\nevent: message\ndata: b\n\n');
    expect(onMessage.mock.calls).toEqual([['a'], ['b']]);
});

test('does not dispatch an incomplete event at disconnect', () => {
    const onMessage = jest.fn();
    new NextCritEvents(onMessage).push('data: partial\n');
    expect(onMessage).not.toHaveBeenCalled();
});

test('bounds unterminated event data', () => {
    const parser = new NextCritEvents(jest.fn());
    expect(() => parser.push('data: ' + 'a'.repeat(1024 * 1024))).toThrow('too large');
});
