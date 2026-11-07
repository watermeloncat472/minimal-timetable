/* ═══════════════════════════════════════════════════════════════════════
   极简课表 · Excel / CSV 导入模块  excel-import.js
   ───────────────────────────────────────────────────────────────────────
   设计约束（与「极简课表」产品原则一致）：
     · 零第三方依赖：不引 SheetJS / JSZip，xlsx 直接用自研 ZIP + XML 解析
     · 按需加载：本文件由 app.js 在用户点击「导入」时才动态注入，首屏体积 0 增加
     · 导入前必校对：解析结果一律先进入「导入预览」弹层，可逐条忽略/编辑后再落库
   支持两种课表布局（自动打分识别，识别失败可手动指定）：
     A. 网格表：表头 周一~周日，行首 第N节/时间，格内是课程（教务系统导出样式）
     B. 列表表：一行一门课，列含 课程/星期/节次/教室/教师/周次（顺序任意）
   支持格式：.xlsx（含合并单元格）、.csv、以及直接粘贴的表格文本
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

/* ═══════════════════════ 一、基础工具 ═══════════════════════ */

/* Node 单测兜底：这些值在浏览器里由 app.js 提供同名绑定 */
const FALLBACK_SLOTS = [
  '08:00-08:45', '08:55-09:40', '10:00-10:45', '10:55-11:40',
  '14:00-14:45', '14:55-15:40', '16:00-16:45', '16:55-17:40',
  '19:00-19:45', '19:55-20:40', '20:50-21:35', '21:45-22:30'
];
const FALLBACK_PALETTE = ['#6d8fd6', '#63b59d', '#d9a35e', '#db8a8a', '#9a86cc', '#db93b0', '#56a8a2', '#a3b96b', '#db8f62', '#8591a6'];
function nextId() {
  if (typeof uid === 'function') return uid();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function fallbackSlots() {
  if (typeof DEFAULT_SLOTS !== 'undefined' && DEFAULT_SLOTS && DEFAULT_SLOTS.length) return DEFAULT_SLOTS.slice();
  return FALLBACK_SLOTS.slice();
}
function fallbackPalette() {
  return (typeof PALETTE !== 'undefined' && PALETTE && PALETTE.length) ? PALETTE : FALLBACK_PALETTE;
}

/* 星期 token：浏览器复用 app.js 的 resolveWeekdayToken，Node 里用等价实现 */
const WD_EN_LOCAL = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };
const WD_CN_LOCAL = { '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6 };
function weekdayToken(t) {
  if (typeof resolveWeekdayToken === 'function') return resolveWeekdayToken(t);
  if (!t) return null;
  const raw = String(t).trim().toUpperCase();
  const cn = raw.replace(/^(星期|礼拜|周)/, '');
  if (/^[一二三四五六日天]$/.test(cn)) return WD_CN_LOCAL[cn];
  if (/^[1-7]$/.test(cn)) return +cn - 1;
  const s = raw.replace(/[^A-Z]/g, '');
  if (/^[A-Z]{3,9}$/.test(s)) {
    for (const k in WD_EN_LOCAL) if (s.indexOf(k) === 0) return WD_EN_LOCAL[k];
  }
  return null;
}

/* 中文数字：同样兜底 */
const CN_LOCAL = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
function cnNumber(s) {
  if (typeof cn2num === 'function') return cn2num(s);
  const t = String(s).trim();
  if (/^d+$/.test(t)) return parseInt(t, 10);
  if (CN_LOCAL[t] != null) return CN_LOCAL[t];
  const i = t.indexOf('十');
  if (i >= 0) {
    const a = t.slice(0, i), b = t.slice(i + 1);
    return (a ? CN_LOCAL[a] : 1) * 10 + (b ? CN_LOCAL[b] : 0);
  }
  return null;
}

function decodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(+d); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* "B3" → { col: 1, row: 2 }（0 基） */
function colToIndex(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref == null ? '' : ref).trim());
  if (!m) return null;
  const L = m[1].toUpperCase();
  let n = 0;
  for (let i = 0; i < L.length; i++) n = n * 26 + (L.charCodeAt(i) - 64);
  return { col: n - 1, row: parseInt(m[2], 10) - 1 };
}

/* ═══════════════════════ 二、ZIP 读取（xlsx 本质是 zip） ═══════════════════════ */

/* 原生 deflate 解压可用性（Chrome 80+ / Safari 16.4+；旧安卓 WebView 走纯 JS 回退） */
function hasNativeInflate() {
  return typeof DecompressionStream === 'function'
    && typeof Blob === 'function' && typeof Response === 'function';
}

/* 纯 JS inflate（RFC1951，stored / fixed / dynamic 三种块全支持） */
function tinyInflate(data) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let oLen = 0;
  function ensure(n) {
    if (oLen + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < oLen + n) cap *= 2;
    const nx = new Uint8Array(cap);
    nx.set(out.subarray(0, oLen));
    out = nx;
  }
  function bits(n) {
    while (bitCnt < n) { bitBuf |= data[pos++] << bitCnt; bitCnt += 8; }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n; bitCnt -= n;
    return v;
  }
  function buildHuffman(lengths) {
    let maxLen = 0;
    for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
    const blCount = new Array(maxLen + 1).fill(0);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
    const nextCode = new Array(maxLen + 1).fill(0);
    let code = 0;
    for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
    const map = new Map();
    for (let i = 0; i < lengths.length; i++) {
      const l = lengths[i];
      if (!l) continue;
      map.set(l * 65536 + nextCode[l], i);
      nextCode[l]++;
    }
    return { map: map, maxLen: maxLen };
  }
  function decodeSym(h) {
    let code = 0;
    for (let len = 1; len <= h.maxLen; len++) {
      code = (code << 1) | bits(1);
      const s = h.map.get(len * 65536 + code);
      if (s !== undefined) return s;
    }
    throw new Error('deflate 数据损坏（霍夫曼码无匹配）');
  }
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT  = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT  = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  let lenH = null, distH = null;
  for (;;) {
    const last = bits(1), type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      ensure(len);
      for (let i = 0; i < len; i++) out[oLen++] = data[pos++];
    } else {
      if (type === 1) {
        const ll = new Array(288);
        for (let i = 0; i < 144; i++) ll[i] = 8;
        for (let i = 144; i < 256; i++) ll[i] = 9;
        for (let i = 256; i < 280; i++) ll[i] = 7;
        for (let i = 280; i < 288; i++) ll[i] = 8;
        lenH = buildHuffman(ll);
        distH = buildHuffman(new Array(30).fill(5));
      } else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const clen = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clen[order[i]] = bits(3);
        const clH = buildHuffman(clen);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = decodeSym(clH);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) { const r = bits(2) + 3, p = lens[lens.length - 1]; for (let i = 0; i < r; i++) lens.push(p); }
          else if (sym === 17) { const r = bits(3) + 3; for (let i = 0; i < r; i++) lens.push(0); }
          else { const r = bits(7) + 11; for (let i = 0; i < r; i++) lens.push(0); }
        }
        lenH = buildHuffman(lens.slice(0, hlit));
        distH = buildHuffman(lens.slice(hlit, hlit + hdist));
      } else {
        throw new Error('deflate 数据损坏（未知块类型）');
      }
      for (;;) {
        const sym = decodeSym(lenH);
        if (sym === 256) break;
        if (sym < 256) { ensure(1); out[oLen++] = sym; continue; }
        const li = sym - 257;
        const length = LBASE[li] + bits(LEXT[li]);
        const dsym = decodeSym(distH);
        const dist = DBASE[dsym] + bits(DEXT[dsym]);
        const start = oLen - dist;
        if (start < 0) throw new Error('deflate 数据损坏（回溯越界）');
        ensure(length);
        for (let i = 0; i < length; i++) out[oLen++] = out[start + i];
      }
    }
    if (last) break;
  }
  return out.subarray(0, oLen);
}

async function inflateRaw(bytes) {
  if (hasNativeInflate()) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return tinyInflate(bytes);
}

/* 解析 zip 中央目录，返回 { 文件名: {method, raw} } */
function unzipEntries(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 22 - 65536);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx（未找到 ZIP 结构）');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const files = {};
  for (let i = 0; i < count; i++) {
    if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    if (localOff + 30 <= u8.length && dv.getUint32(localOff, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      files[name] = { method: method, raw: u8.subarray(dataStart, dataStart + compSize) };
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

async function readEntry(files, name) {
  const f = files[name];
  if (!f) return null;
  return f.method === 0 ? f.raw : await inflateRaw(f.raw);
}
const utf8 = new TextDecoder('utf-8');

/* ═══════════════════════ 三、xlsx → 二维表 ═══════════════════════ */

/* 取 <si>/<is> 内的全部 <t>（跳过注音 <rPh>），保留单元格内换行 */
function extractText(xml) {
  const clean = String(xml == null ? '' : xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(clean))) out += decodeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] == null ? '' : extractText(m[1]));
  return out;
}

function findRelationship(relsXml, id) {
  const re = /<Relationship\b[^>]*>/g;
  let m;
  while ((m = re.exec(relsXml))) {
    const tag = m[0];
    const idm = /\bId="([^"]+)"/.exec(tag);
    if (idm && idm[1] === id) {
      const t = /Target="([^"]+)"/.exec(tag);
      if (t) return t[1];
    }
  }
  return null;
}

