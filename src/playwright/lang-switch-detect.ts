/**
 * Detect text segments in a different language than the document's
 * declared lang, missing a `<… lang="…">` switch (WCAG 3.1.2 Language
 * of Parts).
 *
 * Approach: small per-language word dictionaries (the most common
 * function words / short tokens). For each block-level text node,
 * tokenize, count per-language matches, score the dominant language
 * by ratio. If the dominant language has high enough confidence and
 * differs from the document's html lang, flag.
 *
 * v1 covers only Latin-script languages with distinctive function
 * words (French, German, Spanish, Italian, Portuguese, Dutch). CJK,
 * Arabic, Hebrew, etc. would need different detection (script-based,
 * not word-based) and are deferred. Even within Latin-script
 * languages, false positives are possible on technical jargon and
 * brand names — diagnostic explicitly tags as a heuristic.
 */

import type { Page } from "playwright";

const DICTS: Record<string, string[]> = {
  fr: [
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "mais", "donc",
    "dans", "pour", "avec", "sans", "sur", "sous", "vers", "chez", "par",
    "est", "sont", "était", "étaient", "sera", "seront", "avoir", "être", "faire",
    "plus", "tout", "tous", "toute", "toutes", "comme", "aussi", "déjà", "encore",
    "très", "bien", "peu", "beaucoup", "ici", "là", "où", "qui", "que", "quoi",
    "dont", "quand", "comment", "pourquoi", "parce", "alors", "puis", "ensuite",
    "ainsi", "même", "autre", "autres", "leur", "leurs", "notre", "votre",
  ],
  de: [
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einer",
    "und", "oder", "aber", "denn", "doch", "auch", "noch", "schon", "nur",
    "sehr", "hier", "dort", "wo", "wer", "was", "wie", "wann", "warum", "weil",
    "in", "an", "auf", "mit", "von", "zu", "bei", "nach", "vor", "über",
    "ist", "sind", "war", "waren", "wird", "werden", "haben", "hat", "habe",
    "sein", "machen", "können", "müssen", "sollen", "wollen", "dürfen",
    "alle", "alles", "auch", "schon", "noch", "mehr", "anderen",
  ],
  es: [
    "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "pero",
    "porque", "como", "también", "ya", "aún", "más", "menos", "muy", "mucho",
    "todo", "todos", "toda", "todas", "otro", "otra", "este", "esta", "estos",
    "en", "de", "con", "sin", "por", "para", "sobre", "bajo", "hasta", "desde",
    "es", "son", "era", "eran", "será", "serán", "tener", "ser", "hacer",
    "que", "cual", "quien", "donde", "cuando", "cómo", "por", "qué",
    "aquí", "allí", "ahora", "después", "antes", "entonces", "siempre",
  ],
  it: [
    "il", "la", "lo", "gli", "le", "un", "una", "uno", "e", "o", "ma", "perché",
    "in", "di", "da", "per", "con", "su", "tra", "fra", "verso", "presso",
    "è", "sono", "era", "erano", "sarà", "saranno", "avere", "essere", "fare",
    "più", "meno", "molto", "tutto", "tutti", "tutta", "tutte", "altro", "altra",
    "come", "anche", "già", "ancora", "sempre", "mai", "qui", "lì", "dove",
    "quando", "perché", "che", "chi", "cui", "questo", "questa", "questi",
  ],
  pt: [
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "e", "ou", "mas", "porque",
    "em", "de", "para", "com", "sem", "por", "sobre", "entre", "até", "desde",
    "é", "são", "era", "eram", "será", "serão", "ter", "ser", "fazer", "estar",
    "mais", "menos", "muito", "tudo", "todo", "todos", "toda", "todas",
    "como", "também", "já", "ainda", "sempre", "nunca", "aqui", "ali",
    "onde", "quando", "porque", "que", "quem", "qual",
  ],
  nl: [
    "de", "het", "een", "en", "of", "maar", "want", "dus", "toch", "niet",
    "in", "op", "aan", "met", "van", "voor", "door", "tot", "bij", "uit",
    "is", "zijn", "was", "waren", "wordt", "worden", "hebben", "heb", "had",
    "ook", "nog", "al", "hier", "daar", "waar", "wie", "wat", "hoe",
    "wanneer", "waarom", "omdat", "altijd", "nooit", "alle", "andere", "deze",
  ],
  en: [
    "the", "a", "an", "and", "or", "but", "because", "if", "when", "while",
    "in", "on", "at", "to", "for", "with", "from", "of", "by", "about",
    "is", "are", "was", "were", "be", "been", "have", "has", "had", "do",
    "this", "that", "these", "those", "all", "any", "some", "no", "not",
    "more", "less", "most", "least", "very", "much", "many", "also", "only",
    "here", "there", "where", "when", "how", "why", "which", "who", "whose",
  ],
};

