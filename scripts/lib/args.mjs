// 最小の引数パーサー: --key value / --flag / --no-flag
export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    if (name.startsWith("no-")) {
      out[toCamel(name.slice(3))] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[toCamel(name)] = true;
    } else {
      out[toCamel(name)] = next;
      i++;
    }
  }
  return out;
}

const toCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
