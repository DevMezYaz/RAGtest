// Placeholder artwork (the original photos aren't available). Greyscale SVG, swap for real <img> later.
const wrap = (inner, vb = "0 0 400 300") =>
  `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

export const art = {
  portrait: () => wrap(`
    <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9d9d9"/><stop offset="1" stop-color="#6d6d6d"/></linearGradient></defs>
    <rect width="300" height="380" fill="url(#pg)"/>
    <path d="M20 380 C40 300 100 280 150 280 C200 280 260 300 280 380Z" fill="#202020"/>
    <ellipse cx="150" cy="170" rx="62" ry="78" fill="#bdbdbd"/>
    <path d="M86 150 C90 80 210 80 214 150 C200 110 100 110 86 150Z" fill="#e8e8e8"/>
    <ellipse cx="128" cy="170" rx="9" ry="5" fill="#333"/><ellipse cx="174" cy="170" rx="9" ry="5" fill="#333"/>
    <path d="M130 215 Q150 228 172 215" stroke="#444" stroke-width="3" fill="none"/>
    <rect x="196" y="195" width="52" height="70" rx="18" fill="#a9a9a9" transform="rotate(-18 220 230)"/>`, "0 0 300 380"),
  fallingwater: () => wrap(`
    <defs><linearGradient id="fs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfcfcf"/><stop offset="1" stop-color="#7c7c7c"/></linearGradient></defs>
    <rect width="400" height="300" fill="url(#fs)"/>
    <g fill="#2b2b2b"><ellipse cx="40" cy="60" rx="90" ry="70"/><ellipse cx="370" cy="40" rx="110" ry="60"/><ellipse cx="60" cy="260" rx="120" ry="60"/></g>
    <g fill="#f1f1f1" stroke="#222" stroke-width="2"><rect x="70" y="170" width="250" height="16"/><rect x="110" y="132" width="230" height="16"/><rect x="40" y="96" width="210" height="14"/></g>
    <g fill="#555"><rect x="170" y="148" width="14" height="22"/><rect x="250" y="110" width="12" height="22"/></g>
    <g stroke="#f4f4f4" stroke-width="5" opacity=".85"><path d="M150 186 V300"/><path d="M175 186 V300"/><path d="M200 186 V300"/><path d="M225 186 V300"/></g>`),
  robie: () => wrap(`
    <defs><linearGradient id="rs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3e3e3"/><stop offset="1" stop-color="#9d9d9d"/></linearGradient></defs>
    <rect width="400" height="300" fill="url(#rs)"/>
    <g fill="#1d1d1d"><path d="M10 120 L390 100 L395 118 L18 140Z"/><path d="M50 160 L350 148 L356 164 L58 178Z"/></g>
    <g fill="#777"><rect x="70" y="140" width="260" height="20"/><rect x="80" y="178" width="240" height="44"/></g>
    <g fill="#2e2e2e"><rect x="96" y="186" width="14" height="30"/><rect x="140" y="186" width="14" height="30"/><rect x="184" y="186" width="14" height="30"/><rect x="228" y="186" width="14" height="30"/><rect x="272" y="186" width="14" height="30"/></g>
    <rect y="236" width="400" height="64" fill="#3b3b3b"/>`),
  film: () => wrap(`<rect width="400" height="300" fill="#4a4a4a"/><ellipse cx="200" cy="130" rx="60" ry="72" fill="#9b9b9b"/><path d="M60 300 C80 220 140 210 200 210 C260 210 320 220 340 300Z" fill="#202020"/>`),
};
