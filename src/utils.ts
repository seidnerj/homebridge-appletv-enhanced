import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { CharacteristicProps } from 'homebridge';
import { Formats } from 'homebridge';
import { type SpawnOptionsWithoutStdio, spawn } from 'child_process';
import { networkInterfaces } from 'os';
import type { NetworkInterfaceInfo } from 'os';
import type PrefixLogger from './PrefixLogger';
import type LogLevelLogger from './LogLevelLogger';
import path from 'path';

export function capitalizeFirstLetter(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

export const delay = async (ms: number): Promise<void> => new Promise<void>((res) => setTimeout(res, ms));

export function getLocalIP(): string {
    const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces();
    for (const k in interfaces) {
        const networkInterface: NetworkInterfaceInfo[] = interfaces[k]!;
        for (const info of networkInterface) {
            if (!info.internal && info.family === 'IPv4' && !info.address.startsWith('172.')) {
                return info.address;
            }
        }
    }
    return 'homebridge.local';
}

export function normalizePath(p: string): string | undefined {
    if (p.startsWith('~')) {
        if (process.env.HOME === undefined) {
            return undefined;
        }
        // join method does also normalize
        return path.join(process.env.HOME, p.slice(1));
    } else {
        return path.normalize(p);
    }
}

export function trimToMaxLength(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    } else {
        return value.substring(0, maxLength);
    }
}

export function removeSpecialCharacters(str: string): string {
    return str.replace(/[^\p{L}\p{N} ']/gu, '').replace(/\s{2,}/g, ' ').trim();
}

// Mirrors the rule that HAP-NodeJS enforces in its checkName helper: a name has to start and end with a letter or a number and
// may only use letters, numbers, spaces, apostrophes and common punctuation in between. Keeping the character class in sync with
// HAP is what makes the result provably free of the 'has an invalid Name characteristic' warning.
const HAP_NAME_UNSUPPORTED: RegExp = /[^\p{L}\p{N}\p{Zs}’'&!._:;()/,-]/gu;
const HAP_NAME_LEADING_EDGE: RegExp = /^[^\p{L}\p{N}]+/u;
const HAP_NAME_TRAILING_EDGE: RegExp = /[^\p{L}\p{N}]+$/u;
const REPEATED_SPACES: RegExp = /\p{Zs}{2,}/gu;

export function sanitizeHapName(str: string): string {
    const supported: string = str.replace(HAP_NAME_UNSUPPORTED, ' ').replace(REPEATED_SPACES, ' ');
    // Trimming the trailing ')' of a name such as 'Living Room Apple TV (4)' leaves a dangling '(' behind, so the parentheses that
    // lost their partner are dropped before the edges are trimmed for the last time.
    const balanced: string = dropUnmatchedParentheses(trimToHapNameEdges(supported));
    return trimToHapNameEdges(balanced.replace(REPEATED_SPACES, ' '));
}

function trimToHapNameEdges(str: string): string {
    return str.replace(HAP_NAME_LEADING_EDGE, '').replace(HAP_NAME_TRAILING_EDGE, '');
}

function dropUnmatchedParentheses(str: string): string {
    const unmatched: Set<number> = new Set<number>();
    const opened: number[] = [];
    for (let i: number = 0; i < str.length; i++) {
        if (str[i] === '(') {
            opened.push(i);
        } else if (str[i] === ')') {
            if (opened.length === 0) {
                unmatched.add(i);
            } else {
                opened.pop();
            }
        }
    }
    opened.forEach((i: number) => unmatched.add(i));
    if (unmatched.size === 0) {
        return str;
    }
    // Parentheses are single code units, so filtering by index keeps both halves of any surrogate pair intact.
    return str.split('').filter((_: string, i: number) => !unmatched.has(i)).join('');
}

// The bounds that HAP-NodeJS derives from the characteristic format when the properties do not narrow them down further.
const FORMAT_BOUNDS: Record<string, { max: number; min: number }> = {
    [Formats.INT]: { max: 2147483647, min: -2147483648 },
    [Formats.UINT8]: { max: 255, min: 0 },
    [Formats.UINT16]: { max: 65535, min: 0 },
    [Formats.UINT32]: { max: 4294967295, min: 0 },
    // eslint-disable-next-line no-loss-of-precision
    [Formats.UINT64]: { max: 18446744073709551615, min: 0 },
};

export function clampToCharacteristicRange(value: number, props: CharacteristicProps): number {
    const bounds: { max: number; min: number } | undefined = FORMAT_BOUNDS[props.format];
    if (bounds === undefined) {
        return value;
    }
    const min: number = Math.max(bounds.min, props.minValue ?? bounds.min);
    const max: number = Math.min(bounds.max, props.maxValue ?? bounds.max);
    return Math.min(Math.max(value, min), max);
}

export function snakeCaseToTitleCase(str: string): string {
    return str
        .replace(/^[-_]*(.)/, (_, c: string) => c.toUpperCase()) // Initial char (after -/_)
        .replace(/[-_]+(.)/g, (_, c: string) => ' ' + c.toUpperCase()); // First char after each -/_
}

export function camelCaseToTitleCase(str: string): string {
    const spacedStr: string = str.replace(/([A-Z])/g, ' $1');
    const titleCase: string = spacedStr.charAt(0).toUpperCase() + spacedStr.slice(1);
    return titleCase.replace('I Tunes', 'iTunes');
}

export async function runCommand(
    logger: LogLevelLogger | PrefixLogger,
    command: string,
    args?: readonly string[],
    options?: SpawnOptionsWithoutStdio,
    hideStdout: boolean = false,
    hideStderr: boolean = false,
): Promise<[string, string, number | null]> {
    let running: boolean = true;
    let stdout: string = '';
    let stderr: string = '';

    const p: ChildProcessWithoutNullStreams = spawn(command, args, options);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (data: string) => {
        stdout += data;
        data = data.trim();
        if (!hideStdout && data !== '') {
            logger.info(data);
        }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (data: string) => {
        stderr += data;
        data = data.trim();
        if (!hideStderr) {
            if (data.startsWith('WARNING')) {
                data = data.replace('WARNING: ', '');
                logger.warn(data.replaceAll('\n', ''));
            } else {
                data = data.replace('ERROR: ', '');
                logger.error(data);
            }
        }
    });
    p.on('close', () => {
        running = false;
    });

    while (running) {
        await delay(100);
    }

    return [stdout, stderr, p.exitCode];
}
