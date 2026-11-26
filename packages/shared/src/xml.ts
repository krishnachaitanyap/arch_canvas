/**
 * A small XML reader, enough for draw.io / mxGraph files, that runs the same in the browser
 * and in Node (no DOMParser needed). Handles attributes, nesting, comments, CDATA, text and
 * entities; ignores processing instructions and doctypes.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      i = end(src, "-->", lt) + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const close = end(src, "]]>", lt);
      top().text += src.slice(lt + 9, close);
      i = close + 3;
    } else if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      i = end(src, ">", lt) + 1;
    } else if (src[lt + 1] === "/") {
      const close = end(src, ">", lt);
      const name = src.slice(lt + 2, close).trim();
      // Pop to the matching element; tolerate small nesting mistakes.
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      i = close + 1;
    } else {
      const { el, selfClosing, next } = readTag(src, lt);
      top().children.push(el);
      if (!selfClosing) stack.push(el);
      i = next;
    }
  }
  return root;
}

function readTag(src: string, lt: number): { el: XmlElement; selfClosing: boolean; next: number } {
  let i = lt + 1;
  const nameStart = i;
  while (i < src.length && !/[\s/>]/.test(src[i])) i++;
  const el: XmlElement = { name: src.slice(nameStart, i), attrs: {}, children: [], text: "" };
  for (;;) {
    while (/\s/.test(src[i] ?? "")) i++;
    if (src[i] === ">") return { el, selfClosing: false, next: i + 1 };
    if (src[i] === "/" && src[i + 1] === ">") return { el, selfClosing: true, next: i + 2 };
    if (i >= src.length) throw new Error("Unexpected end of XML inside a tag");
    const ks = i;
    while (i < src.length && !/[\s=/>]/.test(src[i])) i++;
    const key = src.slice(ks, i);
    while (/\s/.test(src[i] ?? "")) i++;
    if (src[i] !== "=") {
      if (key) el.attrs[key] = "";
      if (!key) i++;
      continue;
    }
    i++;
    while (/\s/.test(src[i] ?? "")) i++;
    const q = src[i];
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, i + 1);
      if (close < 0) throw new Error("Unterminated attribute value in XML");
      el.attrs[key] = decodeEntities(src.slice(i + 1, close));
      i = close + 1;
    } else {
      const vs = i;
      while (i < src.length && !/[\s>]/.test(src[i])) i++;
      el.attrs[key] = decodeEntities(src.slice(vs, i));
    }
  }
}

function end(src: string, token: string, from: number): number {
  const at = src.indexOf(token, from);
  if (at < 0) throw new Error(`Unexpected end of XML (expected ${token})`);
  return at;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function findAll(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** Plain text from an HTML label: line breaks kept, tags dropped, entities decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
