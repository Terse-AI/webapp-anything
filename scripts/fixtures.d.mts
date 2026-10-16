export function dosCom(message?: string): Uint8Array;
export function dosExe(options?: { extender?: boolean }): Uint8Array;
export function bootFloppy(message?: string): Uint8Array;
export function bootDisk(message?: string, options?: { fill?: number }): Uint8Array;
export function linuxHello(): Uint8Array;
export function elfDynamic(options?: {
  bits?: 32 | 64;
  machine?: number;
  needed?: string[];
  interp?: string;
}): Uint8Array;
export function peExe(options?: {
  machine?: number;
  subsystem?: number;
  dll?: boolean;
  dotnet?: boolean;
  imports?: string[];
  marker?: string;
  resources?: { type: number; id: number; data: Uint8Array }[];
}): Uint8Array;
export function rcStringTable(strings: Record<number, string>): Uint8Array;
export type RcMenuItem = { text: string; id: number } | { text: string; items: RcMenuItem[] };
export function rcMenu(items: RcMenuItem[]): Uint8Array;
export function rcDialog(options: {
  caption: string;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  controls?: { cls: number; text: string; id: number; x: number; y: number; cx: number; cy: number }[];
}): Uint8Array;
export function rcVersion(strings: Record<string, string>): Uint8Array;
export function neExe(options?: { os?: number }): Uint8Array;
export function leExe(): Uint8Array;
export function machO(options?: { fat?: boolean }): Uint8Array;
export function classFile(major?: number, extra?: string): Uint8Array;
export function jar(options?: { mainClass?: string; major?: number; swing?: boolean }): Uint8Array;
export function axml(root: AxmlNode, options?: { stripNames?: boolean }): Uint8Array;
export interface AxmlNode {
  name: string;
  attrs?: Record<string, string | number | boolean>;
  children?: AxmlNode[];
}
export function androidManifest(options?: {
  pkg?: string;
  activity?: string;
  stripNames?: boolean;
}): Uint8Array;
export function apk(options?: { pkg?: string; abis?: string[]; stripNames?: boolean }): Uint8Array;
export function isoImage(options?: { bootable?: boolean; label?: string }): Uint8Array;
export function swfMovie(options?: { frames?: number }): Uint8Array;
export function asar(files: Record<string, string | Uint8Array>): Uint8Array;
export const webIndex: string;
export function counterCom(): Uint8Array;
