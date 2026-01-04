import __here from './__here';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import * as path from 'path';
interface InstrumentOptions {
    fileName: string;
    sourceCode: string;
}

/**
 * Instruments JavaScript source code by inserting __here() calls at the beginning of each function.
 * @param options - Object containing fileName and sourceCode
 * @returns Instrumented source code
 */
export function instrumentCode(options: InstrumentOptions): string {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'instrumentCode');
    const { fileName, sourceCode } = options;

    // Skip .d.ts files (TypeScript declaration files)
    if (fileName.endsWith('.d.ts')) {
        return sourceCode;
    }

    // Parse the source code into an AST
    const ast = parser.parse(sourceCode, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy']
    });

    // Calculate relative path from the file to __here.ts
    const fileDir = path.dirname(fileName);
    const hereFilePath = path.join(process.cwd(), 'src', '__here.ts');
    let relativePath = path.relative(fileDir, hereFilePath);

    // Normalize to forward slashes and remove .ts extension
    relativePath = relativePath.replace(/\\/g, '/').replace(/\.ts$/, '');

    // Ensure it starts with ./ or ../
    if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
    }

    // Add __here import at the top of the file
    const hereImport = t.importDeclaration(
        [t.importDefaultSpecifier(t.identifier('__here'))],
        t.stringLiteral(relativePath)
    );
    ast.program.body.unshift(hereImport);
    let anonCounter = 0;

    // Traverse the AST and insert __here calls
    traverse(ast, {
        // Handle function declarations: function foo() {}
        FunctionDeclaration(path) {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'FunctionDeclaration');
            const functionName = path.node.id?.name || `@@anon.${++anonCounter}`;
            insertHereCall(path, fileName, functionName);
        },
        // Handle function expressions: const foo = function() {}
        FunctionExpression(path) {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'FunctionExpression');
            const functionName = path.node.id?.name || `@@anon.${++anonCounter}`;
            insertHereCall(path, fileName, functionName);
        },
        // Handle arrow functions: const foo = () => {}
        ArrowFunctionExpression(path) {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'ArrowFunctionExpression');
            const functionName = `@@anon.${++anonCounter}`;

            // Check if the parent is a variable declarator to get the name
            if (t.isVariableDeclarator(path.parent) && t.isIdentifier(path.parent.id)) {
                insertHereCall(path, fileName, path.parent.id.name);
            } else if (t.isObjectProperty(path.parent) && t.isIdentifier(path.parent.key)) {
                // Handle object methods: { foo: () => {} }
                insertHereCall(path, fileName, path.parent.key.name);
            } else if (t.isAssignmentExpression(path.parent) && t.isIdentifier(path.parent.left)) {
                // Handle assignments: foo = () => {}
                insertHereCall(path, fileName, path.parent.left.name);
            } else {
                insertHereCall(path, fileName, functionName);
            }
        },
        // Handle class methods
        ClassMethod(path) {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'ClassMethod');
            const functionName = t.isIdentifier(path.node.key) ? path.node.key.name : `@@anon.${++anonCounter}`;
            insertHereCall(path, fileName, functionName);
        },
        // Handle object methods: { foo() {} }
        ObjectMethod(path) {
            __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'ObjectMethod');
            const functionName = t.isIdentifier(path.node.key) ? path.node.key.name : `@@anon.${++anonCounter}`;
            insertHereCall(path, fileName, functionName);
        }
    });

    // Generate the instrumented code from the modified AST
    const output = generate(
        ast,
        {
            retainLines: true,
            compact: false,
            decoratorsBeforeExport: true
        },
        sourceCode
    );

    // Add a newline after the __here import for better formatting
    const lines = output.code.split('\n');
    const importIndex = lines.findIndex(line => line.includes('import __here from'));
    if (importIndex !== -1 && importIndex < lines.length - 1) {
        if (lines[importIndex + 1].trim() !== '') {
            lines.splice(importIndex + 1, 0, '');
        }
    }

    return lines.join('\n');
}

/**
 * Inserts a __here() call at the beginning of a function body
 */
function insertHereCall(path: any, fileName: string, functionName: string): void {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'insertHereCall');
    const body = path.node.body;

    // Create the __here call: __here(fileName, functionName)
    const hereCall = t.expressionStatement(
        t.callExpression(t.identifier('__here'), [t.stringLiteral(fileName), t.stringLiteral(functionName)])
    );

    // Handle arrow functions with expression bodies: () => expr
    if (t.isArrowFunctionExpression(path.node) && !t.isBlockStatement(body)) {
        // Convert expression body to block statement with return
        const returnStatement = t.returnStatement(body);
        path.node.body = t.blockStatement([hereCall, returnStatement]);
    }
    // Handle functions with block statement bodies
    else if (t.isBlockStatement(body)) {
        // Insert at the beginning of the block
        body.body.unshift(hereCall);
    }
}

