import path from 'path';

interface FilePaths {
    refreshToken: string;
    /** Legacy per-bot data directory.  Kept so migration code can locate old
     *  JSON files.  No new JSON data files are written here. */
    dir: string;
}

interface LogPaths {
    log: string;
    trade: string;
    error: string;
}

export interface Paths {
    files: FilePaths;
    logs: LogPaths;
    db: string;
}

export default function genPaths(steamAccountName: string): Paths {
    return {
        files: {
            refreshToken: path.join(__dirname, `../../files/${steamAccountName}/refreshToken.txt`),
            dir: path.join(__dirname, `../../files/${steamAccountName}/`)
        },
        logs: {
            log: path.join(__dirname, `../../logs/${steamAccountName}-%DATE%.log`),
            trade: path.join(__dirname, `../../logs/${steamAccountName}.trade.log`),
            error: path.join(__dirname, `../../logs/${steamAccountName}.error.log`)
        },
        db: path.join(__dirname, '../../files/bot.db')
    };
}
