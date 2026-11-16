// fast-marked — a dependency-free, faster drop-in replacement for marked 18.1.3.
// parse(markdown) returns exactly the HTML marked.parse(markdown) returns with
// marked's default options (gfm true, breaks false, pedantic false, async false).
// Written from the CommonMark 0.31.2 / GFM 0.29 specs and marked 18.1.3's grammar.

/* ---------------- small helpers ---------------- */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => ESC_MAP[c];
// Entity-preserving escape: & stays when it begins a valid entity (named or numeric).
const RE_ESC_NO_ENC = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_ESC_ENC = /[&<>"']/g;
function esc(s) { // escape text / href / title, keeping valid entities intact
  return RE_ESC_NO_ENC.test(s) ? s.replace(RE_ESC_NO_ENC, escChar) : s;
}
function escFull(s) { // escape everything (code spans, autolink text, image alt fallback)
  return RE_ESC_ENC.test(s) ? s.replace(RE_ESC_ENC, escChar) : s;
}
const RE_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Decode numeric character references (named entities pass through untouched);
// bare & becomes &amp;. Mirrors marked's unescape().
function unescapeNum(s) {
  if (!RE_NUM_REF.test(s)) return s;
  return s.replace(RE_NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}
// marked's cleanUrl: encodeURI, then turn %25 back into %.
function cleanUrl(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}
// Link-label normalisation: trim, collapse whitespace, Unicode-aware lowercase.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Expand tabs in s, counting columns from col.
function expandTabs(s, col) {
  let t = col, out = '';
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (t % 4); out += ' '.repeat(r); t += r; }
    else { out += ch; t++; }
  }
  return out;
}
// Parenthesis balance in a link destination: index of the unbalanced ')',
// -2 when a '(' is left unclosed, -1 when balanced (or no parens at all).
function parenBalance(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}
// Trim trailing newline characters.
function trimEndNL(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 10) n--;
  return s.slice(0, n);
}
// Strip trailing blank lines from an HTML block, keeping at most 2 newlines.
function trimHtmlBlock(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

/* ---------------- block grammar (marked 18.1.3, GFM) ---------------- */

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_START = `<\\/?(?:${BLOCK_TAGS})(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[`;
const HR_SRC = `(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}`;
const FENCE_START_SRC = `(?:\`{3,}(?=[^\`\\n]*(?:\\n|$))|~~~)`;
const TABLE_DELIM_SRC = `((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)`;
const TABLE_ROWS_SRC = `((?:(?! *\\n| {0,3}(?:${HR_SRC})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}${FENCE_START_SRC}[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:${HTML_START})).*(?:\\n|$))*)`;

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = new RegExp("^ {0,3}(`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})([^\\n]*)(?:\\n|$)(?:|([\\s\\S]*?)(?:\\n|$))(?: {0,3}(?:(?=`)\\1`*|(?=~)\\1~*) *(?=\\n|$)|$)", "");
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HR = new RegExp(`^ {0,3}(${HR_SRC})(?:\\n+|$)`);
const RE_HTML = new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i");
const RE_DEF = new RegExp("^ {0,3}\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)", "");
const RE_LIST = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const RE_LHEADING = new RegExp(`^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:${HR_SRC})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)`);
const RE_TABLE = new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)", "");
const RE_PARAGRAPH = new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)", "");
const RE_TEXT = /^[^\n]+/;
const RE_BLOCKQUOTE = new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+", "");

