/* Fancy Text Pack — Unicode fancy text styles.
   Script-pack module: one file registering 9 palette scripts.
   Extracted verbatim from txt.html (core slimming). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var registerScript = function (src) { window.Cade.registerScript(src); };

registerScript(`/**
  {
    "name": "Double-Struck (𝔻𝕠𝕦𝕓𝕝𝕖)",
    "description": "Convert to Unicode double-struck (blackboard bold) — toggles off",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><text x='12' y='16' font-size='12' font-weight='bold' text-anchor='middle' fill='currentColor' stroke='none'>𝔻</text></svg>",
    "tags": "doublestruck,blackboard,fancy,unicode,text,format,math"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  // Special uppercase chars not in the sequential block
  const dsSpecial = {C:0x2102,H:0x210D,N:0x2115,P:0x2119,Q:0x211A,R:0x211D,Z:0x2124};
  // Build reverse map for specials
  const dsSpecialRev = {};
  for (const [k,v] of Object.entries(dsSpecial)) dsSpecialRev[v] = k;
  // Sequential block skips the special letters, so we need offset mapping
  const dsUpperSeq = 'ABDEFGIJKLMOSTUVWXY';
  function toDS(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x61 && c <= 0x7A) return String.fromCodePoint(0x1D552 + c - 0x61);
    if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(0x1D7D8 + c - 0x30);
    const upper = String.fromCharCode(c);
    if (dsSpecial[upper]) return String.fromCodePoint(dsSpecial[upper]);
    if (c >= 0x41 && c <= 0x5A) return String.fromCodePoint(0x1D538 + c - 0x41);
    return null;
  }
  function fromDS(cp) {
    if (cp >= 0x1D552 && cp <= 0x1D56B) return String.fromCodePoint(0x61 + cp - 0x1D552);
    if (cp >= 0x1D7D8 && cp <= 0x1D7E1) return String.fromCodePoint(0x30 + cp - 0x1D7D8);
    if (dsSpecialRev[cp]) return dsSpecialRev[cp];
    if (cp >= 0x1D538 && cp <= 0x1D551) return String.fromCodePoint(0x41 + cp - 0x1D538);
    return null;
  }
  const cps = [...text];
  const isDS = cps.some(ch => fromDS(ch.codePointAt(0)));
  const result = cps.map(ch => {
    const cp = ch.codePointAt(0);
    if (isDS) return fromDS(cp) || ch;
    return toDS(ch) || ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Small Caps (ꜱᴍᴀʟʟ)",
    "description": "Convert to Unicode small capitals — toggles off",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><text x='5' y='18' font-size='18' font-weight='bold' fill='currentColor' stroke='none'>A</text><text x='15' y='18' font-size='12' fill='currentColor' stroke='none'>ᴀ</text></svg>",
    "tags": "smallcaps,small,capitals,fancy,unicode,text,format"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const scMap = {a:0x1D00,b:0x0299,c:0x1D04,d:0x1D05,e:0x1D07,f:0xA730,g:0x0262,h:0x029C,i:0x026A,j:0x1D0A,k:0x1D0B,l:0x029F,m:0x1D0D,n:0x0274,o:0x1D0F,p:0x1D18,r:0x0280,s:0xA731,t:0x1D1B,u:0x1D1C,v:0x1D20,w:0x1D21,y:0x028F,z:0x1D22};
  const scRev = {};
  for (const [k,v] of Object.entries(scMap)) scRev[v] = k;
  function toSC(ch) {
    const lower = ch.toLowerCase();
    if (scMap[lower]) return String.fromCodePoint(scMap[lower]);
    return null;
  }
  const cps = [...text];
  const isSC = cps.some(ch => scRev[ch.codePointAt(0)]);
  const result = cps.map(ch => {
    const cp = ch.codePointAt(0);
    if (isSC) return scRev[cp] || ch;
    return toSC(ch) || ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Double Underline (U̳n̳d̳e̳r̳)",
    "description": "Add/remove Unicode combining double underline on each character",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3'/><line x1='4' y1='19' x2='20' y2='19'/><line x1='4' y1='22' x2='20' y2='22'/></svg>",
    "tags": "double,underline,under,fancy,unicode,text,format"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const COMBINING = '\\u0333';
  if (text.includes(COMBINING)) {
    const result = text.split(COMBINING).join('');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  } else {
    const result = [...text].map(ch => ch === '\\n' || ch === '\\r' ? ch : ch + COMBINING).join('');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  }
}`);

registerScript(`/**
  {
    "name": "Strikethrough (S̶t̶r̶i̶k̶e̶)",
    "description": "Add/remove Unicode combining strikethrough on each character",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='4' y1='12' x2='20' y2='12'/><path d='M17.5 7.5C17.5 5 15.3 3 12 3 9 3 6.5 4.7 6.5 7c0 1.5.8 2.8 2.5 3.5'/><path d='M8.5 16.5C8.5 19 10.7 21 14 21c2.5 0 4.5-1.3 5-3.5'/></svg>",
    "tags": "strikethrough,strike,cross,fancy,unicode,text,format"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const COMBINING = '\\u0336';
  if (text.includes(COMBINING)) {
    const result = text.split(COMBINING).join('');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  } else {
    const result = [...text].map(ch => ch === '\\n' || ch === '\\r' ? ch : ch + COMBINING).join('');
    if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
  }
}`);

registerScript(`/**
  {
    "name": "Bubble Text (ⓑⓤⓑⓑⓛⓔ)",
    "description": "Convert letters and digits to Unicode circled (bubble) characters — toggles off",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><text x='12' y='16.5' font-size='12' font-weight='bold' text-anchor='middle' fill='currentColor' stroke='none'>b</text></svg>",
    "tags": "bubble,circled,circle,enclosed,fancy,unicode,text,format"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  // Ⓐ-Ⓩ U+24B6, ⓐ-ⓩ U+24D0, ⓪ U+24EA, ①-⑨ U+2460
  function toBubble(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x41 && c <= 0x5A) return String.fromCodePoint(0x24B6 + c - 0x41);
    if (c >= 0x61 && c <= 0x7A) return String.fromCodePoint(0x24D0 + c - 0x61);
    if (c === 0x30) return String.fromCodePoint(0x24EA);
    if (c >= 0x31 && c <= 0x39) return String.fromCodePoint(0x2460 + c - 0x31);
    return null;
  }
  function fromBubble(cp) {
    if (cp >= 0x24B6 && cp <= 0x24CF) return String.fromCodePoint(0x41 + cp - 0x24B6);
    if (cp >= 0x24D0 && cp <= 0x24E9) return String.fromCodePoint(0x61 + cp - 0x24D0);
    if (cp === 0x24EA) return '0';
    if (cp >= 0x2460 && cp <= 0x2468) return String.fromCodePoint(0x31 + cp - 0x2460);
    return null;
  }
  const cps = [...text];
  const isBubble = cps.some(ch => fromBubble(ch.codePointAt(0)));
  const result = cps.map(ch => {
    const cp = ch.codePointAt(0);
    if (isBubble) return fromBubble(cp) || ch;
    return toBubble(ch) || ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Superscript (ˢᵘᵖᵉʳ)",
    "description": "Convert to Unicode superscript letters, digits and + − = ( ) — closest available form, toggles off",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 19l8-8'/><path d='M12 19l-8-8'/><path d='M20 12h-4c0-1.5.44-2 1.5-2.5S20 8.33 20 7.3c0-.6-.25-1.07-.75-1.3-.5-.23-1.13-.2-1.6.06-.42.24-.65.56-.65.94'/></svg>",
    "tags": "superscript,super,exponent,power,raised,small,fancy,unicode,text,format,math"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  // Unicode has no superscript capital C F Q S X Y Z and no small q: capitals
  // fall back to the lowercase form, q stays as it is.
  const SUP = {
    a:0x1D43,b:0x1D47,c:0x1D9C,d:0x1D48,e:0x1D49,f:0x1DA0,g:0x1D4D,h:0x02B0,i:0x2071,j:0x02B2,k:0x1D4F,l:0x02E1,m:0x1D50,
    n:0x207F,o:0x1D52,p:0x1D56,r:0x02B3,s:0x02E2,t:0x1D57,u:0x1D58,v:0x1D5B,w:0x02B7,x:0x02E3,y:0x02B8,z:0x1DBB,
    A:0x1D2C,B:0x1D2E,D:0x1D30,E:0x1D31,G:0x1D33,H:0x1D34,I:0x1D35,J:0x1D36,K:0x1D37,L:0x1D38,M:0x1D39,N:0x1D3A,
    O:0x1D3C,P:0x1D3E,R:0x1D3F,T:0x1D40,U:0x1D41,V:0x2C7D,W:0x1D42,
    0:0x2070,1:0x00B9,2:0x00B2,3:0x00B3,4:0x2074,5:0x2075,6:0x2076,7:0x2077,8:0x2078,9:0x2079,
    '+':0x207A,'-':0x207B,'\\u2212':0x207B,'=':0x207C,'(':0x207D,')':0x207E
  };
  const rev = {};
  for (const [k, v] of Object.entries(SUP)) if (!(v in rev)) rev[v] = k;
  function toSup(ch) {
    if (SUP[ch] !== undefined) return String.fromCodePoint(SUP[ch]);
    const lo = ch.toLowerCase();
    if (/^[A-Z]$/.test(ch) && SUP[lo] !== undefined) return String.fromCodePoint(SUP[lo]);
    return null;
  }
  const cps = [...text];
  const isSup = cps.some(ch => rev[ch.codePointAt(0)] !== undefined);
  const result = cps.map(ch => {
    if (isSup) { const r = rev[ch.codePointAt(0)]; return r !== undefined ? r : ch; }
    return toSup(ch) || ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Subscript (ₛᵤᵦ)",
    "description": "Convert to Unicode subscript digits, + − = ( ) and the letters that exist (a e h i j k l m n o p r s t u v x, β-style b, γ-style y) — toggles off",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 5l8 8'/><path d='M12 5l-8 8'/><path d='M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14.3c0-.6-.25-1.07-.75-1.3-.5-.23-1.13-.2-1.6.06-.42.24-.65.56-.65.94'/></svg>",
    "tags": "subscript,sub,index,chemistry,formula,lowered,small,fancy,unicode,text,format,math"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  // Only these letters have subscript forms; b and y borrow the Greek ᵦ / ᵧ.
  // Capitals use the lowercase form; anything else is left as it is.
  const SUB = {
    a:0x2090,e:0x2091,o:0x2092,x:0x2093,h:0x2095,k:0x2096,l:0x2097,m:0x2098,n:0x2099,p:0x209A,s:0x209B,t:0x209C,
    i:0x1D62,r:0x1D63,u:0x1D64,v:0x1D65,j:0x2C7C,b:0x1D66,y:0x1D67,
    0:0x2080,1:0x2081,2:0x2082,3:0x2083,4:0x2084,5:0x2085,6:0x2086,7:0x2087,8:0x2088,9:0x2089,
    '+':0x208A,'-':0x208B,'\\u2212':0x208B,'=':0x208C,'(':0x208D,')':0x208E
  };
  const rev = {};
  for (const [k, v] of Object.entries(SUB)) if (!(v in rev)) rev[v] = k;
  function toSub(ch) {
    if (SUB[ch] !== undefined) return String.fromCodePoint(SUB[ch]);
    const lo = ch.toLowerCase();
    if (/^[A-Z]$/.test(ch) && SUB[lo] !== undefined) return String.fromCodePoint(SUB[lo]);
    return null;
  }
  const cps = [...text];
  const isSub = cps.some(ch => rev[ch.codePointAt(0)] !== undefined);
  const result = cps.map(ch => {
    if (isSub) { const r = rev[ch.codePointAt(0)]; return r !== undefined ? r : ch; }
    return toSub(ch) || ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Monospace (𝚖𝚘𝚗𝚘)",
    "description": "Convert to Unicode mathematical monospace (typewriter) letters and digits — toggles off",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><text x='12' y='16' font-size='11' font-family='monospace' text-anchor='middle' fill='currentColor' stroke='none'>mo</text></svg>",
    "tags": "monospace,mono,typewriter,code,fixed,fancy,unicode,text,format,math"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  // 𝙰-𝚉 U+1D670, 𝚊-𝚣 U+1D68A, 𝟶-𝟿 U+1D7F6 (no gaps in this block)
  function toMono(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x41 && c <= 0x5A) return String.fromCodePoint(0x1D670 + c - 0x41);
    if (c >= 0x61 && c <= 0x7A) return String.fromCodePoint(0x1D68A + c - 0x61);
    if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(0x1D7F6 + c - 0x30);
    return null;
  }
  function fromMono(cp) {
    if (cp >= 0x1D670 && cp <= 0x1D689) return String.fromCodePoint(0x41 + cp - 0x1D670);
    if (cp >= 0x1D68A && cp <= 0x1D6A3) return String.fromCodePoint(0x61 + cp - 0x1D68A);
    if (cp >= 0x1D7F6 && cp <= 0x1D7FF) return String.fromCodePoint(0x30 + cp - 0x1D7F6);
    return null;
  }
  const cps = [...text];
  const isMono = cps.some(ch => fromMono(ch.codePointAt(0)));
  const result = cps.map(ch => {
    const cp = ch.codePointAt(0);
    if (isMono) return fromMono(cp) || ch;
    return toMono(ch) || ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

registerScript(`/**
  {
    "name": "Defancify",
    "description": "Strip all Unicode fancy formatting — bold, italic, double-struck, monospace, small caps, bubble, superscript, subscript, fullwidth, combining marks",
    "author": "Cade",
    "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='4' y1='4' x2='20' y2='20'/><line x1='4' y1='20' x2='20' y2='4'/></svg>",
    "tags": "defancify,strip,clean,plain,unicode,remove,format,reset"
  }
**/
function main(ctx) {
  const text = ctx.selection || ctx.fullText;
  const map = {};
  // Helper: map a 26-letter upper + lower block (and optionally digits)
  function addAlpha(upperStart, lowerStart) {
    for (let i = 0; i < 26; i++) {
      map[upperStart + i] = 0x41 + i;
      map[lowerStart + i] = 0x61 + i;
    }
  }
  function addDigits(start) {
    for (let i = 0; i < 10; i++) map[start + i] = 0x30 + i;
  }
  // Mathematical bold (serif)
  addAlpha(0x1D400, 0x1D41A); addDigits(0x1D7CE);
  // Mathematical italic (serif) — note: h is U+210E
  addAlpha(0x1D434, 0x1D44E); map[0x210E] = 0x68;
  // Mathematical bold italic (serif)
  addAlpha(0x1D468, 0x1D482);
  // Mathematical script
  addAlpha(0x1D49C, 0x1D4B6);
  // Script specials: B E F H I L M R
  map[0x212C]=0x42; map[0x2130]=0x45; map[0x2131]=0x46; map[0x210B]=0x48;
  map[0x2110]=0x49; map[0x2112]=0x4C; map[0x2133]=0x4D; map[0x211B]=0x52;
  // Script lowercase specials: e g o
  map[0x212F]=0x65; map[0x210A]=0x67; map[0x2134]=0x6F;
  // Mathematical bold script
  addAlpha(0x1D4D0, 0x1D4EA);
  // Mathematical fraktur
  addAlpha(0x1D504, 0x1D51E);
  // Fraktur specials: C H I R Z
  map[0x212D]=0x43; map[0x210C]=0x48; map[0x2111]=0x49; map[0x211C]=0x52; map[0x2128]=0x5A;
  // Mathematical bold fraktur
  addAlpha(0x1D56C, 0x1D586);
  // Mathematical sans-serif
  addAlpha(0x1D5A0, 0x1D5BA); addDigits(0x1D7E2);
  // Mathematical sans-serif bold
  addAlpha(0x1D5D4, 0x1D5EE); addDigits(0x1D7EC);
  // Mathematical sans-serif italic
  addAlpha(0x1D608, 0x1D622);
  // Mathematical sans-serif bold italic
  addAlpha(0x1D63C, 0x1D656);
  // Mathematical monospace
  addAlpha(0x1D670, 0x1D68A); addDigits(0x1D7F6);
  // Double-struck
  addAlpha(0x1D538, 0x1D552); addDigits(0x1D7D8);
  // Double-struck specials
  var ds = {0x2102:0x43,0x210D:0x48,0x2115:0x4E,0x2119:0x50,0x211A:0x51,0x211D:0x52,0x2124:0x5A};
  for (var k in ds) map[parseInt(k)] = ds[k];
  // Small caps
  var sc = {0x1D00:0x61,0x0299:0x62,0x1D04:0x63,0x1D05:0x64,0x1D07:0x65,0xA730:0x66,0x0262:0x67,0x029C:0x68,0x026A:0x69,0x1D0A:0x6A,0x1D0B:0x6B,0x029F:0x6C,0x1D0D:0x6D,0x0274:0x6E,0x1D0F:0x6F,0x1D18:0x70,0x0280:0x72,0xA731:0x73,0x1D1B:0x74,0x1D1C:0x75,0x1D20:0x76,0x1D21:0x77,0x028F:0x79,0x1D22:0x7A};
  for (var k in sc) map[parseInt(k)] = sc[k];
  // Circled letters (Ⓐ-Ⓩ, ⓐ-ⓩ, ⓪-⑨)
  for (let i = 0; i < 26; i++) { map[0x24B6 + i] = 0x41 + i; map[0x24D0 + i] = 0x61 + i; }
  map[0x24EA] = 0x30; for (let i = 1; i <= 9; i++) map[0x2460 + i - 1] = 0x30 + i;
  // Fullwidth ASCII (Ａ-Ｚ, ａ-ｚ, ０-９)
  for (let i = 0; i < 26; i++) { map[0xFF21 + i] = 0x41 + i; map[0xFF41 + i] = 0x61 + i; }
  for (let i = 0; i < 10; i++) map[0xFF10 + i] = 0x30 + i;
  // Superscript (letters, digits, + − = ( )) — capitals with no superscript
  // form were written as the lowercase one, so those come back lowercase
  var sup = {0x1D43:0x61,0x1D47:0x62,0x1D9C:0x63,0x1D48:0x64,0x1D49:0x65,0x1DA0:0x66,0x1D4D:0x67,0x02B0:0x68,0x2071:0x69,0x02B2:0x6A,0x1D4F:0x6B,0x02E1:0x6C,0x1D50:0x6D,0x207F:0x6E,0x1D52:0x6F,0x1D56:0x70,0x02B3:0x72,0x02E2:0x73,0x1D57:0x74,0x1D58:0x75,0x1D5B:0x76,0x02B7:0x77,0x02E3:0x78,0x02B8:0x79,0x1DBB:0x7A,
    0x1D2C:0x41,0x1D2E:0x42,0x1D30:0x44,0x1D31:0x45,0x1D33:0x47,0x1D34:0x48,0x1D35:0x49,0x1D36:0x4A,0x1D37:0x4B,0x1D38:0x4C,0x1D39:0x4D,0x1D3A:0x4E,0x1D3C:0x4F,0x1D3E:0x50,0x1D3F:0x52,0x1D40:0x54,0x1D41:0x55,0x2C7D:0x56,0x1D42:0x57,
    0x2070:0x30,0x00B9:0x31,0x00B2:0x32,0x00B3:0x33,0x2074:0x34,0x2075:0x35,0x2076:0x36,0x2077:0x37,0x2078:0x38,0x2079:0x39,
    0x207A:0x2B,0x207B:0x2D,0x207C:0x3D,0x207D:0x28,0x207E:0x29};
  for (var k in sup) map[parseInt(k)] = sup[k];
  // Subscript (ᵦ / ᵧ stand in for b / y)
  var sub = {0x2090:0x61,0x2091:0x65,0x2092:0x6F,0x2093:0x78,0x2095:0x68,0x2096:0x6B,0x2097:0x6C,0x2098:0x6D,0x2099:0x6E,0x209A:0x70,0x209B:0x73,0x209C:0x74,
    0x1D62:0x69,0x1D63:0x72,0x1D64:0x75,0x1D65:0x76,0x2C7C:0x6A,0x1D66:0x62,0x1D67:0x79,
    0x208A:0x2B,0x208B:0x2D,0x208C:0x3D,0x208D:0x28,0x208E:0x29};
  for (var k in sub) map[parseInt(k)] = sub[k];
  addDigits(0x2080);
  // Strip combining marks: underline, double underline, strikethrough, enclosing marks
  var combining = new Set([0x0332, 0x0333, 0x0336, 0x0305, 0x20E3, 0x0489, 0xFE0F]);
  var result = [...text].map(function(ch) {
    var cp = ch.codePointAt(0);
    if (combining.has(cp)) return '';
    if (map[cp]) return String.fromCodePoint(map[cp]);
    return ch;
  }).join('');
  if (ctx.selection) ctx.selection = result; else ctx.fullText = result;
}`);

})();
