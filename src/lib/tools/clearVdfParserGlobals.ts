/**
 * The legacy `vdf` parser assigns these variables without declarations.
 * Its global `res` otherwise retains the complete most-recent parsed VDF.
 */
export function clearVdfParserGlobals(): void {
    const runtime = global as typeof global & Record<string, unknown>;

    delete runtime.res;
    delete runtime.ptr;
    delete runtime.ci;
    delete runtime.finalstr;
    delete runtime.string;
    delete runtime.lst;
}
