// ローカルのスクリプト用の KV（Workers KV の get/put/delete と同じ形）
// 指定したキーはファイルに保存し、それ以外はメモリに置く。ファイルは権限 600 で書く。
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";

export async function writePrivateFile(path, content) {
  const tmp = `${path}.tmp${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * @param {Record<string, string>} files キー → ファイルパス（例: { oauth: "auth.local.json" }）
 */
export function createFileKV(files = {}) {
  const memory = new Map();
  return {
    async get(key) {
      if (files[key]) {
        try {
          return await readFile(files[key], "utf8");
        } catch (e) {
          if (e.code === "ENOENT") return null;
          throw e;
        }
      }
      return memory.has(key) ? memory.get(key) : null;
    },
    async put(key, value) {
      if (files[key]) return writePrivateFile(files[key], String(value));
      memory.set(key, String(value));
    },
    async delete(key) {
      if (files[key]) return rm(files[key], { force: true });
      memory.delete(key);
    },
  };
}
