import __here from './__here';
import { instrumentFile, uninstrumentFile } from './codeanalyser';
import * as fs from 'node:fs';
import * as path from 'node:path';
function getAllTsFiles(dir: string, fileList: string[] = []): string[] {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\foo.ts', 'getAllTsFiles');
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            getAllTsFiles(filePath, fileList);
        } else if (file.endsWith('.ts') && !file.includes('__here')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}
function main() {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\foo.ts', 'main');

    // Read known calls from stdin
    const stdinInput = fs.readFileSync(0, 'utf-8'); // 0 is stdin file descriptor
    const knownCalls = new Set(
        stdinInput
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
    );

    console.log(`Loaded ${knownCalls.size} known function calls from stdin\n`);

    const srcDir = path.join(process.cwd(), 'src');
    const tsFiles = getAllTsFiles(srcDir);
    console.log(`Found ${tsFiles.length} TypeScript files to uninstrument\n`);
    for (const filePath of tsFiles) {
        try {
            console.log(`Uninstrumenting: ${filePath}`);
            const sourceCode = fs.readFileSync(filePath, 'utf-8');
            const instrumented = uninstrumentFile(filePath, sourceCode, knownCalls);
            fs.writeFileSync(filePath, instrumented, 'utf-8');
            console.log(`✓ Successfully uninstrumented: ${filePath}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`✗ Failed to uninstrument ${filePath}:`, errorMsg);
        }
    }
    console.log(`\nUninstrumentation complete!`);
}
main();