/* 解析 sheet XML → 二维字符串数组（合并单元格已铺满） */
function parseSheet(xml, shared) {
  const cells = Object.create(null);
  let maxR = -1, maxC = -1;
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm, autoRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = /\br="(\d+)"/.exec(rm[1]);
    const r = rAttr ? parseInt(rAttr[1], 10) - 1 : autoRow;
    autoRow = r + 1;
    const inner = rm[2];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoCol = 0;
    while ((cm = cRe.exec(inner))) {
      const cAttrs = cm[1] || '';
      const body = cm[2] || '';
      const refM = /\br="([A-Za-z]+\d+)"/.exec(cAttrs);
      let cc;
      if (refM) { const p = colToIndex(refM[1]); cc = p ? p.col : autoCol; }
      else cc = autoCol;
      autoCol = cc + 1;
      const tM = /\bt="([^"]+)"/.exec(cAttrs);
      const type = tM ? tM[1] : 'n';
      let val = '';
      if (type === 'inlineStr') {
        const isM = /<is>([\s\S]*?)<\/is>/.exec(body);
        val = isM ? extractText(isM[1]) : extractText(body);
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (vM) {
          val = decodeXml(vM[1]);
          if (type === 's') {
            const si = parseInt(val, 10);
            val = shared[si] != null ? shared[si] : '';
          }
        } else {
          const isM = /<is>([\s\S]*?)<\/is>/.exec(body);
          if (isM) val = extractText(isM[1]);
        }
      }
      if (val !== '' && val != null) cells[r + ',' + cc] = val;
      if (r > maxR) maxR = r;
      if (cc > maxC) maxC = cc;
    }
  }
  /* 合并单元格：把左上角的值铺满整个区域（课表 Excel 大量使用合并） */
  const mRe = /<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/?>/g;
  let mm;
  while ((mm = mRe.exec(xml))) {
    const parts = mm[1].split(':');
    if (parts.length !== 2) continue;
    const pa = colToIndex(parts[0]), pb = colToIndex(parts[1]);
    if (!pa || !pb) continue;
    const v = cells[pa.row + ',' + pa.col];
    if (v == null) continue;
    for (let r = pa.row; r <= pb.row; r++) {
      for (let c = pa.col; c <= pb.col; c++) cells[r + ',' + c] = v;
    }
    if (pb.row > maxR) maxR = pb.row;
    if (pb.col > maxC) maxC = pb.col;
  }
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) {
      const v = cells[r + ',' + c];
      row.push(v == null ? '' : v);
    }
    rows.push(row);
  }
  return rows;
}

async function xlsxToRows(buf) {
  const files = unzipEntries(buf);
  let shared = [];
  if (files['xl/sharedStrings.xml']) {
    shared = parseSharedStrings(utf8.decode(await readEntry(files, 'xl/sharedStrings.xml')));
  }
  let sheetPath = files['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml' : null;
  if (files['xl/workbook.xml'] && files['xl/_rels/workbook.xml.rels']) {
    const wb = utf8.decode(await readEntry(files, 'xl/workbook.xml'));
    const sid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb);
    if (sid) {
      const rels = utf8.decode(await readEntry(files, 'xl/_rels/workbook.xml.rels'));
      const target = findRelationship(rels, sid[1]);
      if (target) {
        let p = target.replace(/^\//, '');
        if (p.indexOf('xl/') !== 0) p = 'xl/' + p;
        if (files[p]) sheetPath = p;
      }
    }
  }
  if (!sheetPath) {
    const keys = Object.keys(files).filter(function (k) { return /^xl\/worksheets\/.*\.xml$/.test(k); });
    sheetPath = keys[0] || null;
  }
  if (!sheetPath) throw new Error('xlsx 里没有找到工作表');
  return parseSheet(utf8.decode(await readEntry(files, sheetPath)), shared);
}

/* ═══════════════════════ 四、CSV / 粘贴文本 → 二维表 ═══════════════════════ */

function detectDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 6).join('\n');
  const cand = [['\t', (head.match(/\t/g) || []).length], [',', (head.match(/,/g) || []).length], [';', (head.match(/;/g) || []).length]];
  cand.sort(function (a, b) { return b[1] - a[1]; });
  return cand[0][1] > 0 ? cand[0][0] : ',';
}

function parseCsv(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const delim = detectDelimiter(src);
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ═══════════════════════ 五、字段解析 ═══════════════════════ */

const WEEK_RE = /((?:\d{1,2}\s*[-~－—至]\s*\d{1,2}|\d{1,2})(?:\s*[,，、]\s*(?:\d{1,2}\s*[-~－—至]\s*\d{1,2}|\d{1,2}))*)\s*周/;
const ROOM_TOKEN = /^[A-Za-z]{0,4}\s*[-－]?\s*\d{1,4}(?:\s*[-－]\s*[A-Za-z]?\d{1,4})?$/;
const ROOM_HINT = /(教室|机房|实验室|实验楼|体育馆|报告厅|礼堂|操场|图书馆|教学楼|大楼|楼|馆|室|场|区|中心|阶|机房|机室)/;
const TEACHER_HINT = /(老师|教师|教授|讲师|助教|导员|先生)/;
const CN_NAME = /^[\u4e00-\u9fa5·]{2,6}$/;
/* 教务系统常在单元格里写「教师：张三」这样的字段标签，先剥掉 */
const LABEL_RE = /^\s*(课程名称|课程名|课程|科目|任课教师|授课教师|上课教师|教师|老师|上课地点|上课教室|授课地点|教室|地点|场地|周次|上课周次|教学周|周数|备注|说明|上课时间|时间|节次)\s*[:：]?\s*/;
/* 明显不是人名的词尾，避免把「必修课」「理论」这类当成老师 */
const NOT_PERSON_TAIL = /(课|论|学|习|试|验|组|类|型|周|节|楼|室|馆|场|区|院|系|班|部|处|次|节|目|程)$/;

/* 周次："1-16周" / "1,3,5周" / "单周" / "双周" → {mode,list} */
function parseWeeks(text) {
  const s = String(text == null ? '' : text);
  if (/单周/.test(s)) return { mode: 'odd', list: [] };
  if (/双周/.test(s)) return { mode: 'even', list: [] };
  const m = WEEK_RE.exec(s);
  if (!m) return null;
  const list = [];
  m[1].split(/[,，、]/).forEach(function (part) {
    const r = part.split(/[-~－—至]/).map(function (x) { return parseInt(String(x).trim(), 10); })
      .filter(function (n) { return !isNaN(n); });
    if (r.length >= 2) { for (let i = r[0]; i <= r[1]; i++) list.push(i); }
    else if (r.length === 1) list.push(r[0]);
  });
  const uniq = Array.from(new Set(list)).filter(function (n) { return n >= 1 && n <= 30; }).sort(function (a, b) { return a - b; });
  return uniq.length ? { mode: 'custom', list: uniq } : null;
}

/* ── 教务系统「/」定长字段格式 ──────────────────────────────
   课程名/(节次)周次/校区 地点/教师/教学班/教学班组成/选课人数/选课备注
   例：数据结构/(1-2节)1-16周/校本部 实验实训楼北309(计算机综合实验室29)/龙涛/数据结构-0005/计科2502/57/
   同一个格子里可能塞多门课（用换行分隔），由调用方先按换行拆段。 */
const CAMPUS_RE = /^(校本部|.*?校区|.*?分校|.*?学区)$/;

/* 只认带「节」字的时间段，避免把「5-8周」误当节次 */
function parseSlotWithJie(t) {
  const m = /第?\s*(\d{1,2})\s*[-~－—至]\s*(\d{1,2})\s*节/.exec(String(t || ''));
  if (m) return { startSlot: +m[1], endSlot: +m[2] };
  const s = /第?\s*(\d{1,2})\s*节/.exec(String(t || ''));
  if (s) return { startSlot: +s[1], endSlot: +s[1] };
  return null;
}
/* "校本部 七教501" → "七教501"（应用自 v1.14 起没有校区字段了） */
function splitCampusAndRoom(loc) {
  const s = String(loc || '').trim();
  if (!s) return '';
  const sp = s.split(/\s+/);
  if (sp.length >= 2 && CAMPUS_RE.test(sp[0])) return sp.slice(1).join(' ').trim();
  return s;
}
/* "实验实训楼北309(计算机综合实验室29)" → "实验实训楼北309"（括号里的实验室名放详情里也没用） */
function trimRoomTail(s) {
  const raw = String(s || '').trim();
  const t = raw.replace(/[(（][^)）]*[)）]\s*$/, '').trim();
  return t || raw;
}

function parseSlashCell(raw) {
  const parts = String(raw || '').split('/').map(function (s) { return s.trim(); });
  if (parts.length < 3) return null;
  const info = parts[1] || '';
  /* 第 2 段必须像「(1-2节)5-8周」，否则不是这个格式（比如「实践课程：xxx/15-16周」） */
  if (!/\d/.test(info) || !/(周|节)/.test(info)) return null;
  const name = parts[0].replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40 || name.indexOf('：') >= 0) return null;
  return {
    name: name,
    room: trimRoomTail(splitCampusAndRoom(parts[2] || '')),
    teacher: (parts[3] || '').trim(),
    weeks: parseWeeks(info),
    slot: parseSlotWithJie(info),
    note: (parts[7] || '').trim()
  };
}

/* 去掉字段标签；纯标签返回空串 */
function stripLabel(t) {
  let s = String(t == null ? '' : t).trim();
  for (let i = 0; i < 3; i++) {
    const m = LABEL_RE.exec(s);
    if (!m) break;
    const rest = s.slice(m[0].length).trim();
    if (!rest) return '';
    s = rest;
  }
  return s;
}
function isRoomToken(t) {
  if (!t || t.length > 16) return false;
  if (ROOM_TOKEN.test(t)) return true;
  return ROOM_HINT.test(t);
}
function looksLikePerson(t) {
  if (!t || t.length < 2 || t.length > 6) return false;
  if (/\d/.test(t)) return false;
  if (ROOM_HINT.test(t)) return false;
  if (NOT_PERSON_TAIL.test(t)) return false;
  return /^[\u4e00-\u9fa5·]+$/.test(t);
}

