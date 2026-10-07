// Builds a throwaway copy of this checkout with a different identity section, for voice runs that leave src/ alone.
// Usage: node eval/variant.ts <outDir> <identity.txt>; then node eval/run.ts <label> --repo <outDir>
import { cp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const [out, identityFile] = process.argv.slice(2);
if (out === undefined || identityFile === undefined) throw new Error("Usage: node eval/variant.ts <outDir> <identity.txt>");

await rm(out, { recursive: true, force: true });
for (const part of ["src", "skills", "agents", "package.json"]) await cp(join(REPO, part), join(out, part), { recursive: true });
await symlink(join(REPO, "node_modules"), join(out, "node_modules"));
const identity = (await readFile(identityFile, "utf8")).trim();
if (/[`$\\]/.test(identity)) throw new Error("The identity text may not contain backticks, dollar signs or backslashes.");
const promptFile = join(out, "src", "brain", "identity.ts");
const source = await readFile(promptFile, "utf8");
const swapped = source.replace(/const IDENTITY = `[\s\S]*?`;/, `const IDENTITY = \`${identity}\`;`);
if (swapped === source) throw new Error("Did not find the IDENTITY constant in src/brain/identity.ts.");
await writeFile(promptFile, swapped);
process.stdout.write(`${out} (identity ${identity.length} characters)\n`);
