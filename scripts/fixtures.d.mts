export function dosCom(message?: string): Uint8Array;
export function dosExe(options?: { extender?: boolean }): Uint8Array;
export function bootFloppy(message?: string): Uint8Array;
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
}): Uint8Array;
export function neExe(options?: { os?: number }): Uint8Array;
export function leExe(): Uint8Array;
export function machO(options?: { fat?: boolean }): Uint8Array;
export function classFile(major?: number, extra?: string): Uint8Array;
export function jar(options?: { mainClass?: string; major?: number; swing?: boolean }): Uint8Array;
export function apk(): Uint8Array;
export function isoImage(options?: { bootable?: boolean; label?: string }): Uint8Array;
export function swfMovie(options?: { frames?: number }): Uint8Array;
export function asar(files: Record<string, string | Uint8Array>): Uint8Array;
export const webIndex: string;
