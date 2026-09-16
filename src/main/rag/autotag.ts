import type { DocType } from '../../shared/types.js';

/**
 * Deterministic doc-type guessing (TASK-023, FR-064).
 *
 * Not an LLM call. The guess runs on every import and on every adopted file, so
 * an LLM here would put a network round trip and a per-document cost on the
 * ingestion path, and would make the result unreproducible. The rule set below
 * is the whole algorithm and it is scored, not first-match: a file named
 * `notes.md` whose body is plainly a resume should not be tagged from its
 * uninformative name.
 *
 * ## The rule set
 *
 * Every rule contributes its weight to one doc type. The highest total wins.
 *
 * | Signal | Weight | Why |
 * |---|---|---|
 * | Filename matches a type's filename pattern | 10 | The user named the file, so it is the strongest single signal |
 * | A heading matches a type's heading pattern | 4 | Structure the author chose, stronger than prose |
 * | A body phrase matches a type's body pattern | 1 each, capped at 6 | Weak individually, meaningful in aggregate |
 *
 * Ties, including the all-zero case of a document that matches nothing, resolve
 * in {@link TIE_BREAK_ORDER}. `company-notes` wins a tie because it is the
 * catch-all of the three: a miscategorized note costs a retrieval the user can
 * fix with one override, while defaulting to `resume` would put arbitrary text
 * where the prompt expects the candidate's own history.
 */

/** Lowest-risk first. Applied when two or more types reach the same score. */
export const TIE_BREAK_ORDER: DocType[] = ['company-notes', 'job-description', 'resume'];

const FILENAME_WEIGHT = 10;
const HEADING_WEIGHT = 4;
const BODY_WEIGHT = 1;
const BODY_WEIGHT_CAP = 6;

/** How many leading characters of the body are scanned. */
export const BODY_SCAN_CHARS = 4000;

interface Rules {
  filename: RegExp[];
  heading: RegExp[];
  body: RegExp[];
}

const RULES: Record<DocType, Rules> = {
  resume: {
    filename: [/\b(resume|resum[ée]|cv|curriculum[ _-]?vitae)\b/i],
    heading: [
      /^#{1,6}\s*(work\s+)?experience\b/im,
      /^#{1,6}\s*employment\s+history\b/im,
      /^#{1,6}\s*education\b/im,
      /^#{1,6}\s*(technical\s+)?skills\b/im,
      /^#{1,6}\s*professional\s+summary\b/im,
    ],
    body: [
      /\byears? of experience\b/i,
      /\b(b\.?s\.?|m\.?s\.?|b\.?a\.?|ph\.?d\.?)\b/i,
      /\bgraduated\b/i,
      /\bproficient in\b/i,
      /\breferences available\b/i,
      /\bachievements?\b/i,
    ],
  },
  'job-description': {
    filename: [/\b(job[ _-]?description|job[ _-]?spec|jd|role|posting|vacancy|req(uisition)?)\b/i],
    heading: [
      /^#{1,6}\s*(what\s+you.{0,3}ll\s+do|responsibilities)\b/im,
      /^#{1,6}\s*(requirements|qualifications)\b/im,
      /^#{1,6}\s*(what\s+we.{0,3}re\s+looking\s+for)\b/im,
      /^#{1,6}\s*(about\s+the\s+role|the\s+role)\b/im,
      /^#{1,6}\s*(benefits|compensation)\b/im,
    ],
    body: [
      /\bwe are (looking|seeking)\b/i,
      /\bthe (ideal|successful) candidate\b/i,
      /\byou will\b/i,
      /\bnice[ -]to[ -]have\b/i,
      /\bminimum qualifications\b/i,
      /\breports? to\b/i,
      /\bequal opportunity employer\b/i,
    ],
  },
  'company-notes': {
    filename: [/\b(notes?|research|company|about|brief(ing)?|prep|background)\b/i],
    heading: [
      /^#{1,6}\s*(company|about\s+(the\s+)?company)\b/im,
      /^#{1,6}\s*(products?|competitors?|market)\b/im,
      /^#{1,6}\s*(funding|investors?|leadership|culture|values)\b/im,
      /^#{1,6}\s*(questions\s+(to|for)|talking\s+points)\b/im,
    ],
    body: [
      /\bfounded in\b/i,
      /\bheadquarter(ed|s)\b/i,
      /\bseries [a-e]\b/i,
      /\brevenue\b/i,
      /\bcompetitors?\b/i,
      /\bmission statement\b/i,
    ],
  },
};

const DOC_TYPES = Object.keys(RULES) as DocType[];

/** One doc type's score and the rules that produced it. Used by the Dashboard hover text. */
export interface TagScore {
  docType: DocType;
  score: number;
  matched: string[];
}

/**
 * Score every doc type against a document (FR-064).
 *
 * Exported so the Dashboard can explain a guess and so TC-072 can assert the
 * rule set rather than only its verdict.
 */
export function scoreDocTypes(fileName: string, markdown: string): TagScore[] {
  const body = markdown.slice(0, BODY_SCAN_CHARS);

  return DOC_TYPES.map((docType) => {
    const rules = RULES[docType];
    const matched: string[] = [];
    let score = 0;

    for (const pattern of rules.filename) {
      if (pattern.test(fileName)) {
        score += FILENAME_WEIGHT;
        matched.push(`filename:${pattern.source}`);
        // One filename hit is the signal. Counting a second would let a file
        // called `cv-resume.md` outweigh a heading structure that disagrees.
        break;
      }
    }

    for (const pattern of rules.heading) {
      if (pattern.test(body)) {
        score += HEADING_WEIGHT;
        matched.push(`heading:${pattern.source}`);
      }
    }

    let bodyScore = 0;
    for (const pattern of rules.body) {
      if (bodyScore >= BODY_WEIGHT_CAP) break;
      if (pattern.test(body)) {
        bodyScore += BODY_WEIGHT;
        matched.push(`body:${pattern.source}`);
      }
    }
    score += bodyScore;

    return { docType, score, matched };
  });
}

/**
 * Guess a document's type from its filename and content (FR-064, TC-072).
 *
 * Deterministic: the same filename and bytes always produce the same tag. Never
 * called for a document whose `docTypeSource` is `'user'`; that check belongs to
 * the caller, because only the caller knows the stored record (FR-079).
 */
export function guessDocType(fileName: string, markdown: string): DocType {
  const scores = scoreDocTypes(fileName, markdown);
  const best = Math.max(...scores.map((s) => s.score));
  const winners = scores.filter((s) => s.score === best).map((s) => s.docType);
  return TIE_BREAK_ORDER.find((t) => winners.includes(t)) ?? 'company-notes';
}
