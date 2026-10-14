// Illustrated "react" studio: three hosts with headphones and mics (fictional people).
const W = 1280, H = 720;
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
 <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1640"/><stop offset=".55" stop-color="#2a1b52"/><stop offset="1" stop-color="#0f1d3a"/></linearGradient>
 <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f3a"/><stop offset="1" stop-color="#14161c"/></linearGradient>
 <filter id="glow"><feGaussianBlur stdDeviation="18"/></filter>
 <filter id="soft"><feGaussianBlur stdDeviation="2.2"/></filter>
 <filter id="shadow"><feGaussianBlur stdDeviation="8"/></filter>
 <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .07 0"/></filter>
 <radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#wall)"/>`;
// LED strips and acoustic panels
s += `<rect x="0" y="70" width="${W}" height="10" fill="#ff3ea5" filter="url(#glow)" opacity=".9"/><rect x="0" y="72" width="${W}" height="4" fill="#ff7cc4"/>`;
for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) s += `<rect x="${30 + i * 140}" y="${110 + j * 92}" width="120" height="80" rx="6" fill="#ffffff" opacity="${0.035 + ((i + j) % 2) * 0.02}"/>`;
// shelf with a ball and a framed striped shirt
s += `<rect x="70" y="250" width="200" height="10" rx="3" fill="#0b0d14" opacity=".8"/><circle cx="130" cy="226" r="24" fill="#f2f2f2"/><path d="M130 214l9 7-3 10h-12l-3-10z" fill="#2b2b2b"/>`;
s += `<rect x="1040" y="120" width="150" height="150" rx="8" fill="#0b0d14" opacity=".85"/><g transform="translate(1115 205)"><path d="M-45-55l25-12h40l25 12 12 30-20 8-7-15v80h-60v-80l-7 15-20-8z" fill="#7c4dff"/><text x="0" y="22" font-family="Arial Black,Arial" font-weight="900" font-size="44" fill="#fff" text-anchor="middle">10</text></g>`;
// ring light glows
s += `<circle cx="1180" cy="40" r="70" fill="#b9e6ff" opacity=".25" filter="url(#glow)"/>`;
function host(x, skin, hair, hairStyle, hoodie, beard, cupColor) {
  let g = `<g transform="translate(${x} 0)">`;
  // body / hoodie
  g += `<path d="M-150 720 C-150 560 -110 500 0 488 C110 500 150 560 150 720z" fill="${hoodie}"/>`;
  g += `<path d="M-40 492 Q0 540 40 492" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="8"/>`;
  // neck and head
  g += `<rect x="-26" y="420" width="52" height="80" rx="20" fill="${skin}"/>`;
  g += `<ellipse cx="0" cy="370" rx="74" ry="88" fill="${skin}"/>`;
  g += `<ellipse cx="-74" cy="378" rx="12" ry="20" fill="${skin}"/><ellipse cx="74" cy="378" rx="12" ry="20" fill="${skin}"/>`;
  // hair
  if (hairStyle === 'curly') g += `<path d="M-78 350 C-90 260 -20 250 0 262 C30 240 96 262 80 352 C70 318 40 300 0 304 C-40 300 -66 318 -78 350z" fill="${hair}"/>${[-60, -30, 0, 30, 60].map(c => `<circle cx="${c}" cy="${280 + Math.abs(c) / 4}" r="22" fill="${hair}"/>`).join('')}`;
  else if (hairStyle === 'short') g += `<path d="M-76 352 C-80 272 -30 262 0 264 C40 262 82 280 76 352 C66 316 30 304 0 306 C-34 304 -64 318 -76 352z" fill="${hair}"/>`;
  else g += `<path d="M-74 340 C-70 280 -20 268 4 270 C50 270 80 296 74 344 C60 312 20 300 -10 304 C-40 306 -60 318 -74 340z" fill="${hair}"/>`;
  if (beard) g += `<path d="M-60 392 C-56 450 -24 470 0 470 C24 470 56 450 60 392 C46 420 24 430 0 430 C-24 430 -46 420 -60 392z" fill="${hair}" opacity=".95"/>`;
  // face: eyes, brows, mouth
  g += `<ellipse cx="-26" cy="370" rx="6" ry="7" fill="#1b130e"/><ellipse cx="26" cy="370" rx="6" ry="7" fill="#1b130e"/>`;
  g += `<path d="M-40 350 q14-8 28 0 M12 350 q14-8 28 0" stroke="${hair}" stroke-width="6" stroke-linecap="round" fill="none"/>`;
  g += `<path d="M-20 414 q20 14 40 0" stroke="#7a3b2c" stroke-width="6" stroke-linecap="round" fill="none"/>`;
  // headphones
  g += `<path d="M-86 372 C-92 250 92 250 86 372" fill="none" stroke="#151515" stroke-width="16" stroke-linecap="round"/>`;
  g += `<rect x="-104" y="344" width="34" height="66" rx="15" fill="#1d1d1f"/><rect x="70" y="344" width="34" height="66" rx="15" fill="#1d1d1f"/>`;
  g += `<rect x="-100" y="356" width="8" height="42" rx="4" fill="${cupColor}"/><rect x="92" y="356" width="8" height="42" rx="4" fill="${cupColor}"/>`;
  // microphone on a boom arm
  g += `<path d="M150 720 L118 560 L70 470" fill="none" stroke="#202227" stroke-width="10" stroke-linecap="round"/>`;
  g += `<rect x="38" y="430" width="44" height="86" rx="20" fill="#2b2d33" transform="rotate(-24 60 470)"/><rect x="44" y="440" width="32" height="50" rx="14" fill="#41444c" transform="rotate(-24 60 470)"/>`;
  return g + '</g>';
}
s += host(240, '#c68e62', '#2a1a10', 'short', '#2b2f3a', false, '#ff3ea5');
s += host(640, '#8d5a3b', '#151010', 'curly', '#7f1d1d', true, '#4ade80');
s += host(1040, '#f1c7a5', '#4a2e18', 'side', '#1f2937', true, '#60a5fa');
// desk edge
s += `<rect x="0" y="650" width="${W}" height="70" fill="url(#desk)"/><rect x="0" y="650" width="${W}" height="4" fill="#ff3ea5" opacity=".6"/>`;
s += `<rect width="${W}" height="${H}" fill="url(#vig)"/><rect width="${W}" height="${H}" filter="url(#grain)"/>`;
s += '</svg>';
process.stdout.write(s);
