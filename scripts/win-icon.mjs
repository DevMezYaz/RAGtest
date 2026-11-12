// Puts our icon and name into Yab.exe (the copy of electron.exe) so Explorer, the taskbar and shortcuts show Yab, not Electron.
// Pure JS (resedit), so it works from the Mac. Usage: node scripts/win-icon.mjs <Yab.exe> <icon.ico>
import fs from "node:fs";
import * as ResEdit from "resedit";

const [exePath, icoPath] = process.argv.slice(2);
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
const res = ResEdit.NtExecutableResource.from(exe);

const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
if (!groups.length) throw new Error("no icon group found in the exe");
const icons = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath)).icons.map((i) => i.data);
for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
if (vi) {
  const lang = vi.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
  vi.setStringValues(lang, { ProductName: "Yab", FileDescription: "Yab", InternalName: "Yab", OriginalFilename: "Yab.exe", CompanyName: "Royal Chains", LegalCopyright: "" });
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log("icon + name set on", exePath);
