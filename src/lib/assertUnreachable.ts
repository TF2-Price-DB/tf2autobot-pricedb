export function assertUnreachable(never: never, message: string = 'Bad programmer, no... bad!'): never {
    throw new Error(message, { cause: never });
}
