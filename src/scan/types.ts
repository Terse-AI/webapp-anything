import type { ExecutableInfo } from "../formats/executables.js";
import type { DiskImageInfo, SwfInfo } from "../formats/media.js";

export type InputKind =
  | "dos-program"
  | "windows-program"
  | "linux-program"
  | "macos-program"
  | "java-app"
  | "flash-movie"
  | "disk-image"
  | "jsdos-bundle"
  | "electron-app"
  | "web-app"
  | "android-app"
  | "ios-app"
  | "wasm-module"
  | "script"
  | "unknown";

export type ProgramKind =
  | "dos"
  | "win16"
  | "win32"
  | "win64"
  | "win-arm"
  | "dotnet"
  | "linux"
  | "macos"
  | "jar"
  | "swf"
  | "disk"
  | "batch";

export interface FoundProgram {
  path: string;
  size: number;
  kind: ProgramKind;
  description: string;
  score: number;
}

export interface JavaInfo {
  mainClass?: string;
  classPath?: string[];
  javaVersion?: number;
  swing?: boolean;
  javafx?: boolean;
}

export interface ElectronInfo {
  /** Path inside the tree of the extracted app root (where package.json lives). */
  appRoot: string;
  /** Main-process entry script. */
  main?: string;
  /** Renderer HTML page we found. */
  page?: string;
  /** If the app only wraps a remote site, its URL. */
  remoteUrl?: string;
  usesNodeInRenderer: boolean;
}

export interface ScanReport {
  schema: 1;
  input: {
    name: string;
    size: number;
    sha256?: string;
    container: "file" | "dir" | "zip" | "asar";
    files: number;
  };
  kind: InputKind;
  summary: string;
  /** Path inside the input of the thing to run (program, movie, image, page...). */
  entry?: string;
  executable?: ExecutableInfo;
  swf?: SwfInfo;
  disk?: DiskImageInfo;
  java?: JavaInfo;
  electron?: ElectronInfo;
  web?: { index: string };
  script?: { interpreter: string };
  /** Every runnable thing we found, best first. */
  programs: FoundProgram[];
  warnings: string[];
}