/* 一个格子的文本 → {name, room, teacher, weeks, note} */
function parseCourseCell(text) {
  const raw = String(text == null ? '' : text).replace(/\r/g, '').replace(/\u3000/g, ' ').trim();

  /* 教务系统的「/」定长字段格式优先 */
  const slash = parseSlashCell(raw);
  if (slash) return slash;

  const weeks = parseWeeks(raw);
  const body = raw.replace(new RegExp(WEEK_RE.source, 'g'), ' ').replace(/[(（]?\s*(单周|双周)\s*[)）]?/g, ' ');
  /* 按换行/空格切分，并剥掉「教师：」这类字段标签 */
  const tokens = body.split(/[\s\n]+/).map(stripLabel).filter(Boolean);

  let teacher = '', room = '';
  const rest = [];
  tokens.forEach(function (t) {
    if (!teacher && TEACHER_HINT.test(t) && t.length <= 14) { teacher = t; return; }
    if (!room && isRoomToken(t)) { room = t; return; }
    rest.push(t);
  });
  let name = rest.shift() || tokens[0] || raw.trim();
  const extras = rest.slice();

  /* "高等数学A-101" 这种名称与教室粘连的情况 */
  if (!room) {
    const m = /^(.*[^\x00-\x7F])\s*([A-Za-z]{1,4}[-－]?\d{2,4})$/.exec(name);
    if (m) { name = m[1].trim(); room = m[2].trim(); }
  }
  /* 教师兜底：短中文人名（张三 / 欧阳修），排除课/论/楼 之类的词尾 */
  if (!teacher) {
    for (let i = 0; i < extras.length; i++) {
      if (looksLikePerson(extras[i])) { teacher = extras.splice(i, 1)[0]; break; }
    }
  }
  /* 教室兜底：带数字的短串最可能就是教室（逸夫楼302 / 教三201 / A101） */
  if (!room) {
    for (let i = 0; i < extras.length; i++) {
      if (/\d/.test(extras[i]) && extras[i].length <= 18) { room = extras.splice(i, 1)[0]; break; }
    }
  }
  if (!room) {
    for (let i = 0; i < extras.length; i++) {
      if (ROOM_TOKEN.test(extras[i])) { room = extras.splice(i, 1)[0]; break; }
    }
  }
  return {
    name: name.trim(), room: room.trim(), teacher: teacher.trim(),
    weeks: weeks, slot: parseSlotWithJie(raw), note: extras.join(' ').trim()
  };
}

/* "第1-2节" / "1,2节" / "08:00-09:40" → 节次区间 */
function parseSlotField(s, slotTimes) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  /* 前置字符不能是数字或冒号，避免把 "08:00-09:40" 里的 "00-09" 当成节次 */
  const range = /(?:^|[^\d:])\s*第?\s*(\d{1,2})\s*[-~－—至]\s*(\d{1,2})\s*节?/.exec(t);
  if (range) return { startSlot: +range[1], endSlot: +range[2] };
  const single = /第?\s*(\d{1,2})\s*节/.exec(t);
  if (single) return { startSlot: +single[1], endSlot: +single[1] };
  const times = t.match(/(\d{1,2}):(\d{2})/g);
  if (times && times.length && slotTimes && slotTimes.length) {
    const a = nearestSlot(toMin_(times[0]), slotTimes, false);
    const b = times[1] ? nearestSlot(toMin_(times[1]), slotTimes, true) : a;
    if (a) return { startSlot: Math.min(a, b || a), endSlot: Math.max(a, b || a) };
  }
  const bare = /^\s*(\d{1,2})\s*$/.exec(t);
  if (bare && +bare[1] >= 1 && +bare[1] <= 30) return { startSlot: +bare[1], endSlot: +bare[1] };
  return null;
}
function toMin_(hhmm) {
  const p = String(hhmm).split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}
/* useEnd=true 时按“结束时间”匹配，否则按“开始时间”匹配 */
function nearestSlot(minutes, slotTimes, useEnd) {
  let bi = -1, bd = 1e9;
  slotTimes.forEach(function (s, i) {
    const parts = String(s || '00:00-00:00').split('-');
    const st = toMin_(useEnd ? (parts[1] || parts[0]) : parts[0]);
    const d = Math.abs(st - minutes);
    if (d < bd) { bd = d; bi = i; }
  });
  return (bi >= 0 && bd <= 60) ? bi + 1 : null;
}

/* 行首单元格 → 节次号 */
function rowSlot(cells, slotTimes) {
  /* 「上午/一、下午/三」这种大节写法：一→1 二→3 三→5 四→7 五→9 六→11（每大节两小节） */
  const c0 = String(cells[0] == null ? '' : cells[0]).trim();
  if (/^(上午|下午|晚上)$/.test(c0)) {
    const n = cnNumber(String(cells[1] == null ? '' : cells[1]).trim());
    if (n >= 1 && n <= 6) return n * 2 - 1;
  }
  const head = cells.slice(0, 3).map(function (s) { return String(s || ''); }).join(' ').trim();
  if (!head) return null;
  const nm = /第?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*节/.exec(head);
  if (nm) { const n = cnNumber(nm[1]); if (n >= 1) return n; }
  const tm = /(\d{1,2}):(\d{2})/.exec(head);
  if (tm) return nearestSlot(+tm[1] * 60 + +tm[2], slotTimes);
  const bare = /^\s*(\d{1,2})\s*$/.exec(head);
  if (bare && +bare[1] >= 1 && +bare[1] <= 30) return +bare[1];
  return null;
}

/* ═══════════════════════ 六、两种布局识别器 ═══════════════════════ */

/* A. 网格表：找出星期表头行 */
function detectGrid(rows) {
  let best = null;
  /* 教务系统导出的表头前面常有很厚的标题栏/学生信息栏，搜到 30 行 */
  const limit = Math.min(rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] || [];
    const cols = {}; let hits = 0;
    for (let c = 0; c < row.length; c++) {
      const wd = weekdayToken(row[c]);
      if (wd != null) { cols[c] = wd; hits++; }
    }
    if (hits >= 3 && (!best || hits > best.hits)) best = { headerRow: r, cols: cols, hits: hits };
  }
  return best;
}

function normCellText(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim(); }

/* 一个单元格里到底是一门课还是多门课？
   教务系统的「/」格式用换行分隔多门课；而普通写法里换行是「课程名 / 教师 / 教室」的分行。
   判据：每一行都能按「/」格式解析出来 → 多门课；否则整格算一门课。 */
function splitCellSegments(text) {
  const src = String(text == null ? '' : text).trim();
  const lines = src.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (lines.length <= 1) return [src];
  let all = true;
  for (let i = 0; i < lines.length; i++) { if (!parseSlashCell(lines[i])) { all = false; break; } }
  return all ? lines : [lines.join('\n')];
}

function gridToCourses(rows, grid, meta) {
  const items = [];
  Object.keys(grid.cols).map(Number).forEach(function (c) {
    const wd = grid.cols[c];
    /* 1) 收集本列所有有内容的单元格，同时记下该行左侧声明的节次 */
    const cells = [];
    for (let r = grid.headerRow + 1; r < rows.length; r++) {
      const line = rows[r] || [];
      const raw = String(line[c] == null ? '' : line[c]).trim();
      if (!raw) continue;
      cells.push({ row: r, rowSlot: rowSlot(line, meta.slotTimes), text: raw });
    }
    /* 2) 上下相邻且文本完全相同的，视为跨行合并（连堂），合成一段 */
    const spans = [];
    let i = 0;
    while (i < cells.length) {
      let j = i;
      while (j + 1 < cells.length
        && cells[j + 1].row === cells[j].row + 1
        && normCellText(cells[j + 1].text) === normCellText(cells[i].text)) j++;
      spans.push({ text: cells[i].text, row: cells[i].row, s: cells[i].rowSlot, e: cells[j].rowSlot });
      i = j + 1;
    }
    /* 3) 一格可能塞多门课（换行分隔），逐段解析 */
    spans.forEach(function (sp) {
      splitCellSegments(sp.text).forEach(function (seg) {
        const parsed = parseCourseCell(seg);
        if (!parsed.name) return;
        /* 格子自带节次时以它为准（教务系统左侧一~六只是大节序号，真实节次写在格子里） */
        let s = parsed.slot ? parsed.slot.startSlot : sp.s;
        let e = parsed.slot ? parsed.slot.endSlot : sp.e;
        if (s == null) return;                    /* 连节次都认不出的行：标题行 / 实践课行 / 备注行 */
        if (e == null || e < s) e = s;
        delete parsed.slot;
        parsed.weekday = wd;
        parsed.startSlot = s;
        parsed.endSlot = e;
        parsed.srcRow = sp.row + 1;
        items.push(parsed);
      });
    });
  });
  return items;
}

/* B. 列表表：找出表头行与各字段所在列 */
const HEADER_FIELDS = [
  ['weeks', /^(上课)?(周次|周数|起止周|教学周|周次范围)$/],
  ['weekday', /^(星期|周几|星期几|上课星期|上课日)$/],
  ['slot', /^(节次|节数|上课节次|节次范围|时间|上课时间|时段|节)$/],
  ['room', /^(教室|上课地点|地点|场地|教室名称|上课教室)$/],
  ['teacher', /^(教师|老师|授课教师|任课教师|教师姓名|授课老师)$/],
  ['name', /^(课程名称|课程名|课程|科目|教学班名称|名称|课名)$/],
  ['note', /^(备注|说明|课程性质|性质|类型)$/]
];

function detectList(rows) {
  let best = null;
  const limit = Math.min(rows.length, 15);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] || [];
    const map = {}; let score = 0;
    for (let c = 0; c < row.length; c++) {
      const t = String(row[c] == null ? '' : row[c]).replace(/[\s（(].*$/, '').trim();
      if (!t) continue;
      for (let k = 0; k < HEADER_FIELDS.length; k++) {
        const key = HEADER_FIELDS[k][0], re = HEADER_FIELDS[k][1];
        if (map[key] == null && re.test(t)) { map[key] = c; score++; break; }
      }
    }
    if (map.name != null && score >= 3 && (!best || score > best.score)) best = { headerRow: r, map: map, score: score };
  }
  return best;
}

