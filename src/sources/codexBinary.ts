import { access, stat } from "node:fs/promises";
import * as path from "node:path";

export const CODEX_COMMAND = "codex";

/** The Windows variants, in the order tried: the executable needs no shell. */
export const WINDOWS_EXTENSIONS: readonly string[] = [".exe", ".cmd"];

export interface BinaryEnvironment {
  readonly platform: NodeJS.Platform;
  /** The `PATH` variable (`Path` on Windows); `undefined` when unset. */
  readonly pathVariable: string | undefined;
  /** Whether `filePath` is a file the user may run. */
  readonly isExecutable: (filePath: string) => Promise<boolean>;
}

/** The real file system: a regular file, executable by the user where the OS has such a bit. */
export async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    if (!(await stat(filePath)).isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      await access(filePath, 1 /* fs.constants.X_OK */);
    }
    return true;
  } catch {
    return false;
  }
}

export function defaultBinaryEnvironment(): BinaryEnvironment {
  return {
    platform: process.platform,
    pathVariable: process.env.PATH ?? process.env.Path,
    isExecutable: isExecutableFile,
  };
}

function pathModule(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The file names to try for `base`: on Windows the `.exe` and `.cmd` variants too. */
function candidates(base: string, platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") {
    return [base];
  }
  const extension = path.win32.extname(base).toLowerCase();
  return WINDOWS_EXTENSIONS.includes(extension)
    ? [base]
    : WINDOWS_EXTENSIONS.map((suffix) => `${base}${suffix}`);
}

async function firstExecutable(
  files: readonly string[],
  environment: BinaryEnvironment,
): Promise<string | null> {
  for (const file of files) {
    if (await environment.isExecutable(file)) {
      return file;
    }
  }
  return null;
}

/**
 * Finds the `codex` binary: the configured path when there is one (it is not
 * replaced by a `PATH` hit when it does not exist), otherwise the first hit
 * on `PATH`. `null` when there is none.
 */
export async function resolveCodexBinary(
  configuredPath: string | undefined,
  environment: BinaryEnvironment = defaultBinaryEnvironment(),
): Promise<string | null> {
  const platformPath = pathModule(environment.platform);
  const configured = configuredPath?.trim() ?? "";
  if (configured !== "") {
    return firstExecutable(candidates(configured, environment.platform), environment);
  }
  const directories = (environment.pathVariable ?? "")
    .split(platformPath.delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
    .filter((directory) => directory !== "");
  for (const directory of directories) {
    const found = await firstExecutable(
      candidates(platformPath.join(directory, CODEX_COMMAND), environment.platform),
      environment,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** A `.cmd`/`.bat` file can only be started through the shell, which `spawn` must be told. */
export function needsShell(binary: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(binary);
}