const RE_LIST_ITEM = (m) => new RegExp(`^( {0,3}${m})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const RE_NEXT_BULLET = (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
const RE_HR_AT = (n) => new RegExp(`^ {0,${n}}(${HR_SRC})(?:\\n+|$)`);
const RE_FENCES_AT = (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
const RE_HEADING_AT = (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
const RE_HTML_AT = (n) => new RegExp(`^ {0,${n}}(?:<\\/?(?:${BLOCK_TAGS})(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const RE_BQ_AT = (n) => new RegExp(`^ {0,${n}}>`);

/* other small patterns (marked's "other" set) */
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_NON_SPACE = /[^ ]/;
const RE_BLANK_LINE = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANY_LINE = /\n.*\n/;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const RE_LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const RE_LIST_REPLACE_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const RE_TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const RE_TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const RE_TABLE_DELIMITER = /[:|]/;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const RE_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_STRIP = /^ {0,3}>[ \t]?/gm;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const RE_INDENT_CODE_COMP = /^(\s+)(?:```)/;

/* ---------------- inline grammar (marked 18.1.3, GFM) ---------------- */

const RE_I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_I_TAG = new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", "");
const RE_I_LINK = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", "");
const RE_I_REFLINK = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", "");
const RE_I_NOLINK = new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", "");
const RE_I_EM_L = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const RE_I_EM_R_AST = new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu");
const RE_I_EM_R_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_I_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_I_BR = new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", "");
const RE_I_DEL = new RegExp("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)", "");
const RE_I_DEL_L = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const RE_I_DEL_R = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const RE_I_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RE_I_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

// Sticky (y) twins of the per-position inline regexes: they match at lastIndex
// on the original string, so the inline loop never slices s per iteration
// (the old s.slice(i) per token was O(n^2) on long paragraphs). The leading ^
// of each ^-anchored pattern is dropped; y already anchors at lastIndex.
// stripAnchors only removes ^ at the pattern start or after a top-level |,
// never the ^ of a negated [^...] class.
const stripAnchors = (src) => src.replace(/(^|\|)\^/g, '$1');
const RE_I_ESCAPE_Y = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const RE_I_TAG_Y = new RegExp(stripAnchors(RE_I_TAG.source), 'y');
const RE_I_LINK_Y = new RegExp(stripAnchors(RE_I_LINK.source), 'y');
const RE_I_REFLINK_Y = new RegExp(stripAnchors(RE_I_REFLINK.source), 'y');
const RE_I_NOLINK_Y = new RegExp(stripAnchors(RE_I_NOLINK.source), 'y');
const RE_I_EM_L_Y = new RegExp(stripAnchors(RE_I_EM_L.source), 'uy');
const RE_I_CODE_Y = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const RE_I_BR_Y = new RegExp(stripAnchors(RE_I_BR.source), 'y');
const RE_I_AUTOLINK_Y = new RegExp(stripAnchors(RE_I_AUTOLINK.source), 'y');
const RE_I_URL_Y = new RegExp(stripAnchors(RE_I_URL.source), 'y');
const RE_I_DEL_L_Y = new RegExp(stripAnchors(RE_I_DEL_L.source), 'uy');
const RE_I_BACKPEDAL = new RegExp("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+", "");
const RE_I_BLOCKSKIP = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");
const RE_I_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const RE_I_ANY_PUNCT_OUT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_I_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
// Fast path: if none of these appear, the inline string is plain text.
const RE_INLINE_TRIGGER = /[\\<\[`*!_~@]| {2,}\n|www\.|https?|ftp|mailto:|xmpp:/i;
// Finds the next position where a text run must stop (used by scanText).
const RE_STOP = /[\\<\[`*!_~@]| {2,}\n|www\.|[hH][tT][tT][pP][sS]?|[fF][tT][pP]|mailto:|xmpp:/g;
// First non-whitespace at/after lastIndex (scanText's hard-break (?!\s*$) check).
const RE_NON_WS_G = /\S/g;

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isEmailLocalCode(c) {
  return isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 96 ||
    c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

/* ---------------- inline masking (for emphasis / del closers) ---------------- */

// Last index in the masked string where an emphasis / del closer run may start.
function lastClosers(masked) {
  let star = -1, under = -1, tilde = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const c = masked[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') tilde = i;
      else if (c === '*') star = i;
      else under = i;
    }
    let j = i + 1;
    while (j < n && masked[j] === c) j++;
    i = j - 1;
  }
  return { star, under, tilde };
}

function linkInText(s, refs) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(RE_I_BLOCKSKIP)) {
    if (RE_I_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(RE_I_REFLINK_SEARCH)) {
    const r = m[0], o = r.lastIndexOf('[');
    if (!(r.charAt(0) === '!' || !refs.has(normLabel(r.slice(o + 1, -1)))) &&
        !(o > 1 && linkInText(r.slice(1, o - 1), refs))) return true;
  }
  return false;
}

function maskReflinks(t, refs) {
  const re = new RegExp(RE_I_REFLINK_SEARCH.source, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(t)) !== null) {
    const r = m[0], o = r.lastIndexOf('[');
    let rep = r;
    if (refs.has(normLabel(r.slice(o + 1, -1)))) {
      if (o > 1 && r.charAt(0) !== '!' && linkInText(r.slice(1, o - 1), refs)) {
        rep = '[' + maskReflinks(r.slice(1, o - 1), refs) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      } else {
        rep = '[' + 'a'.repeat(r.length - 2) + ']';
      }
    }
    out += t.slice(last, m.index) + rep;
    last = m.index + r.length;
  }
  return out + t.slice(last);
}

// Masked copy of an inline string: link spans, code spans and tags become [aaa...],
// backslash-escaped punctuation becomes ++, so emphasis/del closers cannot see
// through them. Length is preserved, so positions line up with the real string.
function maskInline(s, refs) {
  let t = s;
  if (refs.size > 0 && s.includes('[')) t = maskReflinks(t, refs);
  t = t.replace(RE_I_ANY_PUNCT_OUT, (m, codeRun, escCh) => {
    if (escCh !== undefined) return '+'.repeat(m.length);
    if (codeRun !== undefined) return codeRun + m.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun;
    return m;
  });
  t = t.replace(RE_I_BLOCKSKIP, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
}

/* ---------------- emphasis / strikethrough (marked's delimiter algorithm) ---------------- */

function tryEmStrong(s, masked, pos, closers, prevChar) {
  RE_I_EM_L_Y.lastIndex = pos;
  const m = RE_I_EM_L_Y.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const r = m[0][0];
  const o = prevChar === r;
  let n = prevChar;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  let p = '';
  if (l > 0) {
    const cps = [...masked.slice(l - 2 < 0 ? 0 : l - 2, l)];
    if (cps.length) p = cps[cps.length - 1];
  }
  const h = p === '*' || p === '_' || !!RE_I_PUNCT.exec(p);
  if (l < i) n = p;
  const u = l < i ? h : !!RE_I_PUNCT.exec(n);
  if (m[4] && RE_UNICODE_ALNUM.test(n)) return null;
  const d = m[1] || m[3] || '';
  if (d && n && !u) return null; // search only when !d || !n || u
  const k = [...m[0]].length - 1;
  let mm = k, f = 0;
  const y = i - l + k;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  if (r !== '*' && r !== '_') return null;
  const A = r === '*' ? RE_I_EM_R_AST : RE_I_EM_R_UND;
  const v = r === '*' ? closers.star : closers.under;
  const Q = i + k;
  if (v < Q) return null;
  const t2 = masked.slice(pos + k);
  const ee = v - Q;
  A.lastIndex = 0;
  let s2;
  while ((s2 = A.exec(t2)) !== null && !(s2.index > ee)) {
    const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
    if (!g) continue;
    let b = [...g].length;
    if (s2[3] || s2[4]) { mm += b; continue; }
    else if (s2[5] || s2[6] || R) {
      if (o && (s2[5] || s2[6])) break;
      if (y % 3 && !((y + b) % 3)) { f += b; continue; }
    }
    mm -= b;
    if (mm > 0) continue;
    b = Math.min(b, b + mm + f);
    const te = [...s2[0]][0].length;
    const M = s.slice(pos, pos + k + s2.index + te + b);
    if (Math.min(k, b) % 2) return { raw: M, text: M.slice(1, -1), strong: false };
    return { raw: M, text: M.slice(2, -2), strong: true };
  }
  return null;
}

function tryDel(s, masked, pos, closers, prevChar) {
  RE_I_DEL_L_Y.lastIndex = pos;
  const m = RE_I_DEL_L_Y.exec(s);
  if (!m) return null;
  const n = prevChar;
  if (!((m[1] || '') === '' || !n || RE_I_PUNCT.exec(n))) return null;
  const o = [...m[0]].length - 1;
  let p = o;
  const u = closers.tilde;
  const d = pos + o;
  if (u < d) return null;
  const t2 = masked.slice(pos + o);
  const kk = u - d;
  RE_I_DEL_R.lastIndex = 0;
  let s2;
  while ((s2 = RE_I_DEL_R.exec(t2)) !== null && !(s2.index > kk)) {
    const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
    if (!g) continue;
    let l = [...g].length;
    if (l !== o) continue;
    if (s2[3] || s2[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const te = [...s2[0]][0].length;
    const raw = s.slice(pos, pos + o + s2.index + te + l);
    return { raw, text: raw.slice(o, -o) };
  }
  return null;
}

/* ---------------- links ---------------- */

// True when the label contains a tag/autolink that runs past the label's end.
function labelHasTag(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const c = RE_I_CODE.exec(label.slice(i));
      if (c) { i += c[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const r = full.slice(offset + i);
    const o = RE_I_TAG.exec(r) || RE_I_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - i) return true;
      i += o[0].length - 1;
    }
  }
  return false;
}

function trimEndBackslashes(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 92) n--;
  return s.slice(0, n);
}

// Build a link/image from a matched label + href/title, parsing the label text.
// Returns { raw, out } or null when the link is invalid (a link inside a link).
function makeLink(labelRaw, isImg, href, title, raw, ctx, plain, autolink) {
  const st = ctx.st;
  if (autolink) {
    if (plain) return { raw, out: labelRaw };
    const h = cleanUrl(href);
    if (h === null) return { raw, out: escFull(labelRaw) };
    return { raw, out: '<a href="' + escFull(h) + '">' + escFull(labelRaw) + '</a>' };
  }
  const savedInLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRaw;
  st.inLink = true; st.linkEmitted = false;
  const inner = inlineParse(labelRaw, ctx, isImg || plain);
  const innerHadLink = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImg) {
    if (innerHadLink) { st.inRaw = savedRaw; return null; }
    st.linkEmitted = true;
  }
  if (isImg) {
    if (plain) return { raw, out: inner };
    const h = cleanUrl(href);
    if (h === null) return { raw, out: escFull(inner) };
    let o = '<img src="' + esc(h) + '" alt="' + esc(inner) + '"';
    if (title) o += ' title="' + esc(title) + '"';
    return { raw, out: o + '>' };
  }
  if (plain) return { raw, out: inner };
  const h = cleanUrl(href);
  if (h === null) return { raw, out: inner };
  let o = '<a href="' + esc(h) + '"';
  if (title) o += ' title="' + esc(title) + '"';
  return { raw, out: o + '>' + inner + '</a>' };
}

function tryInlineLink(s, pos, ctx, plain) {
  if (!ctx.st.linkParenPossible) return null;
  RE_I_LINK_Y.lastIndex = pos;
  const m = RE_I_LINK_Y.exec(s);
  if (!m) return null;
  const isImg = m[0].charAt(0) === '!';
  const n = isImg ? 2 : 1;
  if (labelHasTag(s.slice(pos), m[1], n)) return null;
  let dest = m[2].trim();
  let raw = m[0];
  let titlePart = m[3];
  if (dest.charAt(0) === '<') {
    if (!RE_END_ANGLE.test(dest)) return null;
    const stripped = trimEndBackslashes(dest.slice(0, -1));
    if ((dest.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2]);
    if (bal === -2) return null;
    if (bal > -1) {
      const h = (isImg ? 5 : 4) + m[1].length + bal;
      dest = m[2].substring(0, bal).trim();
      raw = raw.substring(0, h).trim();
      titlePart = '';
    }
  }
  const r2 = trimEndBackslashes(raw.slice(0, -1));
  if ((raw.length - r2.length) % 2 === 0) return null;
  let href = dest.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  const title = titlePart ? titlePart.slice(1, -1).replace(RE_ANY_PUNCT, '$1') : '';
  href = href.replace(RE_ANY_PUNCT, '$1');
  return makeLink(m[1].replace(RE_OUTPUT_LINK_REPLACE, '$1'), isImg, href, title, raw, ctx, plain, false);
}

function tryRefLink(s, pos, ctx, plain) {
  RE_I_REFLINK_Y.lastIndex = pos;
  const m = RE_I_REFLINK_Y.exec(s) || (RE_I_NOLINK_Y.lastIndex = pos, RE_I_NOLINK_Y.exec(s));
  if (!m) return null;
  const isImg = m[0].charAt(0) === '!';
  const n = isImg ? 2 : 1;
  if (labelHasTag(s.slice(pos), m[1], n)) return null;
  const ref = ctx.refs.get(normLabel(m[2] || m[1]));
  if (!ref) return { raw: m[0].charAt(0), out: plain ? m[0].charAt(0) : m[0].charAt(0) };
  return makeLink(m[1].replace(RE_OUTPUT_LINK_REPLACE, '$1'), isImg, ref.href, ref.title, m[0], ctx, plain, false);
}

function tryUrl(s, pos, ctx, plain) {
  RE_I_URL_Y.lastIndex = pos;
  const m = RE_I_URL_Y.exec(s);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[0]; href = 'mailto:' + m[0]; }
  else {
    let t0 = m[0], prev;
    do { prev = t0; t0 = RE_I_BACKPEDAL.exec(t0)?.[0] ?? ''; } while (prev !== t0);
    text = t0;
    href = m[1] === 'www.' ? 'http://' + t0 : t0;
  }
  return makeLink(text, false, href, '', text, ctx, plain, true);
}

/* ---------------- text-run scanner ---------------- */

// End index of the text run starting at i in s (first char always consumed).
// A leading backtick run is consumed whole (marked's text token starts `+).
// Hand-rolled char scan: the old RE_STOP exec per run was a hot spot.
// Stops exactly where marked's inline text token stops: at \, <, [, `, *, _,
// ~, at '!' before '[', at '  \n', at a valid www./scheme/mailto:/xmpp:
// trigger, and at the start of an email local part before '@'.
function scanText(s, i) {
  const n = s.length;
  let j = i + 1;
  if (s.charCodeAt(i) === 96) { // backtick: consume the whole run
    while (j < n && s.charCodeAt(j) === 96) j++;
  }
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 || c === 60 || c === 91 || c === 96 || c === 42 || c === 95 || c === 126) return j;
    if (c === 33) { // '!': stop only before '['
      if (s.charCodeAt(j + 1) === 91) return j;
      j++; continue;
    }
    if (c === 32) { // space: hard break only if a run of >=2 spaces + \n + non-ws follows
      if (s.charCodeAt(j - 1) === 32) { j++; continue; } // continuation of a run already evaluated
      // j is the first space of the run (or the run started at i, where br already failed)
      let k = j;
      while (k < n && s.charCodeAt(k) === 32) k++;
      if (j > i && k - j >= 2 && s.charCodeAt(k) === 10) {
        RE_NON_WS_G.lastIndex = k + 1; // br's (?!\s*$): some non-ws must follow the \n
        if (RE_NON_WS_G.exec(s)) return j;
      }
      j++; continue;
    }
    if (c === 64) { // '@': backpedal to the email local-part start
      let r = j - 1;
      while (r >= 0 && isEmailLocalCode(s.charCodeAt(r))) r--;
      r++;
      return r > i ? r : i + 1;
    }
    if (c === 119 || c === 87) { // w/W: www.
      if (s.charCodeAt(j + 1) === 119 && s.charCodeAt(j + 2) === 119 && s.charCodeAt(j + 3) === 46) {
        const pc = s.charCodeAt(j - 1);
        if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 42 || pc === 95 || pc === 126 || pc === 40) return j;
      }
      j++; continue;
    }
    if (c === 109 || c === 77 || c === 120 || c === 88) { // m/M/x/X: mailto:/xmpp:
      if (s.startsWith('mailto:', j) || s.startsWith('xmpp:', j)) {
        if (!isAlnumCode(s.charCodeAt(j - 1))) return j;
      }
      j++; continue;
    }
    if (c === 104 || c === 72) { // h/H: http/https
      const c1 = s.charCodeAt(j + 1), c2 = s.charCodeAt(j + 2), c3 = s.charCodeAt(j + 3);
      if ((c1 === 116 || c1 === 84) && (c2 === 116 || c2 === 84) && (c3 === 112 || c3 === 80)) return j;
      j++; continue;
    }
    if (c === 102 || c === 70) { // f/F: ftp
      const c1 = s.charCodeAt(j + 1), c2 = s.charCodeAt(j + 2);
      if ((c1 === 116 || c1 === 84) && (c2 === 112 || c2 === 80)) return j;
      j++; continue;
    }
    j++;
  }
  return n;
}

/* ---------------- the inline parser ---------------- */

// Parse an inline string to HTML (plain=false) or to plain text (plain=true,
// the text-renderer used for image alt text). ctx carries refs + shared state.
function inlineParse(s, ctx, plain) {
  if (!s) return '';
  if (!RE_INLINE_TRIGGER.test(s)) return plain ? unescapeNum(s) : esc(unescapeNum(s));
  const savedParen = ctx.st.linkParenPossible;
  ctx.st.linkParenPossible = savedParen && s.includes(')');
  // The masked copy and closer table only feed emphasis/del, so they are
  // built only when the string can contain a delimiter (*, _ or ~).
  const hasEm = s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1;
  const masked = hasEm ? maskInline(s, ctx.refs) : s;
  const closers = hasEm ? lastClosers(masked) : { star: -1, under: -1, tilde: -1 };
  const st = ctx.st;
  let out = '', i = 0, prevChar = '';
  try {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      let m, consumed = 0;
      if (c === 92) { // backslash: escape, else hard break
        RE_I_ESCAPE_Y.lastIndex = i;
        if ((m = RE_I_ESCAPE_Y.exec(s))) {
          out += plain ? m[1] : esc(m[1]);
          consumed = m[0].length;
        } else {
          RE_I_BR_Y.lastIndex = i;
          if ((m = RE_I_BR_Y.exec(s))) {
            out += plain ? '' : '<br>';
            consumed = m[0].length;
          }
        }
      } else if (c === 60) { // '<': raw html tag, else autolink
        RE_I_TAG_Y.lastIndex = i;
        if ((m = RE_I_TAG_Y.exec(s))) {
          if (!st.inLink && RE_START_A.test(m[0])) st.inLink = true;
          else if (st.inLink && RE_END_A.test(m[0])) st.inLink = false;
          if (!st.inRaw && RE_START_PRE.test(m[0])) st.inRaw = true;
          else if (st.inRaw && RE_END_PRE.test(m[0])) st.inRaw = false;
          out += m[0];
          consumed = m[0].length;
        } else {
          RE_I_AUTOLINK_Y.lastIndex = i;
          if ((m = RE_I_AUTOLINK_Y.exec(s))) {
            const isEmail = m[2] === '@';
            const text = m[1], href = isEmail ? 'mailto:' + m[1] : m[1];
            const r = makeLink(text, false, href, '', m[0], ctx, plain, true);
            out += r.out;
            consumed = m[0].length;
          }
        }
      } else if (c === 91 || c === 33) { // '[' or '!': inline link, then ref link
        if ((m = tryInlineLink(s, i, ctx, plain))) {
          out += m.out;
          consumed = m.raw.length;
        } else if ((m = tryRefLink(s, i, ctx, plain))) {
          out += m.out;
          consumed = m.raw.length;
        }
      } else if (c === 42 || c === 95) { // '*' '_': emphasis
        const em = tryEmStrong(s, masked, i, closers, prevChar);
        if (em) {
          const inner = inlineParse(em.text, ctx, plain);
          out += plain ? inner : (em.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
          consumed = em.raw.length;
        }
      } else if (c === 96) { // '`': code span
        RE_I_CODE_Y.lastIndex = i;
        if ((m = RE_I_CODE_Y.exec(s))) {
          let code = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(code) && /^ /.test(code) && / $/.test(code)) code = code.substring(1, code.length - 1);
          out += plain ? code : '<code>' + escFull(code) + '</code>';
          consumed = m[0].length;
        }
      } else if (c === 126) { // '~': strikethrough
        const del = tryDel(s, masked, i, closers, prevChar);
        if (del) {
          const inner = inlineParse(del.text, ctx, plain);
          out += plain ? inner : '<del>' + inner + '</del>';
          consumed = del.raw.length;
        }
      } else if (c === 32) { // space: hard break
        RE_I_BR_Y.lastIndex = i;
        if ((m = RE_I_BR_Y.exec(s))) {
          out += plain ? '' : '<br>';
          consumed = m[0].length;
        }
      } else if (!st.inLink && isAlnumCode(c)) { // word char: extended autolink / email
        if ((m = tryUrl(s, i, ctx, plain))) {
          out += m.out;
          consumed = m.raw.length;
        }
      }
      if (!consumed) {
        // plain text run
        const end = scanText(s, i);
        const raw = s.slice(i, end);
        if (st.inRaw) out += raw;
        else if (plain) out += unescapeNum(raw);
        else out += esc(unescapeNum(raw));
        const lastCh = raw.charCodeAt(raw.length - 1);
        if (lastCh !== 95) prevChar = raw.charAt(raw.length - 1); // not '_' -> update
        consumed = end - i;
        i += consumed;
        continue;
      }
      prevChar = '';
      i += consumed;
    }
  } finally {
    ctx.st.linkParenPossible = savedParen;
  }
  return out;
}