function listToCourses(rows, list, meta) {
  const items = [];
  for (let r = list.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    function get(k) {
      const c = list.map[k];
      return c == null ? '' : String(row[c] == null ? '' : row[c]).trim();
    }
    const name = get('name');
    if (!name) continue;
    const flat = name.replace(/\s/g, '');
    let isHeader = false;
    HEADER_FIELDS.forEach(function (f) { if (f[1].test(flat)) isHeader = true; });
    if (isHeader) continue;
    const wd = weekdayToken(get('weekday'));
    if (wd == null) continue;
    const sl = parseSlotField(get('slot'), meta.slotTimes);
    if (!sl) continue;
    items.push({
      name: name.replace(/\s+/g, ' ').trim(),
      room: get('room'), teacher: get('teacher'),
      weeks: parseWeeks(get('weeks') || '') || null,
      note: get('note'),
      weekday: wd, startSlot: sl.startSlot, endSlot: sl.endSlot, srcRow: r + 1
    });
  }
  return items;
}

/* ═══════════════════════ 七、归一化 / 去重 / 冲突 ═══════════════════════ */

function weeksKey(w) {
  if (!w || !w.mode || w.mode === 'all') return 'all';
  if (w.mode === 'custom') return 'c' + (w.list || []).join('.');
  return w.mode;
}

function weeksOverlap(a, b) {
  const A = a || { mode: 'all' }, B = b || { mode: 'all' };
  function setOf(w) {
    if (w.mode === 'all') return null;
    if (w.mode === 'custom') return new Set(w.list || []);
    const s = new Set();
    for (let i = 1; i <= 30; i++) if (w.mode === 'odd' ? i % 2 === 1 : i % 2 === 0) s.add(i);
    return s;
  }
  const sa = setOf(A), sb = setOf(B);
  if (!sa || !sb) return true;
  for (const v of sa) if (sb.has(v)) return true;
  return false;
}

function hashIndex(str, n) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % n;
}

/* 把原始识别结果归一化成课程对象，并标注需人工确认的问题 */
function normalizeItems(items, meta, palette) {
  const total = (meta.slotTimes || []).length || 12;
  const colors = palette && palette.length ? palette : ['#6d8fd6'];
  const out = [];
  items.forEach(function (it) {
    if (!it.name || it.weekday == null) return;
    let s = Math.max(1, Math.min(total, +it.startSlot || 1));
    let e = Math.max(1, Math.min(total, +it.endSlot || s));
    if (e < s) { const t = s; s = e; e = t; }
    let weeks = it.weeks;
    const issues = [];
    if (!weeks) { weeks = { mode: 'all', list: [] }; issues.push('周次未识别·按每周'); }
    else if (weeks.mode === 'custom' && weeks.list.length >= (meta.totalWeeks || 20)) weeks = { mode: 'all', list: [] };
    if (!it.room) issues.push('缺教室');
    out.push({
      id: nextId(),
      name: it.name, room: it.room || '', teacher: it.teacher || '', note: it.note || '',
      weekday: it.weekday, startSlot: s, endSlot: e, weeks: weeks,
      color: colors[hashIndex(it.name, colors.length)],
      _srcRow: it.srcRow, _issues: issues, _skip: false
    });
  });
  /* 同一门课被拆成多个周次片段 → 合并，周次取并集 */
  const merged = [];
  const index = Object.create(null);
  out.forEach(function (c) {
    const k = [c.name, c.weekday, c.startSlot, c.endSlot, c.room, c.teacher].join('|');
    const hit = index[k];
    if (!hit) { index[k] = c; merged.push(c); return; }
    if (hit.weeks.mode === 'all' || c.weeks.mode === 'all') { hit.weeks = { mode: 'all', list: [] }; return; }
    if (hit.weeks.mode === 'custom' && c.weeks.mode === 'custom') {
      hit.weeks = { mode: 'custom', list: Array.from(new Set(hit.weeks.list.concat(c.weeks.list))).sort(function (a, b) { return a - b; }) };
    } else if (weeksKey(hit.weeks) !== weeksKey(c.weeks)) {
      hit._issues.push('周次不一致·保留首个');
    }
  });
  /* 同一门课按周次分段、但两段周次重叠（如「1-8周」与「8-10周」都含第8周）：标为待确认 */
  const bySlot = Object.create(null);
  merged.forEach(function (c) {
    const k = [c.name, c.weekday, c.startSlot, c.endSlot].join('|');
    (bySlot[k] = bySlot[k] || []).push(c);
  });
  Object.keys(bySlot).forEach(function (k) {
    const arr = bySlot[k];
    if (arr.length < 2) return;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (!weeksOverlap(arr[i].weeks, arr[j].weeks)) continue;
        if (arr[i]._issues.indexOf('与同课另一时段周次重叠') < 0) arr[i]._issues.push('与同课另一时段周次重叠');
        if (arr[j]._issues.indexOf('与同课另一时段周次重叠') < 0) arr[j]._issues.push('与同课另一时段周次重叠');
      }
    }
  });
  return merged;
}

/* 与现有课表冲突检测（同星期 + 节次相交 + 周次相交 + 不是同一门课） */
function detectConflicts(courses, existing) {
  courses.forEach(function (c) {
    c._conflict = (existing || []).some(function (x) {
      if (x.weekday !== c.weekday) return false;
      if (x.startSlot > c.endSlot || c.startSlot > x.endSlot) return false;
      if (x.name === c.name) return false;
      return weeksOverlap(x.weeks, c.weeks);
    });
  });
  return courses;
}

function existingKey(c) { return [c.name, c.weekday, c.startSlot, c.endSlot, c.room].join('|'); }

/* ── 与现有课表的差异比对 ─────────────────────────────
   同一门课的判定用「课程名 + 星期 + 节次」做身份（换教室/换老师/换周次算同一门课的变更） */
function slotKey(c) { return [c.name, c.weekday, c.startSlot, c.endSlot].join('|'); }
function sameCourse(a, b) {
  return (a.room || '') === (b.room || '')
    && (a.teacher || '') === (b.teacher || '')
    && (a.note || '') === (b.note || '')
    && weeksKey(a.weeks) === weeksKey(b.weeks);
}
function fieldText(c) {
  return (c.room ? c.room : '无教室') + (c.teacher ? ' · ' + c.teacher : '') + ' · ' + weeksLabel(c.weeks)
    + (c.note ? ' · ' + c.note : '');
}
function whenText(c) {
  return weekdayLabel(c.weekday) + ' 第' + c.startSlot + (c.endSlot > c.startSlot ? '-' + c.endSlot : '') + '节';
}
/* 返回 { added:[导入独有], changed:[{from,to}], removed:[现有独有], same:[完全一致] } */
function buildDiff(imported, existing) {
  const ex = (existing || []).slice();
  const matched = [];
  const added = [], same = [], changed = [];
  imported.forEach(function (c) {
    const k = slotKey(c);
    let hit = null;
    for (let i = 0; i < ex.length; i++) {
      if (matched.indexOf(ex[i]) >= 0) continue;
      if (slotKey(ex[i]) === k) { hit = ex[i]; break; }
    }
    if (!hit) { added.push(c); return; }
    matched.push(hit);
    if (sameCourse(hit, c)) same.push(c);
    else changed.push({ from: hit, to: c });
  });
  const removed = ex.filter(function (c) { return matched.indexOf(c) < 0; });
  return { added: added, changed: changed, removed: removed, same: same };
}

/* ═══════════════════════ 八、总入口：二维表 → 课程 ═══════════════════════ */

function makeMeta() {
  const m = (typeof state !== 'undefined' && state && state.meta) ? state.meta : null;
  return {
    slotTimes: (m && Array.isArray(m.slotTimes) && m.slotTimes.length) ? m.slotTimes.slice() : fallbackSlots(),
    totalWeeks: (m && m.totalWeeks) || 20
  };
}

/* 从表格里找学期信息：开学日期 + 总周数（很多教务系统在页脚注明） */
function pads2(n) { return (n < 10 ? '0' : '') + n; }
function detectSemester(rows) {
  const re = /(\d{4})\s*[-年.\/]\s*(\d{1,2})\s*[-月.\/]\s*(\d{1,2})\s*日?[\s\S]{0,40}?共\s*(\d{1,3})\s*周/;
  for (let i = 0; i < rows.length; i++) {
    const line = (rows[i] || []).join(' ');
    const m = re.exec(line);
    if (!m) continue;
    const y = +m[1], mo = +m[2], d = +m[3], w = +m[4];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || w < 4 || w > 30) continue;
    return { start: y + '-' + pads2(mo) + '-' + pads2(d), weeks: w };
  }
  return null;
}

function parseTable(rows, force) {
  const meta = makeMeta();
  const grid = force === 'list' ? null : detectGrid(rows);
  const list = force === 'grid' ? null : detectList(rows);
  let courses = [], format = '';
  if (grid && list && !force) {
    const g = gridToCourses(rows, grid, meta);
    const l = listToCourses(rows, list, meta);
    if (l.length > g.length) { courses = l; format = 'list'; }
    else { courses = g; format = 'grid'; }
  } else if (grid) {
    courses = gridToCourses(rows, grid, meta);
    format = 'grid';
  } else if (list) {
    courses = listToCourses(rows, list, meta);
    format = 'list';
  }
  const normalized = normalizeItems(courses, meta, fallbackPalette());
  detectConflicts(normalized, (typeof state !== 'undefined' && state) ? state.courses : []);
  return { format: format, courses: normalized, rows: rows.length, meta: meta, semester: detectSemester(rows) };
}

/* ═══════════════════════ 九、UI：导入预览 / 编辑 / 落库 ═══════════════════════ */

