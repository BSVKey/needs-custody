#!/usr/bin/env node
// Build the field health page: field-src/app.mjs (with core.js, wire.js, qrcode-generator,
// jsQR and ggwave) bundled into site/field/app.js, and site/field/kit.html, the whole page in
// ONE file (styles and script inline) that can be passed to a phone that never had signal.
//
//   npm install && node bin/build-field.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const out = await build({
  entryPoints: [here("field-src/app.mjs")],
  bundle: true, minify: true, write: false, format: "iife", platform: "browser", target: "es2020",
  external: ["fs", "path"], // ggwave's Node-only branch; never reached in a browser
  legalComments: "eof",
  logLevel: "warning",
});
const js = out.outputFiles[0].text;

const mit = (who) => `Copyright (c) ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const notices = [
  ["ggwave 0.4.0 (MIT)", mit("Georgi Gerganov")],
  ["qrcode-generator 2.0.4 (MIT)", mit("2009 Kazuhiko Arase")],
  ["jsqr 1.4.0 (Apache-2.0)", readFileSync(here("node_modules/jsqr/LICENSE"), "utf8").trim()],
].map(([name, text]) => `==== ${name} ====\n\n${text}`).join("\n\n");
writeFileSync(here("site/field/THIRD-PARTY-NOTICES.txt"), notices + "\n");
writeFileSync(here("site/field/app.js"), `/* Field health kit, built from field-src/ by bin/build-field.mjs. Third-party licences: /field/THIRD-PARTY-NOTICES.txt */\n${js}`);

const css = ["site/style.css", "site/pilot/pilot.css", "site/field/field.css"].map((p) => readFileSync(here(p), "utf8")).join("\n");
const page = readFileSync(here("site/field/index.html"), "utf8")
  .replace(/<link rel="stylesheet"[^>]*>\n?/g, "")
  .replace("</head>", () => `<style>\n${css}</style>\n</head>`)
  .replace(/<script src="\/field\/app\.js[^"]*"><\/script>/, () => `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>`)
  .replace("</html>", () => `</html>\n<!-- Third-party software in this page and its licences:\n\n${notices.replace(/--/g, "- -")}\n-->\n`);
if (/<link rel="stylesheet"|src="\/field\/app\.js/.test(page)) throw new Error("kit.html still points at outside files");
writeFileSync(here("site/field/kit.html"), page);
console.log(`site/field/app.js ${(js.length / 1024).toFixed(0)} KB, site/field/kit.html ${(page.length / 1024).toFixed(0)} KB`);