/* ---------------- block parser ---------------- */

// Table cell splitter (marked's de()).
function splitTableRow(a, limit) {
  const t = a.replace(/\|/g, (m, o, str) => {
    let odd = false, p = o;
    while (--p >= 0 && str.charCodeAt(p) === 92) odd = !odd;
    return odd ? '|' : ' |';
  });
  const n = t.split(' |');
  if (!n[0].trim()) n.shift();
  if (n.length > 0 && !n[n.length - 1].trim()) n.pop();
  if (limit !== undefined) {
    if (n.length > limit) n.length = limit;
    else while (n.length < limit) n.push('');
  }
  for (let s = 0; s < n.length; s++) n[s] = n[s].trim().replace(/\\\|/g, '|');
  return n;
}

// Trim trailing characters equal to the given char code.
function trimEndCh(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

const RE_BEGIN_SPACE = /^\s+/;

// Fenced-code indent compensation (marked's Dt()).
function fenceDedent(full, content) {
  const m = RE_INDENT_CODE_COMP.exec(full);
  if (!m) return content;
  const ind = m[1].length;
  return content.split('\n').map(line => {
    const o = RE_BEGIN_SPACE.exec(line);
    if (!o) return line;
    return line.slice(Math.min(o[0].length, ind));
  }).join('\n');
}

// Cached per-indent block-start regexes. Marked's D() memoiser clamps the
// indent to n = max(0, min(3, R-1)): a marker at exactly the content indent
// is a nested construct (continuation), not a sibling break.
const _atCache = new Map();
function atRegexes(R) {
  const n = Math.max(0, Math.min(3, R - 1));
  let v = _atCache.get(n);
  if (!v) {
    v = { next: RE_NEXT_BULLET(n), hr: RE_HR_AT(n), fences: RE_FENCES_AT(n), heading: RE_HEADING_AT(n), html: RE_HTML_AT(n), bq: RE_BQ_AT(n) };
    _atCache.set(n, v);
  }
  return v;
}

function parseList(e, ctx) {
  const t = RE_LIST.exec(e);
  if (!t) return null;
  const n = e;
  let rest = e;
  const r = t[1].trim();
  const ordered = r.length > 1;
  const marker = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = RE_LIST_ITEM(marker);
  const list = { k: 'list', ordered, start: ordered ? +r.slice(0, -1) : 0, loose: false, items: [], raw: '' };
  let p = false;
  while (rest.length > 0) {
    let u = false, d = '';
    const it = itemRe.exec(rest);
    if (!it || RE_HR.test(rest)) break;
    const k = n.length - rest.length;
    rest = rest.slice(it[0].length);
    const g = it[2].split('\n', 1)[0];
    const b = it[1].length;
    let m = g.replace(RE_LEADING_SPACE_TAB, v => expandTabs(v, b));
    let f = rest.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(RE_NON_SPACE);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    if (y && RE_BLANK_LINE.test(f)) {
      rest = rest.slice(f.length + 1);
      u = true;
    }
    if (!u) {
      const at = atRegexes(R);
      while (rest.length > 0) {
        const U = rest.split('\n', 1)[0];
        f = U;
        const Z = f.replace(RE_LEADING_SPACE_TAB, me => expandTabs(me, 0));
        if (at.fences.test(f) || at.heading.test(f) || at.html.test(f) || at.bq.test(f) || at.next.test(f) || at.hr.test(f)) break;
        if (Z.search(RE_NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(/\t/g, '    ').search(RE_NON_SPACE) >= 4 || at.fences.test(m) || at.heading.test(m) || at.html.test(m) || at.hr.test(m)) break;
          const qe = RE_SETEXT_LINE.test(f) && RE_LHEADING.test(m + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        rest = rest.slice(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, n.length - rest.length);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (RE_DOUBLE_BLANK.test(A)) p = true;
    }
    list.items.push({ raw: A, task: RE_LIST_IS_TASK.test(d), text: d, nodes: null, checkbox: undefined });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = n.slice(0, n.length - rest.length).trimEnd();
  for (const item of list.items) {
    const sub = parseBlocks(item.text, false, ctx);
    item.nodes = sub.nodes;
    if (!list.loose && sub.blankRun) list.loose = true;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const nd of item.nodes) if (nd.k === 'x') nd.k = 'p';
    }
  }
  for (const item of list.items) {
    if (!item.task) continue;
    const first = item.nodes[0];
    if (!first || (first.k !== 'x' && first.k !== 'p')) { item.task = false; continue; }
    item.text = item.text.replace(RE_LIST_REPLACE_TASK, '');
    first.t = first.t.replace(RE_LIST_REPLACE_TASK, '');
    const ck = RE_LIST_TASK_CHECKBOX.exec(item.raw);
    if (ck) item.checkbox = ck[0] !== '[ ]';
  }
  return { node: list, rawLen: list.raw.length };
}

function parseBlockquote(e, ctx) {
  const t = RE_BLOCKQUOTE.exec(e);
  if (!t) return null;
  let lines = trimEndNL(t[0]).split('\n');
  let s = '', r = '';
  const nodes = [];
  while (lines.length > 0) {
    let started = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); started = true; }
      else if (!started) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(RE_BQ_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
               .replace(RE_BQ_SETEXT, '\n    $1')
               .replace(RE_BQ_STRIP, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    // Re-parse the chunk into the shared node list; the first paragraph of
    // each chunk merges into a preceding paragraph (lazy continuation).
    parseBlocks(u, true, ctx, true, nodes);
    if (lines.length === 0) break;
    const k = nodes[nodes.length - 1];
    if (k && (k.k === 'code' || k.k === 'h' || k.k === 'hr' || k.k === 'html' || k.k === 'table')) break;
    if (k && k.k === 'bq') {
      const b = lines.join('\n');
      const m2 = k.raw + '\n' + b.replace(RE_BQ_STRIP, '');
      const f = parseBlockquote(m2, ctx);
      if (!f) break;
      nodes[nodes.length - 1] = f.node;
      const y = m2.substring(f.rawLen).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - k.text.length) + f.node.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (k && k.k === 'list') {
      const b = k.raw + '\n' + lines.join('\n');
      const m2 = parseList(b, ctx);
      if (!m2) break;
      nodes[nodes.length - 1] = m2.node;
      const f = m2.rawLen > k.raw.length ? b.slice(k.raw.length + 1, m2.rawLen).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { node: { k: 'bq', nodes, text: r, raw: s }, rawLen: s.length };
}

function parseTable(e, ctx) {
  const t = RE_TABLE.exec(e);
  if (!t || !RE_TABLE_DELIMITER.test(t[2])) return null;
  const headerCells = splitTableRow(t[1]);
  const delimCells = t[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
  if (headerCells.length !== delimCells.length) return null;
  const aligns = delimCells.map(c => RE_TABLE_ALIGN_RIGHT.test(c) ? 'right' : RE_TABLE_ALIGN_CENTER.test(c) ? 'center' : RE_TABLE_ALIGN_LEFT.test(c) ? 'left' : null);
  const rows = t[3] && t[3].trim() ? t[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  const header = headerCells.map((c, i) => ({ text: c, align: aligns[i] }));
  const body = rows.map(r => splitTableRow(r, headerCells.length).map((c, i) => ({ text: c, align: aligns[i] })));
  return { node: { k: 'table', header, body }, rawLen: trimEndNL(t[0]).length };
}

// Block parser. top: paragraphs are real paragraphs (else text nodes).
// mergePara: the first paragraph of this call merges into a preceding
// paragraph (blockquote lazy continuation; consumed after the first one).
// out: node list to append to (shared across blockquote chunks).
// Returns { nodes, blankRun } where blankRun means a >=2-newline run was seen.
function parseBlocks(src, top, ctx, mergePara, out) {
  const nodes = out || [];
  let rest = src;
  let blankRun = false;
  let blankGap = false; // a blank line (space token) has intervened since the last node
  let merge = !!mergePara;
  while (rest.length > 0) {
    const sp = RE_NEWLINE.exec(rest);
    if (sp) {
      const first = sp[0].indexOf('\n');
      if (first !== -1 && sp[0].indexOf('\n', first + 1) !== -1) blankRun = true;
      if (sp[0].length > 1) blankGap = true;
      rest = rest.slice(sp[0].length);
      continue;
    }
    let c0 = rest.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      let col = 0, i = 0;
      while (i < rest.length) {
        const c = rest.charCodeAt(i);
        if (c === 32) { col++; i++; }
        else if (c === 9) { col += 4 - (col % 4); i++; }
        else break;
      }
      if (col >= 4) {
        const cd = RE_CODE.exec(rest);
        if (cd) {
          const raw = trimHtmlBlock(cd[0]);
          const codeText = raw.replace(RE_CODE_REMOVE_INDENT, '');
          const prev = nodes[nodes.length - 1];
          if (!blankGap && prev && (prev.k === 'p' || prev.k === 'x')) {
            prev.t += '\n' + codeText; // indented code merges into a paragraph
          } else {
            nodes.push({ k: 'code', t: codeText, lang: '' });
          }
          blankGap = false;
          rest = rest.slice(raw.length);
          continue;
        }
      }
      c0 = i < rest.length ? rest.charCodeAt(i) : -1;
    }
    let node = null, consumed = 0;
    if (c0 === 96 || c0 === 126) { // ` ~
      const f = RE_FENCES.exec(rest);
      if (f) {
        const info = f[2] ? f[2].trim().replace(RE_ANY_PUNCT, '$1') : '';
        const lang = info ? info.match(/^\S*/)[0] : '';
        node = { k: 'code', t: fenceDedent(f[0], f[3] || ''), lang };
        consumed = f[0].length;
      }
    }
    if (!node && c0 === 35) { // #
      const h = RE_HEADING.exec(rest);
      if (h) {
        let txt = h[2].trim();
        if (/#$/.test(txt)) {
          const s = trimEndCh(txt, 35);
          if (!s || /[ \t]$/.test(s)) txt = s.trim();
        }
        node = { k: 'h', d: h[1].length, t: txt };
        consumed = trimEndNL(h[0]).length;
      }
    }
    if (!node && c0 === 62) { // >
      const b = parseBlockquote(rest, ctx);
      if (b) { node = b.node; consumed = b.rawLen; }
    }
    if (!node && (c0 === 45 || c0 === 43 || c0 === 42 || c0 === 95)) { // - + * _
      const hr = RE_HR.exec(rest);
      if (hr) { node = { k: 'hr' }; consumed = trimEndNL(hr[0]).length; }
      else {
        const l = parseList(rest, ctx);
        if (l) { node = l.node; consumed = l.rawLen; }
      }
    }
    if (!node && c0 === 60) { // <
      const h = RE_HTML.exec(rest);
      if (h) {
        const raw = trimHtmlBlock(h[0]);
        node = { k: 'html', t: raw };
        consumed = raw.length;
      }
    }
    if (!node && c0 === 91) { // [
      const d = RE_DEF.exec(rest);
      if (d && (RE_START_ANGLE.test(d[2]) || parenBalance(d[2]) === -1)) {
        const defRaw = trimEndNL(d[0]);
        const prev = nodes[nodes.length - 1];
        if (!blankGap && prev && (prev.k === 'p' || prev.k === 'x')) {
          prev.t += '\n' + defRaw; // def merges into a directly-following paragraph
        } else {
          const tag = normLabel(d[1]);
          if (!ctx.refs.has(tag)) {
            const href = d[2] ? d[2].replace(RE_HREF_BRACKETS, '$1').replace(RE_ANY_PUNCT, '$1') : '';
            const title = d[3] ? d[3].substring(1, d[3].length - 1).replace(RE_ANY_PUNCT, '$1') : d[3];
            ctx.refs.set(tag, { href, title });
          }
          blankGap = true; // a registered def breaks the merge chain
        }
        rest = rest.slice(defRaw.length);
        continue;
      }
    }
    if (!node && c0 >= 48 && c0 <= 57) { // digit
      const l = parseList(rest, ctx);
      if (l) { node = l.node; consumed = l.rawLen; }
    }
    if (!node) {
      const tb = parseTable(rest, ctx);
      if (tb) { node = tb.node; consumed = tb.rawLen; }
    }
    if (!node) {
      const lh = RE_LHEADING.exec(rest);
      if (lh) {
        node = { k: 'h', d: lh[2].charAt(0) === '=' ? 1 : 2, t: lh[1].trim() };
        consumed = trimEndNL(lh[0]).length;
      }
    }
    if (!node) {
      if (top) {
        const p = RE_PARAGRAPH.exec(rest);
        if (p) {
          let txt = p[1];
          if (txt.charCodeAt(txt.length - 1) === 10) txt = txt.slice(0, -1);
          const prev = nodes[nodes.length - 1];
          if (merge && !blankGap && prev && prev.k === 'p') {
            prev.t += '\n' + txt; // lazy continuation across blockquote chunks
          } else {
            nodes.push({ k: 'p', t: txt });
          }
          merge = false;
          blankGap = false;
          rest = rest.slice(p[0].length);
          continue;
        }
      } else {
        const tx = RE_TEXT.exec(rest);
        if (tx) {
          const prev = nodes[nodes.length - 1];
          if (!blankGap && prev && prev.k === 'x') {
            prev.t += '\n' + tx[0]; // consecutive text lines merge
          } else {
            nodes.push({ k: 'x', t: tx[0] });
          }
          blankGap = false;
          rest = rest.slice(tx[0].length);
          continue;
        }
      }
    }
    if (!node) { rest = rest.slice(1); continue; } // safety: never spin
    nodes.push(node);
    blankGap = false;
    rest = rest.slice(consumed);
  }
  return { nodes, blankRun };
}

/* ---------------- renderer ---------------- */

// Inline-parse one block's text. inRaw resets per block (marked's queue loop);
// inLink / linkEmitted deliberately persist across blocks.
function inlineStr(t, ctx) {
  ctx.st.inRaw = false;
  return inlineParse(t, ctx, false);
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderNode(nd, ctx, checkbox) {
  switch (nd.k) {
    case 'p': return '<p>' + (checkbox || '') + inlineStr(nd.t, ctx) + '</p>\n';
    case 'x': return inlineStr(nd.t, ctx);
    case 'h': return '<h' + nd.d + '>' + inlineStr(nd.t, ctx) + '</h' + nd.d + '>\n';
    case 'hr': return '<hr>\n';
    case 'code': {
      const r = nd.t ? nd.t.replace(/\n$/, '') + '\n' : '';
      return nd.lang
        ? '<pre><code class="language-' + esc(nd.lang) + '">' + escFull(r) + '</code></pre>\n'
        : '<pre><code>' + escFull(r) + '</code></pre>\n';
    }
    case 'html': return nd.t;
    case 'bq': return '<blockquote>\n' + renderBlocks(nd.nodes, ctx) + '</blockquote>\n';
    case 'list': {
      const tag = nd.ordered ? 'ol' : 'ul';
      const start = nd.ordered && nd.start !== 1 ? ' start="' + nd.start + '"' : '';
      let s = '<' + tag + start + '>\n';
      for (const it of nd.items) s += renderListItem(it, ctx);
      return s + '</' + tag + '>\n';
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (const c of nd.header) s += renderTableCell(c, true, ctx);
      s += '</tr>\n</thead>\n';
      if (nd.body.length > 0) {
        s += '<tbody>';
        for (const row of nd.body) {
          s += '<tr>\n';
          for (const c of row) s += renderTableCell(c, false, ctx);
          s += '</tr>\n';
        }
        s += '</tbody>';
      }
      return s + '</table>\n';
    }
  }
  return '';
}

function renderTableCell(c, isHeader, ctx) {
  const tag = isHeader ? 'th' : 'td';
  return (c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>') + inlineStr(c.text, ctx) + '</' + tag + '>\n';
}

function renderListItem(item, ctx) {
  let s = '<li>';
  const nodes = item.nodes;
  if (item.checkbox !== undefined) {
    const cb = checkboxHtml(item.checkbox);
    if (item.loose && nodes.length > 0 && (nodes[0].k === 'p' || nodes[0].k === 'x')) {
      // loose list: checkbox goes inside the first paragraph
      s += renderNode(nodes[0], ctx, cb);
      for (let j = 1; j < nodes.length; j++) s += renderNode(nodes[j], ctx);
    } else if (item.loose) {
      // loose list, first block is not a paragraph: checkbox gets its own paragraph
      s += '<p>' + cb + '</p>\n';
      for (const nd of nodes) s += renderNode(nd, ctx);
    } else {
      // tight list: checkbox is a standalone token before the content
      s += cb;
      for (const nd of nodes) s += renderNode(nd, ctx);
    }
  } else {
    for (const nd of nodes) s += renderNode(nd, ctx);
  }
  return s + '</li>\n';
}

function renderBlocks(nodes, ctx) {
  let out = '';
  for (const nd of nodes) out += renderNode(nd, ctx);
  return out;
}

/* ---------------- public entry point ---------------- */

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const ctx = { refs: new Map(), st: { inLink: false, inRaw: false, linkEmitted: false, linkParenPossible: true } };
  const { nodes } = parseBlocks(src, true, ctx);
  return renderBlocks(nodes, ctx);
}