let pending = [];
let lastSnapshot = null;
/* 识别诊断用：最近一次解析到的原始二维表与判定结果 */
let lastRows = null, lastKind = '', lastFormat = '', pendingSemester = null;

function diagText() {
  const rows = lastRows || [];
  let cols = 0;
  rows.forEach(function (r) { if (r && r.length > cols) cols = r.length; });
  const out = [];
  out.push('文件真实格式: ' + (lastKind || '未记录'));
  out.push('识别布局: ' + (lastFormat || '未识别'));
  out.push('表格尺寸: ' + rows.length + ' 行 × ' + cols + ' 列');
  out.push('—— 前 25 行原始内容 ——');
  rows.slice(0, 25).forEach(function (r, i) {
    out.push(String(i + 1) + '| ' + (r || []).map(function (c) {
      return String(c == null ? '' : c).split(String.fromCharCode(10)).join('⏎').slice(0, 22);
    }).join(' | '));
  });
  return out.join(String.fromCharCode(10));
}

function weekdayLabel(wd) { return (typeof WEEKDAYS !== 'undefined' ? WEEKDAYS[wd] : '') || ('周' + (wd + 1)); }
function weeksLabel(w) {
  if (!w || !w.mode || w.mode === 'all') return '每周';
  if (w.mode === 'odd') return '单周';
  if (w.mode === 'even') return '双周';
  const l = (w.list || []).slice().sort(function (a, b) { return a - b; });
  if (!l.length) return '每周';
  /* 连续周次压缩成区间：1,2,3,4,7,8 → 第1-4、7-8周 */
  const parts = [];
  let s = l[0], p = l[0];
  for (let i = 1; i <= l.length; i++) {
    if (i < l.length && l[i] === p + 1) { p = l[i]; continue; }
    parts.push(s === p ? String(s) : (s + '-' + p));
    if (i < l.length) { s = p = l[i]; }
  }
  return '第' + parts.join('、') + '周';
}

function renderReview() {
  const alive = pending.filter(function (c) { return !c._skip; });
  const conflicts = alive.filter(function (c) { return c._conflict; }).length;
  const issues = alive.filter(function (c) { return c._issues && c._issues.length; }).length;

  const head = '识别到 <b>' + alive.length + '</b> 门课程'
    + (conflicts ? ' · <span class="imp-badge conflict">' + conflicts + ' 条与现有课表冲突</span>' : '')
    + (issues ? ' · <span class="imp-badge warn">' + issues + ' 条待确认</span>' : '');

  /* 与现有课表逐条比对 */
  const existing = (typeof state !== 'undefined' && state && state.courses) ? state.courses : [];
  const diff = buildDiff(alive, existing);
  const diffCount = diff.added.length + diff.changed.length + diff.removed.length;
  let diffHtml = '';
  if (existing.length || diffCount) {
    const rows = [];
    diff.changed.forEach(function (p) {
      rows.push('<div class="imp-drow chg"><span class="imp-dtag">变更</span>' + esc(p.to.name) + ' · ' + esc(whenText(p.to))
        + '<div class="imp-dold">原有：' + esc(fieldText(p.from)) + '</div>'
        + '<div class="imp-dnew">导入：' + esc(fieldText(p.to)) + '</div></div>');
    });
    diff.removed.forEach(function (c) {
      rows.push('<div class="imp-drow del"><span class="imp-dtag">会删除</span>' + esc(c.name) + ' · ' + esc(whenText(c)) + ' · ' + esc(fieldText(c)) + '</div>');
    });
    diff.added.forEach(function (c) {
      rows.push('<div class="imp-drow add"><span class="imp-dtag">新增</span>' + esc(c.name) + ' · ' + esc(whenText(c)) + ' · ' + esc(fieldText(c)) + '</div>');
    });
    diffHtml = '<div class="imp-diff">'
      + '<div class="imp-diff-head"><span class="imp-diff-title">与现有课表的差异</span>'
      + (diff.added.length ? '<span class="imp-badge add">新增 ' + diff.added.length + '</span>' : '')
      + (diff.changed.length ? '<span class="imp-badge chg">变更 ' + diff.changed.length + '</span>' : '')
      + (diff.removed.length ? '<span class="imp-badge del">会删除 ' + diff.removed.length + '</span>' : '')
      + (diff.same.length ? '<span class="imp-badge same">相同 ' + diff.same.length + '</span>' : '')
      + (!diffCount ? '<span class="imp-badge same">与现有课表没有差异</span>' : '')
      + '</div>'
      + (diffCount
          ? '<button type="button" class="imp-diag-toggle" id="imp-diff-toggle"><span>逐条查看 ' + diffCount + ' 处不同</span><i class="collapse-arrow">▾</i></button>'
            + '<div class="imp-diff-list" id="imp-diff-list" style="display:none">' + rows.join('') + '</div>'
          : '')
      + '</div>';
  }

  const rowsHtml = pending.map(function (c, i) {
    const cls = ['imp-row'];
    if (c._skip) cls.push('skipped');
    if (c._conflict) cls.push('conflict');
    const meta = weekdayLabel(c.weekday) + ' 第' + c.startSlot + (c.endSlot > c.startSlot ? '-' + c.endSlot : '') + '节'
      + (c.room ? ' · ' + esc(c.room) : '') + (c.teacher ? ' · ' + esc(c.teacher) : '')
      + ' · ' + weeksLabel(c.weeks);
    const badges = [];
    if (c._conflict) badges.push('<span class="imp-badge conflict">冲突</span>');
    (c._issues || []).forEach(function (s) { badges.push('<span class="imp-badge warn">' + esc(s) + '</span>'); });
    return '<div class="' + cls.join(' ') + '" data-i="' + i + '">'
      + '<span class="imp-dot" style="background:' + esc(c.color) + '"></span>'
      + '<div class="imp-main"><div class="imp-name">' + esc(c.name) + '</div>'
      + '<div class="imp-meta">' + meta + '</div>'
      + (badges.length ? '<div class="imp-badges">' + badges.join('') + '</div>' : '')
      + '</div>'
      + '<button type="button" class="mini-btn imp-edit" data-i="' + i + '">编辑</button>'
      + '<label class="imp-skip"><input type="checkbox" data-i="' + i + '"' + (c._skip ? ' checked' : '') + '><span>忽略</span></label>'
      + '</div>';
  }).join('');

  openModal('<div class="modal-head"><h3>导入预览</h3><button class="modal-close" id="m-close">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="imp-summary">' + head + '</div>'
    + diffHtml
    + (pendingSemester
        ? '<label class="imp-sem"><input type="checkbox" id="imp-sem" checked>'
          + '<span>同时设置学期：<b>' + esc(pendingSemester.start) + '</b> 开学 · 共 <b>' + pendingSemester.weeks + '</b> 周</span></label>'
        : '')
    + (pending.length ? '<div class="imp-list">' + rowsHtml + '</div>' : '<div class="empty-state">没有解析出任何课程</div>')
    + '<div class="imp-diag">'
    + '<button type="button" class="imp-diag-toggle" id="imp-diag-toggle">'
    + '<span>识别结果不对？点这里查看原始表格（' + ((lastRows || []).length) + ' 行）</span><i class="collapse-arrow">▾</i></button>'
    + '<pre class="imp-diag-pre" id="imp-diag-pre" style="display:none"></pre>'
    + '</div>'
    + '<div class="note">「保留原有」＝现有课表不动，只把新增的补进去；「覆盖导入」＝用这份课表整体替换（差异里标了哪些会被删除）。两者都会先自动备份，可在提示里撤销。</div>'
    + '</div>'
    + '<div class="modal-foot">'
    + '<button class="btn ghost" id="m-cancel">取消</button>'
    + '<button class="btn ghost" id="imp-keep">保留原有</button>'
    + '<button class="btn primary" id="imp-overwrite">覆盖导入</button>'
    + '</div>');

  document.querySelectorAll('.imp-skip input').forEach(function (box) {
    box.onchange = function () {
      pending[+box.dataset.i]._skip = box.checked;
      renderReview();
    };
  });
  document.querySelectorAll('.imp-edit').forEach(function (b) {
    b.onclick = function () {
      const i = +b.dataset.i;
      const c = pending[i];
      openCourseModal(c, null, null, {
        onCommit: function (next) {
          next._srcRow = c._srcRow;
          next._issues = (!next.room) ? ['缺教室'] : [];
          next._skip = c._skip;
          pending[i] = next;
          detectConflicts([next], state.courses);
          renderReview();
        },
        onDelete: function () { pending.splice(i, 1); renderReview(); }
      });
    };
  });

  const keepBtn = byId('imp-keep');
  const overwriteBtn = byId('imp-overwrite');
  if (keepBtn) keepBtn.onclick = doKeep;
  if (overwriteBtn) overwriteBtn.onclick = doOverwrite;

  const diffBtn = byId('imp-diff-toggle');
  const diffList = byId('imp-diff-list');
  if (diffBtn && diffList) {
    diffBtn.onclick = function () {
      const open = diffList.style.display !== 'none';
      diffList.style.display = open ? 'none' : 'flex';
      diffBtn.classList.toggle('open', !open);
    };
  }

  const diagBtn = byId('imp-diag-toggle');
  const diagPre = byId('imp-diag-pre');
  if (diagBtn && diagPre) {
    diagBtn.onclick = function () {
      const open = diagPre.style.display !== 'none';
      if (open) { diagPre.style.display = 'none'; diagBtn.classList.remove('open'); return; }
      diagPre.textContent = diagText();
      diagPre.style.display = 'block';
      diagBtn.classList.add('open');
    };
  }
}

function stripInternal(c) {
  return {
    id: c.id, name: c.name, room: c.room, teacher: c.teacher, note: c.note,
    weekday: c.weekday, startSlot: c.startSlot, endSlot: c.endSlot,
    weeks: c.weeks, color: c.color
  };
}

