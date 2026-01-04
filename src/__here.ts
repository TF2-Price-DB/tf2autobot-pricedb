// Track all unique function calls
const callRegistry = new Set<string>();

/**
 * Records function calls with filename and function name.
 * Keeps track of all unique combinations.
 * @param fileName - The name of the file where the function is located
 * @param functionName - The name of the function being called
 */
function __here(fileName: string, functionName: string): void {
    const key = `${fileName}::${functionName}`;
    callRegistry.add(key);
}

/**
 * Get all unique function calls that have been recorded
 * @returns Array of unique [fileName, functionName] pairs
 */
__here.getCalls = function (): Array<[string, string]> {
    return Array.from(callRegistry).map(key => {
        const [fileName, functionName] = key.split('::');
        return [fileName, functionName];
    });
};

/**
 * Get the raw set of unique call keys
 * @returns Set of "fileName::functionName" strings
 */
__here.getCallRegistry = function (): Set<string> {
    return callRegistry;
};

/**
 * Clear all recorded calls
 */
__here.clear = function (): void {
    callRegistry.clear();
};

/**
 * Get count of unique function calls
 * @returns Number of unique function calls recorded
 */
__here.getCount = function (): number {
    return callRegistry.size;
};

/**
 * Check if a specific function call has been recorded
 * @param fileName - The file name to check
 * @param functionName - The function name to check
 * @returns true if this combination has been called
 */
__here.has = function (fileName: string, functionName: string): boolean {
    const key = `${fileName}::${functionName}`;
    return callRegistry.has(key);
};

module.exports = __here;
export default __here;
