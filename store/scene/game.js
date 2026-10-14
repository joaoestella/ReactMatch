// Illustrated broadcast wide shot of a football match (fictional teams). Prints SVG.
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const W = 1280, H = 720, PITCH = 300;
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
 <linearGradient id="stand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1320"/><stop offset="1" stop-color="#1c2638"/></linearGradient>
 <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f8a3b"/><stop offset="1" stop-color="#3fa04a"/></linearGradient>
 <filter id="soft"><feGaussianBlur stdDeviation="1.1"/></filter>
 <filter id="glow"><feGaussianBlur stdDeviation="10"/></filter>
 <filter id="shadow"><feGaussianBlur stdDeviation="3"/></filter>
 <radialGradient id="vig" cx=".5" cy=".55" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
 <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .06 0"/></filter>
</defs>
<rect width="${W}" height="${PITCH}" fill="url(#stand)"/>`;
// crowd: tiers of little heads and shirts
const shirts = ['#e8ecf2', '#d23a3a', '#f2c230', '#2f5fd0', '#1a1a1a', '#e27b2b', '#9aa7ba', '#c2185b'];
s += '<g filter="url(#soft)">';
for (let row = 0; row < 24; row++) {
  const y = 40 + row * 9.4, scale = 0.7 + row * 0.03;
  for (let x = -10; x < W + 10; x += 7.2 * scale + rnd() * 3) {
    if (rnd() < 0.08) continue;
    const c = shirts[Math.floor(rnd() * shirts.length)];
    s += `<rect x="${x.toFixed(1)}" y="${(y + 4 * scale).toFixed(1)}" width="${(5.4 * scale).toFixed(1)}" height="${(6 * scale).toFixed(1)}" rx="1.5" fill="${c}" opacity="${(0.55 + rnd() * 0.35).toFixed(2)}"/>`;
    s += `<circle cx="${(x + 2.7 * scale).toFixed(1)}" cy="${(y + 2 * scale).toFixed(1)}" r="${(2.2 * scale).toFixed(1)}" fill="${['#f1c7a5', '#c68e62', '#8d5a3b', '#5a3a26'][Math.floor(rnd() * 4)]}" opacity=".8"/>`;
  }
}
s += '</g>';
// roof and floodlight glow
s += `<rect width="${W}" height="34" fill="#070a10"/>`;
for (const x of [140, 420, 860, 1140]) s += `<ellipse cx="${x}" cy="22" rx="70" ry="18" fill="#fff8d8" opacity=".35" filter="url(#glow)"/>`;
// advertising boards (fictional)
const ads = [['#1d4ed8', 'FUTPLAY'], ['#f59e0b', 'GOL!'], ['#111827', 'BOLA+'], ['#dc2626', 'AO VIVO'], ['#059669', 'TORCIDA'], ['#7c3aed', 'RESENHA']];
let ax = -40; let i = 0;
while (ax < W) { const [c, t] = ads[i++ % ads.length]; s += `<rect x="${ax}" y="258" width="210" height="36" fill="${c}"/><text x="${ax + 105}" y="284" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="22" fill="#fff" text-anchor="middle" opacity=".92">${t}</text>`; ax += 210; }
s += `<rect y="294" width="${W}" height="6" fill="#0c3b18" opacity=".6"/>`;
// pitch with mowing stripes seen in perspective
s += `<rect y="${PITCH}" width="${W}" height="${H - PITCH}" fill="url(#grass)"/>`;
for (let k = -8; k < 16; k += 2) {
  const top = 90 * k, bottom = 150 * k - 200;
  s += `<polygon points="${top},${PITCH} ${top + 90},${PITCH} ${bottom + 150},${H} ${bottom},${H}" fill="#fff" opacity=".045"/>`;
}
// lines
s += `<g stroke="#f4fff4" stroke-width="4" fill="none" opacity=".9">
 <line x1="0" y1="${PITCH + 14}" x2="${W}" y2="${PITCH + 14}"/>
 <line x1="560" y1="${PITCH + 14}" x2="470" y2="${H}"/>
 <ellipse cx="520" cy="520" rx="200" ry="92"/>