/**
 * Convenience function to instrument a file
 */
export function instrumentFile(fileName: string, sourceCode: string): string {
    __here('C:\\repos\\tf2autobot-pricedb\\src\\codeanalyser.ts', 'instrumentFile');
    return instrumentCode({
        fileName,
        sourceCode
    });
}
interface UninstrumentOptions {
    fileName: string;
    sourceCode: string;
    knownCalls: Set<string>;
}

/**
 * Removes __here() calls from functions that are in the known calls list.
 * Also removes the __here import if no calls remain.
 * @param options - Object containing fileName, sourceCode, and knownCalls
 * @returns Uninstrumented source code
 */
export function uninstrumentCode(options: UninstrumentOptions): string {
    const { fileName, sourceCode, knownCalls } = options;

    // Parse the source code into an AST
    const ast = parser.parse(sourceCode, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy']
    });
    let anonCounter = 0;
    let hasRemainingHereCalls = false;

    // Traverse the AST and remove __here calls for known functions
    traverse(ast, {
        // Handle function declarations: function foo() {}
        FunctionDeclaration(path) {
            const functionName = path.node.id?.name || `@@anon.${++anonCounter}`;
            const removed = removeHereCallIfKnown(path, fileName, functionName, knownCalls);
            if (!removed) hasRemainingHereCalls = true;
        },
        // Handle function expressions: const foo = function() {}
        FunctionExpression(path) {
            const functionName = path.node.id?.name || `@@anon.${++anonCounter}`;
            const removed = removeHereCallIfKnown(path, fileName, functionName, knownCalls);
            if (!removed) hasRemainingHereCalls = true;
        },
        // Handle arrow functions: const foo = () => {}
        ArrowFunctionExpression(path) {
            let functionName = `@@anon.${++anonCounter}`;

            // Check if the parent is a variable declarator to get the name
            if (t.isVariableDeclarator(path.parent) && t.isIdentifier(path.parent.id)) {
                functionName = path.parent.id.name;
            } else if (t.isObjectProperty(path.parent) && t.isIdentifier(path.parent.key)) {
                functionName = path.parent.key.name;
            } else if (t.isAssignmentExpression(path.parent) && t.isIdentifier(path.parent.left)) {
                functionName = path.parent.left.name;
            }
            const removed = removeHereCallIfKnown(path, fileName, functionName, knownCalls);
            if (!removed) hasRemainingHereCalls = true;
        },
        // Handle class methods
        ClassMethod(path) {
            const functionName = t.isIdentifier(path.node.key) ? path.node.key.name : `@@anon.${++anonCounter}`;
            const removed = removeHereCallIfKnown(path, fileName, functionName, knownCalls);
            if (!removed) hasRemainingHereCalls = true;
        },
        // Handle object methods: { foo() {} }
        ObjectMethod(path) {
            const functionName = t.isIdentifier(path.node.key) ? path.node.key.name : `@@anon.${++anonCounter}`;
            const removed = removeHereCallIfKnown(path, fileName, functionName, knownCalls);
            if (!removed) hasRemainingHereCalls = true;
        }
    });

    // Remove __here import if no calls remain
    if (!hasRemainingHereCalls) {
        traverse(ast, {
            ImportDeclaration(path) {
                // Check if this is an import of __here (handles any relative path)
                const importPath = path.node.source.value;
                if (importPath.includes('__here') && !importPath.includes('node_modules')) {
                    path.remove();
                }
            }
        });
    }

    // Generate the uninstrumented code from the modified AST
    const output = generate(
        ast,
        {
            retainLines: true,
            compact: false,
            decoratorsBeforeExport: true
        },
        sourceCode
    );
    return output.code;
}

/**
 * Removes __here() call from a function if it's in the known calls list
 * @returns true if the call was removed, false otherwise
 */
function removeHereCallIfKnown(path: any, fileName: string, functionName: string, knownCalls: Set<string>): boolean {
    const key = `${fileName}::${functionName}`;

    // Only remove if this function is in the known calls list
    if (!knownCalls.has(key)) {
        return false;
    }
    const body = path.node.body;

    // Handle functions with block statement bodies
    if (t.isBlockStatement(body)) {
        const firstStatement = body.body[0];

        // Check if the first statement is a __here call
        if (
            t.isExpressionStatement(firstStatement) &&
            t.isCallExpression(firstStatement.expression) &&
            t.isIdentifier(firstStatement.expression.callee) &&
            firstStatement.expression.callee.name === '__here'
        ) {
            // Remove the first statement (__here call)
            body.body.shift();
            return true;
        }
    }
    return false;
}

/**
 * Convenience function to uninstrument a file
 */
export function uninstrumentFile(fileName: string, sourceCode: string, knownCalls: Set<string>): string {
    return uninstrumentCode({
        fileName,
        sourceCode,
        knownCalls
    });
}
