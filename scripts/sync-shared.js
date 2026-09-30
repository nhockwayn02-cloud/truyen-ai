#!/usr/bin/env node
// Đồng bộ shared/core.js vào index.html và netlify/functions/write-chapter-background.js
// (chỉ thay nội dung giữa 2 dòng đánh dấu SHARED-CORE:BEGIN / END). Không cần thư viện ngoài.
// Dùng:  node scripts/sync-shared.js          -> ghi đè
//        node scripts/sync-shared.js --check  -> chỉ kiểm tra, thoát mã 1 nếu lệch
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const CORE = fs.readFileSync(path.join(ROOT, "shared/core.js"), "utf8").replace(/^(?:\/\/[^\n]*\n)+\n?/, "").trim();
const BEGIN = "// <<SHARED-CORE:BEGIN>> (tự sinh từ shared/core.js — KHÔNG sửa tay; chạy: node scripts/sync-shared.js)";
const END = "// <<SHARED-CORE:END>>";
const TARGETS = ["index.html", "netlify/functions/write-chapter-background.js"];
function render(text) {
  const i = text.indexOf("// <<SHARED-CORE:BEGIN>>");
  if (i < 0) throw new Error("Thiếu dấu BEGIN");
  const bEnd = text.indexOf("\n", i);
  const j = text.indexOf(END, bEnd);
  if (j < 0) throw new Error("Thiếu dấu END");
  return text.slice(0, i) + BEGIN + "\n" + CORE + "\n" + text.slice(j);
}
const check = process.argv.includes("--check");
let bad = 0;
for (const rel of TARGETS) {
  const p = path.join(ROOT, rel); const cur = fs.readFileSync(p, "utf8"); const next = render(cur);
  if (cur === next) { console.log("OK    " + rel); continue; }
  if (check) { console.log("LỆCH  " + rel); bad++; } else { fs.writeFileSync(p, next); console.log("ĐÃ GHI " + rel); }
}
process.exit(bad ? 1 : 0);