/* 保留原有：现有课表一律不动；只把「新增」补进去，同名同节次的「变更」保持原样 */
function doKeep() {
  const alive = pending.filter(function (c) { return !c._skip; });
  if (!alive.length) { toast('没有可导入的课程'); return; }
  const diff = buildDiff(alive, state.courses || []);
  if (!diff.added.length) {
    closeModal();
    toast('没有新增课程，现有课表保持不变');
    return;
  }
  snapshot();
  applySemester();
  state.courses = (state.courses || []).concat(diff.added.map(stripInternal));
  saveState(); closeModal(); renderAll();
  toast('已保留原有课表，新增 ' + diff.added.length + ' 门课程', '撤销', undoImport);
}

/* 覆盖导入：用导入结果整体替换（差异卡片已列出会被删掉哪些） */
function doOverwrite() {
  const alive = pending.filter(function (c) { return !c._skip; });
  if (!alive.length) { toast('没有可导入的课程'); return; }
  const diff = buildDiff(alive, state.courses || []);
  const cur = (state.courses || []).length;
  const msg = '将用导入的 ' + alive.length + ' 门课程替换现有 ' + cur + ' 门'
    + (diff.removed.length ? '，其中 ' + diff.removed.length + ' 门会被删除' : '')
    + '。导入前会自动备份，可在提示里撤销。';
  openConfirm('覆盖现有课表', msg, [{ label: '覆盖导入', danger: true, val: 'ok' }], function (v) {
    if (v !== 'ok') return;
    snapshot();
    applySemester();
    state.courses = alive.map(stripInternal);
    saveState(); renderAll();
    toast('已覆盖导入 ' + alive.length + ' 门课程', '撤销', undoImport);
  });
  /* 在确认框里点「取消」时回到导入预览，而不是把整个弹层关掉 */
  const cancelBtn = byId('m-cancel');
  if (cancelBtn) cancelBtn.onclick = function () { renderReview(); };
}

function snapshot() {
  try {
    lastSnapshot = JSON.stringify({ courses: state.courses || [], meta: { semesterStart: state.meta.semesterStart, totalWeeks: state.meta.totalWeeks } });
  } catch (e) { lastSnapshot = null; }
}
/* 导入时顺带把学期信息写进设置（用户勾了才写） */
function applySemester() {
  const box = byId('imp-sem');
  if (!box || !box.checked || !pendingSemester) return;
  state.meta.semesterStart = pendingSemester.start;
  state.meta.totalWeeks = pendingSemester.weeks;
}
function undoImport() {
  if (!lastSnapshot) { toast('没有可撤销的备份'); return; }
  try {
    const snap = JSON.parse(lastSnapshot);
    state.courses = Array.isArray(snap) ? snap : (snap.courses || []);
    if (snap && snap.meta) {
      if (snap.meta.semesterStart) state.meta.semesterStart = snap.meta.semesterStart;
      if (snap.meta.totalWeeks) state.meta.totalWeeks = snap.meta.totalWeeks;
    }
    saveState(); renderAll();
    toast('已撤销导入');
  } catch (e) { toast('撤销失败'); }
}

/* 识别失败时的兜底：让用户手动指定布局 */
function openFormatFallback(rows) {
  openModal('<div class="modal-head"><h3>没能自动识别</h3><button class="modal-close" id="m-close">✕</button></div>'
    + '<div class="modal-body"><div class="note" style="text-align:left">这份表格既不像「网格表」也不像「列表表」，请确认它的结构：<br>'
    + '· <b>网格表</b>：第一行是 周一~周日，左侧是 第N节 / 时间<br>'
    + '· <b>列表表</b>：一行一门课，有 课程 / 星期 / 节次 这样的表头</div>'
    + '<div class="imp-diag"><button type="button" class="imp-diag-toggle" id="imp-diag-toggle">'
    + '<span>查看 app 实际读到的内容</span><i class="collapse-arrow">▾</i></button>'
    + '<pre class="imp-diag-pre" id="imp-diag-pre" style="display:none"></pre></div></div>'
    + '<div class="modal-foot"><button class="btn ghost" id="m-cancel">取消</button>'
    + '<button class="btn ghost" id="imp-as-list">按列表表</button>'
    + '<button class="btn primary" id="imp-as-grid">按网格表</button></div>');
  byId('imp-as-grid').onclick = function () { runParse(rows, 'grid'); };
  byId('imp-as-list').onclick = function () { runParse(rows, 'list'); };
  const db = byId('imp-diag-toggle'), dp = byId('imp-diag-pre');
  if (db && dp) {
    db.onclick = function () {
      const open = dp.style.display !== 'none';
      if (open) { dp.style.display = 'none'; db.classList.remove('open'); return; }
      dp.textContent = diagText();
      dp.style.display = 'block';
      db.classList.add('open');
    };
  }
}

function runParse(rows, force) {
  lastRows = rows;
  lastFormat = '';
  let res;
  try { res = parseTable(rows, force); }
  catch (e) { toast('解析失败：' + (e && e.message ? e.message : e)); return; }
  lastFormat = res.format || '未识别';
  pendingSemester = res.semester || null;
  /* 识别不出来或结果太少时，先把诊断信息摆在眼前，方便对症 */
  if (!res.courses.length) { openFormatFallback(rows); return; }
  pending = res.courses;
  renderReview();
}

/* ═══════════════════════ 十、入口：文件 / 粘贴 ═══════════════════════ */

function readAsArrayBuffer(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader();
    fr.onload = function () { resolve(fr.result); };
    fr.onerror = function () { reject(new Error('文件读取失败')); };
    fr.readAsArrayBuffer(file);
  });
}
function readAsText(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader();
    fr.onload = function () { resolve(fr.result); };
    fr.onerror = function () { reject(new Error('文件读取失败')); };
    fr.readAsText(file, 'utf-8');
  });
}

/* 粗略判断是不是二进制垃圾内容（图片、压缩包、可执行文件等） */
function looksBinary(u8) {
  const n = Math.min(u8.length, 2048);
  if (!n) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = u8[i];
    if (b === 0) bad += 4;
    else if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad > n * 0.1;
}

/* 不看扩展名，按文件真实内容选解析器 —— 教务系统导出的 .xls 常常名不副实 */
async function handleFile(file) {
  const fname = file.name || '该文件';
  try {
    const u8 = new Uint8Array(await readAsArrayBuffer(file));
    if (!u8.length) { toast('这个文件是空的'); return; }
    const kind = sniffFormat(u8);
    lastKind = kind === 'ole2' ? 'OLE2/BIFF 真 .xls 二进制'
      : kind === 'zip' ? 'xlsx（zip）'
      : kind === 'spreadsheetml' ? 'SpreadsheetML（Excel 2003 XML）'
      : kind === 'html' ? 'HTML 表格'
      : '纯文本（CSV/TSV）';
    if (kind === 'text' && looksBinary(u8)) {
      unsupportedModal(fname, '这个文件不是表格，看起来是图片 / 压缩包 / 其它二进制文件。');
      return;
    }
    runParse(await rowsFromBytes(u8));
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    /* 结构类错误（比如「没有找到 Workbook 数据流」）用弹层讲清楚，比 toast 有用 */
    if (msg.indexOf('没有') >= 0 || msg.indexOf('不是') >= 0) unsupportedModal(fname, msg);
    else toast('解析失败：' + msg);
  }
}

/* 格式不支持时：说清文件、给两条出路（另存为 xlsx / 直接粘贴） */
function unsupportedModal(fileName, why) {
  openModal('<div class="modal-head"><h3>这个文件暂时读不了</h3><button class="modal-close" id="m-close">✕</button></div>'
    + '<div class="modal-body"><div class="note" style="text-align:left">'
    + '选中的文件：<b>' + esc(fileName) + '</b><br>' + esc(why) + '<br><br>'
    + '<b>两个办法：</b><br>'
    + '① 在 Excel / WPS 里打开它 → <b>另存为 → Excel 工作簿(.xlsx)</b> 或 <b>CSV</b> → 再点「Excel / CSV」导入；<br>'
    + '② 直接在表格里框选课表 → 复制 → 点「<b>粘贴表格</b>」粘进去（不用存文件，手机上传不上去时最省事）。'
    + '</div></div>'
    + '<div class="modal-foot"><button class="btn primary" id="m-cancel">知道了</button></div>');
}

function openPasteModal() {
  openModal('<div class="modal-head"><h3>粘贴表格</h3><button class="modal-close" id="m-close">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="field"><label>在 Excel 里框选课表 → 复制 → 粘贴到下面</label>'
    + '<textarea id="imp-paste" class="imp-textarea" placeholder="高等数学&#9;张老师&#9;A-101&#9;周一&#9;1-2节&#9;1-16周"></textarea></div>'
    + '<div class="note">支持制表符 / 逗号分隔；网格表与列表表都能自动识别。</div>'
    + '</div>'
    + '<div class="modal-foot"><button class="btn ghost" id="m-cancel">取消</button>'
    + '<button class="btn primary" id="imp-paste-ok">解析</button></div>');
  byId('imp-paste-ok').onclick = function () {
    const txt = byId('imp-paste').value;
    if (!txt || !txt.trim()) { toast('请先粘贴表格内容'); return; }
    runParse(parseCsv(txt));
  };
}

/* ═══════════════════════ 十二、.xls / 伪 .xls：按字节嗅探真实格式 ═══════════════════════
   现实里"课表.xls"有三种截然不同的内容，只看扩展名会判断错：
     · OLE2 复合文档 + BIFF 记录   → 真正的 Excel 97-2003 二进制
     · SpreadsheetML（XML）        → 很多教务系统导出的其实是这个
     · HTML <table>               → 还有一批是网页表格套了 .xls 后缀
   因此一律先读前若干字节判断真实格式，再走对应解析器。
   ══════════════════════════════════════════════════════════════════════════════ */

