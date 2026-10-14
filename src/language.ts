import { Converter } from 'opencc-js';
const convert = Converter({ from: 'cn', to: 'twp' });
export function traditional(text: string): string { return convert(text); }