</g><circle cx="520" cy="520" r="5" fill="#f4fff4"/>`;
// players: [x, y(feet), height, shirt, shorts, socks, skin, hair, lean]
function player(x, y, h, shirt, shorts, socks, skin, hair, lean, stride) {
  const u = h / 100;
  let g = `<g transform="translate(${x} ${y}) rotate(${lean})">`;
  g += `<ellipse cx="0" cy="2" rx="${26 * u}" ry="${6 * u}" fill="#000" opacity=".28" filter="url(#shadow)"/>`;
  // legs
  g += `<rect x="${-10 * u}" y="${-46 * u}" width="${8 * u}" height="${44 * u}" rx="${4 * u}" fill="${socks}" transform="rotate(${stride} ${-6 * u} ${-46 * u})"/>`;
  g += `<rect x="${2 * u}" y="${-46 * u}" width="${8 * u}" height="${44 * u}" rx="${4 * u}" fill="${socks}" transform="rotate(${-stride} ${6 * u} ${-46 * u})"/>`;
  g += `<rect x="${-10 * u}" y="${-46 * u}" width="${8 * u}" height="${14 * u}" rx="${3 * u}" fill="${skin}" transform="rotate(${stride} ${-6 * u} ${-46 * u})"/>`;
  g += `<rect x="${2 * u}" y="${-46 * u}" width="${8 * u}" height="${14 * u}" rx="${3 * u}" fill="${skin}" transform="rotate(${-stride} ${6 * u} ${-46 * u})"/>`;
  // shorts, shirt, arms
  g += `<rect x="${-13 * u}" y="${-58 * u}" width="${26 * u}" height="${16 * u}" rx="${4 * u}" fill="${shorts}"/>`;
  g += `<rect x="${-20 * u}" y="${-60 * u}" width="${8 * u}" height="${28 * u}" rx="${4 * u}" fill="${skin}" transform="rotate(${stride + 12} ${-16 * u} ${-84 * u})"/>`;
  g += `<rect x="${12 * u}" y="${-60 * u}" width="${8 * u}" height="${28 * u}" rx="${4 * u}" fill="${skin}" transform="rotate(${-stride - 12} ${16 * u} ${-84 * u})"/>`;
  g += `<path d="M${-16 * u} ${-88 * u} q${16 * u} ${-6 * u} ${32 * u} 0 l${4 * u} ${12 * u} l${-5 * u} ${2 * u} l${-1 * u} ${18 * u} h${-28 * u} l${-1 * u} ${-18 * u} l${-5 * u} ${-2 * u} z" fill="${shirt}"/>`;
  // head
  g += `<rect x="${-4 * u}" y="${-95 * u}" width="${8 * u}" height="${8 * u}" fill="${skin}"/>`;
  g += `<circle cx="0" cy="${-101 * u}" r="${9 * u}" fill="${skin}"/>`;
  g += `<path d="M${-9 * u} ${-102 * u} a${9 * u} ${9 * u} 0 0 1 ${18 * u} 0 q${-9 * u} ${-4 * u} ${-18 * u} 0z" fill="${hair}"/>`;
  return g + '</g>';
}
const red = ['#d6262e', '#ffffff', '#d6262e'], white = ['#f3f4f6', '#111827', '#f3f4f6'];
s += player(300, 470, 96, ...red, '#c68e62', '#2b1a10', 6, 18);
s += player(690, 455, 92, ...white, '#8d5a3b', '#111', -4, -16);
s += player(860, 560, 118, ...red, '#f1c7a5', '#6b3f1d', 8, 22);
s += player(980, 430, 80, ...white, '#c68e62', '#1a1a1a', -6, 14);
s += player(170, 640, 140, ...white, '#5a3a26', '#0d0d0d', -3, -20);
s += player(1120, 520, 104, ...red, '#8d5a3b', '#151515', 5, -18);
// ball
s += `<ellipse cx="930" cy="604" rx="16" ry="4" fill="#000" opacity=".3" filter="url(#shadow)"/><circle cx="928" cy="588" r="13" fill="#fafafa"/><path d="M928 581l5 4-2 6h-6l-2-6z" fill="#222"/>`;
s += `<rect width="${W}" height="${H}" fill="url(#vig)"/><rect width="${W}" height="${H}" filter="url(#grain)"/>`;
s += '</svg>';
process.stdout.write(s);