/* 智能解码：UTF-8 优先，出现替换字符则回退 GBK（教务系统导出常是 GBK） */
let gbkDecoder = null;
function decodeTextSmart(u8) {
  const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return utf8.decode(b.subarray(3));
  const s = utf8.decode(b);
  if (s.indexOf('\uFFFD') < 0) return s;
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    const g = gbkDecoder.decode(b);
    /* GBK 解出来若还是有大量替换字符，说明两种都不对，仍返回 UTF-8 结果 */
    return g.indexOf('\uFFFD') < g.length / 100 ? s : g;
  } catch (e) { return s; }
}

/* 字节嗅探：决定用哪个解析器 */
function sniffFormat(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length >= 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return 'ole2';
  if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B) return 'zip';
  const head = decodeTextSmart(u8.subarray(0, Math.min(u8.length, 8192)));
  const t = head.replace(/^\uFEFF/, '').toLowerCase();
  if (t.indexOf('urn:schemas-microsoft-com:office:spreadsheet') >= 0) return 'spreadsheetml';
  if (t.indexOf('<table') >= 0 || t.indexOf('<html') >= 0) return 'html';
  return 'text';
}

/* ────── OLE2 复合文档：取内部数据流 ────── */
function ole2Streams(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const secShift = dv.getUint16(0x1E, true);
  const secSize = 1 << secShift;
  const miniSecSize = 1 << dv.getUint16(0x20, true);
  const firstDirSec = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const firstMiniFatSec = dv.getUint32(0x3C, true);
  const numDifatSec = dv.getUint32(0x48, true);
  const firstDifatSec = dv.getUint32(0x44, true);
  const FREE = 0xFFFFFFFF, END = 0xFFFFFFFE;
  function secOff(s) { return (s + 1) * secSize; }

  /* DIFAT：先取头部 109 项，再顺着 DIFAT 链取 */
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = dv.getUint32(0x4C + i * 4, true);
    if (v === FREE || v === END) break;
    difat.push(v);
  }
  let ds = firstDifatSec, guard = 0;
  const perSec = secSize / 4 - 1;
  while (ds !== END && ds !== FREE && numDifatSec && guard++ < 4096) {
    const base = secOff(ds);
    if (base + secSize > u8.length) break;
    for (let i = 0; i < perSec; i++) {
      const v = dv.getUint32(base + i * 4, true);
      if (v !== FREE && v !== END) difat.push(v);
    }
    ds = dv.getUint32(base + perSec * 4, true);
  }
  /* FAT */
  const fat = [];
  difat.forEach(function (fs) {
    const base = secOff(fs);
    if (base + secSize > u8.length) return;
    for (let i = 0; i < secSize / 4; i++) fat.push(dv.getUint32(base + i * 4, true));
  });
  function chain(start, table) {
    const out = [];
    let s = start, n = 0;
    const tb = table || fat;
    while (s !== END && s !== FREE && s < tb.length && n++ < 2000000) { out.push(s); s = tb[s]; }
    return out;
  }
  function readChain(start, size, table, ss) {
    const secs = chain(start, table);
    const sz = ss || secSize;
    const buf = new Uint8Array(secs.length * sz);
    for (let i = 0; i < secs.length; i++) {
      const o = ss ? secs[i] * sz : secOff(secs[i]);
      if (o + sz > u8.length) break;
      buf.set(u8.subarray(o, o + sz), i * sz);
    }
    return size != null && size <= buf.length ? buf.subarray(0, size) : buf;
  }
  /* 目录项 */
  const dirBytes = readChain(firstDirSec);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const type = dirBytes[off + 66];
    if (type !== 1 && type !== 2 && type !== 5) continue;
    const nameLen = ddv.getUint16(off + 64, true);
    let name = '';
    for (let k = 0; k + 1 < nameLen && k < 64; k += 2) name += String.fromCharCode(ddv.getUint16(off + k, true));
    entries.push({
      name: name.replace(/\u0000+$/, ''),
      type: type,
      start: ddv.getUint32(off + 116, true),
      size: ddv.getUint32(off + 120, true)
    });
  }
  const root = entries.filter(function (e) { return e.type === 5; })[0];
  /* MiniFAT：小数据流（< 4096B）走这里 */
  let miniFat = null, miniStream = null;
  if (root && root.size) {
    miniStream = readChain(root.start, root.size);
    const mf = readChain(firstMiniFatSec, null);
    const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    miniFat = [];
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mdv.getUint32(i, true));
  }
  const out = {};
  entries.forEach(function (e) {
    if (e.type !== 2 || !e.size) return;
    try {
      if (e.size < miniCutoff && miniStream && miniFat) {
        const secs = chain(e.start, miniFat);
        const buf = new Uint8Array(e.size);
        let w = 0;
        for (let i = 0; i < secs.length && w < e.size; i++) {
          const o = secs[i] * miniSecSize;
          const n = Math.min(miniSecSize, e.size - w, miniStream.length - o);
          if (n <= 0) break;
          buf.set(miniStream.subarray(o, o + n), w);
          w += n;
        }
        out[e.name] = buf;
      } else {
        out[e.name] = readChain(e.start, e.size);
      }
    } catch (err) { /* 单个流失败不影响其它流 */ }
  });
  return out;
}

/* ────── BIFF8：共享字符串表（含跨 CONTINUE 记录的续读） ────── */
function parseSstRecord(buf, dv, parts) {
  /* 把所有 SST + CONTINUE 的负载拼成一块，同时记下每条记录的起点，用于跨记录续读 */
  const bounds = [];
  let total = 0;
  parts.forEach(function (r) { bounds.push(total); total += r.len; });
  const flat = new Uint8Array(total);
  let w = 0;
  parts.forEach(function (r) { flat.set(buf.subarray(r.start, r.start + r.len), w); w += r.len; });
  const fdv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  const count = fdv.getUint32(4, true);
  const out = [];
  const boundSet = Object.create(null);
  bounds.forEach(function (b) { boundSet[b] = 1; });
  let p = 8;
  function nextBoundaryAfter(pos) {
    for (let i = 0; i < bounds.length; i++) if (bounds[i] > pos) return bounds[i];
    return null;
  }
  for (let i = 0; i < count && p + 3 <= flat.length; i++) {
    const cch = fdv.getUint16(p, true); p += 2;
    const grbit = flat[p++];
    let high = grbit & 0x01;
    const rich = (grbit & 0x08) !== 0, ext = (grbit & 0x04) !== 0;
    let cRun = 0, cbExt = 0;
    if (rich) { cRun = fdv.getUint16(p, true); p += 2; }
    if (ext) { cbExt = fdv.getInt32(p, true); p += 4; }
    let s = '', remaining = cch, guard = 0;
    while (remaining > 0 && guard++ < 200000) {
      /* 正落在 CONTINUE 记录的起点：该记录首字节是「剩余字符的新 grbit」，不是字符数据 */
      if (boundSet[p]) high = flat[p++] & 0x01;
      const nb = nextBoundaryAfter(p);
      const step = high ? 2 : 1;
      const avail = nb == null ? remaining : Math.floor((nb - p) / step);
      const n = Math.min(remaining, Math.max(avail, 0));
      for (let k = 0; k < n; k++) {
        s += high ? String.fromCharCode(fdv.getUint16(p, true)) : String.fromCharCode(flat[p]);
        p += step;
      }
      remaining -= n;
      if (remaining > 0) {
        if (nb == null) break;
        p = nb;                    /* 跳到下一条记录，下一轮循环会读它的 grbit */
      }
    }
    /* 富文本段与扩展段也是连续存放的，直接跳过（跨记录不需要额外字节） */
    if (cRun * 4 + cbExt > 0) {
      const end = p + cRun * 4 + cbExt;
      p = Math.min(end, flat.length);
    }
    out.push(s);
  }
  return out;
}

/* RK 编码 → 数字 */
function rkToNumber(rk) {
  let v;
  if (rk & 0x02) {
    v = rk >> 2;                       /* 30 位有符号整数 */
  } else {
    const tmp = new ArrayBuffer(8);
    const tdv = new DataView(tmp);
    tdv.setUint32(4, (rk & 0xFFFFFFFC) >>> 0, true);
    v = tdv.getFloat64(0, true);
  }
  return (rk & 0x01) ? v / 100 : v;
}
function numToCellText(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}
function biffString(buf, dv, pos) {
  const cch = dv.getUint16(pos, true);
  const grbit = buf[pos + 2];
  const high = grbit & 0x01;
  let q = pos + 3, s = '';
  for (let k = 0; k < cch; k++) {
    s += high ? String.fromCharCode(dv.getUint16(q, true)) : String.fromCharCode(buf[q]);
    q += high ? 2 : 1;
  }
  return s;
}

/* 用「单元格字典 + 合并区」拼二维表（xlsx 与 xls 共用） */
function buildRows(cells, merges) {
  let maxR = -1, maxC = -1;
  Object.keys(cells).forEach(function (k) {
    const p = k.split(',');
    const r = +p[0], c = +p[1];
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  });
  (merges || []).forEach(function (m) {
    if (m.r2 > maxR) maxR = m.r2;
    if (m.c2 > maxC) maxC = m.c2;
  });
  (merges || []).forEach(function (m) {
    const v = cells[m.r1 + ',' + m.c1];
    if (v == null) return;
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) cells[r + ',' + c] = v;
  });
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) {
      const v = cells[r + ',' + c];
      row.push(v == null ? '' : v);
    }
    rows.push(row);
  }
  return rows;
}

