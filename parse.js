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

function tryEmStrong(rem, masked, pos, closers, prevChar) {
  const m = RE_I_EM_L.exec(rem);
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
    const M = rem.slice(0, k + s2.index + te + b);
    if (Math.min(k, b) % 2) return { raw: M, text: M.slice(1, -1), strong: false };
    return { raw: M, text: M.slice(2, -2), strong: true };
  }
  return null;
}

function tryDel(rem, masked, pos, closers, prevChar) {
  const m = RE_I_DEL_L.exec(rem);
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
    const raw = rem.slice(0, o + s2.index + te + l);
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

function tryInlineLink(rem, full, pos, ctx, plain) {
  if (!ctx.st.linkParenPossible) return null;
  const m = RE_I_LINK.exec(rem);
  if (!m) return null;
  const isImg = m[0].charAt(0) === '!';
  const n = isImg ? 2 : 1;
  if (labelHasTag(full.slice(pos), m[1], n)) return null;
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

function tryRefLink(rem, full, pos, ctx, plain) {
  const m = RE_I_REFLINK.exec(rem) || RE_I_NOLINK.exec(rem);
  if (!m) return null;
  const isImg = m[0].charAt(0) === '!';
  const n = isImg ? 2 : 1;
  if (labelHasTag(full.slice(pos), m[1], n)) return null;
  const ref = ctx.refs.get(normLabel(m[2] || m[1]));
  if (!ref) return { raw: m[0].charAt(0), out: plain ? m[0].charAt(0) : m[0].charAt(0) };
  return makeLink(m[1].replace(RE_OUTPUT_LINK_REPLACE, '$1'), isImg, ref.href, ref.title, m[0], ctx, plain, false);
}

function tryUrl(rem, ctx, plain) {
  const m = RE_I_URL.exec(rem);
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
function scanText(s, i) {
  const n = s.length;
  RE_STOP.lastIndex = i + 1;
  let m;
  while ((m = RE_STOP.exec(s)) !== null) {
    const k = m.index, c = m[0];
    if (c.charCodeAt(0) === 32) return k; // '  \n' hard-break lead-in
    if (c === '@') {
      let r = k - 1;
      while (r >= 0 && isEmailLocalCode(s.charCodeAt(r))) r--;
      r++;
      return r > i ? r : i + 1;
    }
    if (c === 'www.') {
      if (k > i) {
        const pc = s.charCodeAt(k - 1);
        if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 42 || pc === 95 || pc === 126 || pc === 40) return k;
      }
      RE_STOP.lastIndex = k + 1;
      continue;
    }
    if (c === 'mailto:' || c === 'xmpp:') {
      if (k > i && !isAlnumCode(s.charCodeAt(k - 1))) return k;
      RE_STOP.lastIndex = k + 1;
      continue;
    }
    const lc = c.charCodeAt(0);
    if (lc === 104 || lc === 72 || lc === 102 || lc === 70) { // h/H/f/F: http/https/ftp
      if (k > i) return k;
      RE_STOP.lastIndex = k + 1;
      continue;
    }
    if (c === '!') {
      if (s[k + 1] === '[') return k;
      RE_STOP.lastIndex = k + 1;
      continue;
    }
    return k; // \, <, [, `, *, ~, _
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
  const masked = maskInline(s, ctx.refs);
  const closers = lastClosers(masked);
  const st = ctx.st;
  let out = '', i = 0, prevChar = '';
  try {
    while (i < s.length) {
      const rem = s.slice(i);
      let m, consumed = 0;
      if ((m = RE_I_ESCAPE.exec(rem))) {
        out += plain ? m[1] : esc(m[1]);
        consumed = m[0].length;
      } else if ((m = RE_I_TAG.exec(rem))) {
        if (!st.inLink && RE_START_A.test(m[0])) st.inLink = true;
        else if (st.inLink && RE_END_A.test(m[0])) st.inLink = false;
        if (!st.inRaw && RE_START_PRE.test(m[0])) st.inRaw = true;
        else if (st.inRaw && RE_END_PRE.test(m[0])) st.inRaw = false;
        out += m[0];
        consumed = m[0].length;
      } else if ((m = tryInlineLink(rem, s, i, ctx, plain))) {
        out += m.out;
        consumed = m.raw.length;
      } else if ((m = tryRefLink(rem, s, i, ctx, plain))) {
        out += m.out;
        consumed = m.raw.length;
      } else {
        const em = tryEmStrong(rem, masked, i, closers, prevChar);
        if (em) {
          const inner = inlineParse(em.text, ctx, plain);
          out += plain ? inner : (em.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
          consumed = em.raw.length;
        } else if ((m = RE_I_CODE.exec(rem))) {
          let code = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(code) && /^ /.test(code) && / $/.test(code)) code = code.substring(1, code.length - 1);
          out += plain ? code : '<code>' + escFull(code) + '</code>';
          consumed = m[0].length;
        } else if ((m = RE_I_BR.exec(rem))) {
          out += plain ? '' : '<br>';
          consumed = m[0].length;
        } else {
          const del = tryDel(rem, masked, i, closers, prevChar);
          if (del) {
            const inner = inlineParse(del.text, ctx, plain);
            out += plain ? inner : '<del>' + inner + '</del>';
            consumed = del.raw.length;
          } else if ((m = RE_I_AUTOLINK.exec(rem))) {
            const isEmail = m[2] === '@';
            const text = m[1], href = isEmail ? 'mailto:' + m[1] : m[1];
            const r = makeLink(text, false, href, '', m[0], ctx, plain, true);
            out += r.out;
            consumed = m[0].length;
          } else if (!st.inLink && (m = tryUrl(rem, ctx, plain))) {
            out += m.out;
            consumed = m.raw.length;
          } else {
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
        }
      }
      prevChar = '';
      i += consumed;
    }
  } finally {
    ctx.st.linkParenPossible = savedParen;
  }
  return out;
}