const SCAN_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, td";
const MIN_TOKENS_FOR_DETECTION = 6;
const DOMINANT_LANGUAGE_THRESHOLD = 0.4; // 40% of recognized words must match

/**
 * Unicode-script detection for non-Latin alphabets — used as a coarse
 * lang-switch signal where the word-dictionary approach can't help
 * (CJK languages don't have function-word tokenization the same way,
 * and Arabic/Hebrew use a wholly different script).
 *
 * Block must contain >= 60% characters from one script (excluding
 * whitespace/punct) AND that script must not match the inherited lang
 * to count.
 */
const SCRIPT_TO_LANG: Array<{ name: string; lang: string; ranges: Array<[number, number]> }> = [
  // CJK — Han ideographs are shared across zh/ja/ko, but Hiragana +
  // Katakana are JA-only and Hangul is KO-only, so we treat presence
  // of those as a strong signal.
  {
    name: "Hiragana/Katakana",
    lang: "ja",
    ranges: [
      [0x3040, 0x309f], // Hiragana
      [0x30a0, 0x30ff], // Katakana
    ],
  },
  {
    name: "Hangul",
    lang: "ko",
    ranges: [
      [0xac00, 0xd7af], // Hangul Syllables
      [0x1100, 0x11ff], // Hangul Jamo
    ],
  },
  {
    name: "CJK Han",
    lang: "zh",
    ranges: [
      [0x4e00, 0x9fff], // CJK Unified Ideographs
      [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
    ],
  },
  {
    name: "Arabic",
    lang: "ar",
    ranges: [
      [0x0600, 0x06ff], // Arabic
      [0x0750, 0x077f], // Arabic Supplement
      [0xfb50, 0xfdff], // Arabic Presentation Forms-A
      [0xfe70, 0xfeff], // Arabic Presentation Forms-B
    ],
  },
  {
    name: "Hebrew",
    lang: "he",
    ranges: [[0x0590, 0x05ff]],
  },
  {
    name: "Cyrillic",
    lang: "ru",
    ranges: [
      [0x0400, 0x04ff],
      [0x0500, 0x052f],
    ],
  },
  {
    name: "Devanagari",
    lang: "hi",
    ranges: [[0x0900, 0x097f]],
  },
  {
    name: "Thai",
    lang: "th",
    ranges: [[0x0e00, 0x0e7f]],
  },
];

export interface LangSwitchSummary {
  /** The page's html lang (or "" if unset). */
  pageLang: string;
  /** Suspect blocks: text where dominant language appears to differ. */
  suspects: Array<{
    detectedLang: string;
    confidence: number;
    sample: string;
  }>;
}

export async function detectLangSwitches(page: Page): Promise<LangSwitchSummary> {
  return page
    .evaluate(
      ({
        dicts,
        blockSelector,
        minTokens,
        dominantThreshold,
        scriptDefs,
      }: {
        dicts: Record<string, string[]>;
        blockSelector: string;
        minTokens: number;
        dominantThreshold: number;
        scriptDefs: Array<{ name: string; lang: string; ranges: Array<[number, number]> }>;
      }) => {
        const dictSets: Record<string, Set<string>> = {};
        for (const [lang, words] of Object.entries(dicts)) {
          dictSets[lang] = new Set(words);
        }
        const pageLang = (document.documentElement.getAttribute("lang") ?? "")
          .trim()
          .toLowerCase()
          .split("-")[0];
        const suspects: Array<{ detectedLang: string; confidence: number; sample: string }> = [];

        const blocks = document.querySelectorAll(blockSelector);
        const SCAN_CAP = 500;
        for (let i = 0; i < blocks.length && i < SCAN_CAP && suspects.length < 10; i++) {
          const el = blocks[i];
          // Skip if the block has its own lang= attribute — author already
          // labelled the language switch correctly.
          if (el.hasAttribute("lang")) continue;
          // Walk up to see if any ancestor has lang= matching a non-page lang.
          let ancestor: Element | null = el.parentElement;
          let inheritedLang = pageLang;
          while (ancestor) {
            const a = ancestor.getAttribute("lang");
            if (a) {
              inheritedLang = a.trim().toLowerCase().split("-")[0];
              break;
            }
            ancestor = ancestor.parentElement;
          }

          const text = (el.textContent ?? "").trim();
          if (text.length < 20) continue;

          // Script-based detection FIRST — handles non-Latin scripts
          // where the word-dictionary approach can't help.
          const scriptHits: Record<string, number> = {};
          let scriptedCharCount = 0;
          for (let c = 0; c < text.length; c++) {
            const code = text.charCodeAt(c);
            for (const def of scriptDefs) {
              for (const [lo, hi] of def.ranges) {
                if (code >= lo && code <= hi) {
                  scriptHits[def.lang] = (scriptHits[def.lang] || 0) + 1;
                  scriptedCharCount++;
                  break;
                }
              }
            }
          }
          if (scriptedCharCount > text.length * 0.6) {
            // Dominantly non-Latin — pick the script with the most chars
            let bestScriptLang = "";
            let bestScriptCount = 0;
            for (const [lang, count] of Object.entries(scriptHits)) {
              if (count > bestScriptCount) {
                bestScriptLang = lang;
                bestScriptCount = count;
              }
            }
            if (bestScriptLang && bestScriptLang !== inheritedLang) {
              const sample = text.length > 80 ? text.slice(0, 77) + "…" : text;
              suspects.push({
                detectedLang: bestScriptLang,
                confidence: bestScriptCount / scriptedCharCount,
                sample,
              });
            }
            continue;
          }

          const tokens = text
            .toLowerCase()
            .replace(/[^\p{L}\s']+/gu, " ")
            .split(/\s+/)
            .filter((t) => t.length >= 2);
          if (tokens.length < minTokens) continue;

          // Count per-language matches
          const counts: Record<string, number> = {};
          for (const lang of Object.keys(dictSets)) counts[lang] = 0;
          let totalMatched = 0;
          for (const token of tokens) {
            for (const [lang, set] of Object.entries(dictSets)) {
              if (set.has(token)) {
                counts[lang]++;
                totalMatched++;
              }
            }
          }
          if (totalMatched < minTokens) continue;

          // Pick dominant language by share of matched
          let bestLang = "";
          let bestCount = 0;
          for (const [lang, count] of Object.entries(counts)) {
            if (count > bestCount) {
              bestCount = count;
              bestLang = lang;
            }
          }
          const confidence = totalMatched > 0 ? bestCount / totalMatched : 0;
          if (confidence < dominantThreshold) continue;

          // Flag if the dominant language differs from inherited
          if (bestLang && bestLang !== inheritedLang) {
            const sample = text.length > 80 ? text.slice(0, 77) + "…" : text;
            suspects.push({ detectedLang: bestLang, confidence, sample });
          }
        }

        return { pageLang, suspects };
      },
      {
        dicts: DICTS,
        blockSelector: SCAN_BLOCK_SELECTOR,
        minTokens: MIN_TOKENS_FOR_DETECTION,
        dominantThreshold: DOMINANT_LANGUAGE_THRESHOLD,
        scriptDefs: SCRIPT_TO_LANG,
      },
    )
    .catch(() => ({ pageLang: "", suspects: [] }) as LangSwitchSummary);
}
