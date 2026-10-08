import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildVector } from "../test/vector.js";

const out = fileURLToPath(new URL("../../test/vectors/tree-vector.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(await buildVector(), null, 2)}\n`);
console.log(`wrote ${out}`);
