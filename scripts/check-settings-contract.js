import { readFileSync } from "node:fs";

const handlerSource = readFileSync(new URL("../src/core/createPlot.ts", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../src/interaction/settingsHtml.ts", import.meta.url), "utf8");

const queriedIds = new Set(
  [...handlerSource.matchAll(/querySelector(?:<[^>]+>)?\(["']#([\w-]+)/g)].map((match) => match[1])
);
const renderedIds = new Set(
  [...htmlSource.matchAll(/\bid=["']([\w-]+)["']/g)].map((match) => match[1])
);

const missingIds = [...queriedIds].filter((id) => !renderedIds.has(id)).sort();

if (missingIds.length > 0) {
  console.error(`Settings handler queries IDs not rendered by settingsHtml.ts:\n${missingIds.map((id) => `- ${id}`).join("\n")}`);
  process.exitCode = 1;
}
