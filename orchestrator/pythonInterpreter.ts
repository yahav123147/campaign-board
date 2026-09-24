import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PythonInterpreterDeps {
  readonly home?: string;
  readonly access?: (file: string) => Promise<void>;
}

/**
 * The interpreter every image tool runs under: the venv that setup.sh builds
 * (and the doctor checks), falling back to PATH's python3 only when there is
 * none. One resolver for the whole product: on a clean WSL2 machine the
 * system python3 has no Pillow, and a tool spawned with the bare name failed
 * at import while the doctor, checking the venv, reported ready.
 */
export async function resolvePython(deps: PythonInterpreterDeps = {}): Promise<string> {
  const home = deps.home ?? os.homedir();
  const access = deps.access ?? ((file: string) => fs.access(file));
  const venvPython = path.join(home, ".campaign-council-venv", "bin", "python3");
  try {
    await access(venvPython);
    return venvPython;
  } catch {
    return "python3";
  }
}