/* ────── BIFF：把 Workbook 流解析成多张表，取内容最多的那张 ────── */
function biffStreamToRows(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const recs = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    if (p + 4 + len > buf.length) break;
    recs.push({ type: type, off: p, start: p + 4, len: len });
    p += 4 + len;
  }
  /* 共享字符串表（只存在于全局子流） */
  let sst = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].type === 0x00FC) {
      const parts = [recs[i]];
      let j = i + 1;
      while (j < recs.length && recs[j].type === 0x003C) { parts.push(recs[j]); j++; }
      try { sst = parseSstRecord(buf, dv, parts); } catch (e) { sst = []; }
      break;
    }
  }
  /* 工作表位置表 */
  const sheets = [];
  recs.forEach(function (r) {
    if (r.type !== 0x0085) return;
    try {
      sheets.push({ name: biffString(buf, dv, r.start + 6), pos: dv.getUint32(r.start, true) });
    } catch (e) {}
  });
  function isSheetBof(idx) {
    const r = recs[idx];
    if (!r || r.type !== 0x0809 || r.len < 4) return false;
    return dv.getUint16(r.start + 2, true) === 0x0010;   /* dt=0x0010 才是工作表 */
  }
  function parseSheetAt(bofPos) {
    const cells = Object.create(null), merges = [];
    let idx = recs.findIndex(function (r) { return r.off === bofPos && r.type === 0x0809; });
    if (idx < 0) idx = recs.findIndex(function (r, i) { return isSheetBof(i); });
    if (idx < 0) return null;
    let depth = 0;
    for (let i = idx; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 0x0809) { depth++; continue; }
      if (r.type === 0x000A) { depth--; if (depth <= 0) break; continue; }
      if (depth !== 1) continue;
      const o = r.start;
      try {
        if (r.type === 0x00FD && r.len >= 10) {                    /* LABELSST */
          const s = dv.getUint32(o + 6, true);
          if (sst[s] != null) cells[dv.getUint16(o, true) + ',' + dv.getUint16(o + 2, true)] = sst[s];
        } else if (r.type === 0x0204 || r.type === 0x00D6) {       /* LABEL / RSTRING */
          cells[dv.getUint16(o, true) + ',' + dv.getUint16(o + 2, true)] = biffString(buf, dv, o + 6);
        } else if (r.type === 0x0203 && r.len >= 14) {             /* NUMBER */
          cells[dv.getUint16(o, true) + ',' + dv.getUint16(o + 2, true)] = numToCellText(dv.getFloat64(o + 6, true));
        } else if (r.type === 0x027E && r.len >= 10) {             /* RK */
          cells[dv.getUint16(o, true) + ',' + dv.getUint16(o + 2, true)] = numToCellText(rkToNumber(dv.getUint32(o + 6, true)));
        } else if (r.type === 0x00BD) {                            /* MULRK */
          const row = dv.getUint16(o, true);
          const c1 = dv.getUint16(o + 2, true);
          const n = (r.len - 6) / 6;
          for (let k = 0; k < n; k++) cells[row + ',' + (c1 + k)] = numToCellText(rkToNumber(dv.getUint32(o + 4 + k * 6 + 2, true)));
        } else if (r.type === 0x0006 && r.len >= 14) {             /* FORMULA：取缓存结果 */
          const row = dv.getUint16(o, true), col = dv.getUint16(o + 2, true);
          const b6 = buf[o + 12], b7 = buf[o + 13];
          if (b6 === 0xFF && b7 === 0xFF) {
            const kind = buf[o + 6];
            if (kind === 0x00 || kind === 0x01) {                  /* 字符串：值在紧随的 STRING 记录里 */
              const nx = recs[i + 1];
              if (nx && nx.type === 0x0207) cells[row + ',' + col] = biffString(buf, dv, nx.start);
            }
          } else {
            cells[row + ',' + col] = numToCellText(dv.getFloat64(o + 6, true));
          }
        } else if (r.type === 0x00E5 && r.len >= 2) {              /* MERGEDCELLS */
          const cref = dv.getUint16(o, true);
          for (let k = 0; k < cref; k++) {
            const b = o + 2 + k * 8;
            if (b + 8 > o + r.len) break;
            merges.push({ r1: dv.getUint16(b, true), r2: dv.getUint16(b + 2, true), c1: dv.getUint16(b + 4, true), c2: dv.getUint16(b + 6, true) });
          }
        }
      } catch (e) { /* 单条记录解析失败就跳过，不让整表崩掉 */ }
    }
    return { cells: cells, merges: merges };
  }
  const targets = sheets.length ? sheets : [{ name: '', pos: -1 }];
  let best = null, bestCount = -1;
  targets.forEach(function (s) {
    const r = parseSheetAt(s.pos);
    if (!r) return;
    const n = Object.keys(r.cells).length;
    /* 内容最多的那张通常就是课表（有些教务系统会先放一张说明页） */
    if (n > bestCount) { bestCount = n; best = r; }
  });
  if (!best || bestCount <= 0) throw new Error('这个 .xls 里没有读到任何单元格内容');
  return buildRows(best.cells, best.merges);
}

function xlsToRows(input) {
  const streams = ole2Streams(input);
  const wb = streams['Workbook'] || streams['Book'] || streams['workbook'] || streams['book'];
  if (!wb) {
    const names = Object.keys(streams);
    throw new Error('这个 .xls 里没有 Workbook 数据流（含有的流：' + (names.join('、') || '无') + '）');
  }
  return biffStreamToRows(wb);
}

/* ────── SpreadsheetML（Excel 2003 XML，)常见于教务系统导出 ────── */
function spreadsheetMlToRows(text) {
  const out = [];
  const rowRe = /<(?:\w+:)?Row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Row>/gi;
  let rm;
  while ((rm = rowRe.exec(text))) {
    const rAttrs = rm[1] || '';
    const idxM = /\b(?:ss:)?Index="(\d+)"/i.exec(rAttrs);
    const rowIdx = idxM ? +idxM[1] - 1 : out.length;
    const row = [];
    const cellRe = /<(?:\w+:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Cell>)/gi;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const cAttrs = cm[1] || '';
      const body = cm[2] || '';
      const ci = /\b(?:ss:)?Index="(\d+)"/i.exec(cAttrs);
      if (ci) { const target = +ci[1] - 1; while (row.length < target) row.push(''); }
      const dm = /<(?:\w+:)?Data\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Data>/i.exec(body);
      let val = dm ? dm[1] : '';
      val = decodeXml(val.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\r/g, '').trim();
      row.push(val);
      const ma = /\b(?:ss:)?MergeAcross="(\d+)"/i.exec(cAttrs);
      if (ma) { for (let k = 0; k < +ma[1]; k++) row.push(val); }
    }
    out[rowIdx] = row;
  }
  const rows = [];
  for (let i = 0; i < out.length; i++) rows.push(out[i] || []);
  return rows;
}

/* ────── HTML 表格（.xls 后缀的网页导出） ────── */
function htmlTableToRows(text) {
  const tm = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(text);
  const scope = tm ? tm[1] : text;
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(scope))) {
    const row = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[2] || '';
      let val = cm[3]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      val = decodeXml(val).replace(/\u00A0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
      const cs = /\bcolspan\s*=\s*"?(\d+)/i.exec(attrs);
      const rs = /\browspan\s*=\s*"?(\d+)/i.exec(attrs);
      row.push(val);
      const span = cs ? Math.min(+cs[1], 20) : 1;
      for (let k = 1; k < span; k++) row.push('');
      if (rs && +rs[1] > 1) row._rs = row._rs || {};
    }
    rows.push(row);
  }
  return rows;
}

/* ────── 统一入口：字节数组 → 二维表 ────── */
async function rowsFromBytes(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = sniffFormat(u8);
  if (kind === 'zip') return await xlsxToRows(u8.buffer.byteLength === u8.length ? u8.buffer : u8.slice().buffer);
  if (kind === 'ole2') return xlsToRows(u8);
  const text = decodeTextSmart(u8);
  if (kind === 'spreadsheetml') return spreadsheetMlToRows(text);
  if (kind === 'html') return htmlTableToRows(text);
  return parseCsv(text);
}

/* ═══════════════════════ 十三、初始化 ═══════════════════════ */

/* 只负责绑定隐藏文件输入；两个入口按钮由 app.js 绑定（便于先加载本模块再触发） */
function init() {
  const fileInput = byId('file-excel');
  if (!fileInput) return;
  fileInput.onchange = function () {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) handleFile(f);
  };
}

const api = {
  init: init,
  openPaste: openPasteModal,
  handleFile: handleFile,
  importRows: runParse,
  parseTable: parseTable,
  parseCourseCell: parseCourseCell,
  parseWeeks: parseWeeks,
  parseSlotField: parseSlotField,
  parseCsv: parseCsv,
  parseSheet: parseSheet,
  parseSharedStrings: parseSharedStrings,
  extractText: extractText,
  xlsxToRows: xlsxToRows,
  unzipEntries: unzipEntries,
  tinyInflate: tinyInflate,
  detectGrid: detectGrid,
  detectList: detectList,
  gridToCourses: gridToCourses,
  listToCourses: listToCourses,
  normalizeItems: normalizeItems,
  weeksOverlap: weeksOverlap,
  colToIndex: colToIndex,
  rowSlot: rowSlot,
  makeMeta: makeMeta,
  sniffFormat: sniffFormat,
  rowsFromBytes: rowsFromBytes,
  decodeTextSmart: decodeTextSmart,
  ole2Streams: ole2Streams,
  parseSstRecord: parseSstRecord,
  biffStreamToRows: biffStreamToRows,
  xlsToRows: xlsToRows,
  spreadsheetMlToRows: spreadsheetMlToRows,
  htmlTableToRows: htmlTableToRows,
  buildRows: buildRows,
  rkToNumber: rkToNumber,
  buildDiff: buildDiff,
  slotKey: slotKey,
  sameCourse: sameCourse,
  parseSlashCell: parseSlashCell,
  detectSemester: detectSemester
};

if (typeof window !== 'undefined') window.ExcelImport = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

})();
