import { estimateTokens, hashContent } from "@/server/ingestion/normalize";

export interface Chunk {
  ordinal: number;
  content: string;
  contentHash: string;
  tokenEstimate: number;
  /** Markdown heading trail above this chunk, outermost first. */
  headingPath: string[];
}

export interface ChunkOptions {
  /** Target size. Small enough to be precise, large enough to carry an argument. */
  targetTokens?: number;
  /** Hard ceiling — a chunk is split even mid-sentence rather than exceed this. */
  maxTokens?: number;
  /** Trailing tokens repeated into the next chunk so answers are not cut in half. */
  overlapTokens?: number;
  /** Chunks below this are folded into their neighbour instead of stored alone. */
  minTokens?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 350,
  maxTokens: 550,
  overlapTokens: 60,
  minTokens: 24,
};

interface Block {
  text: string;
  tokens: number;
  headingPath: string[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Splits text into paragraph-sized blocks while tracking the Markdown heading
 * trail. Keeping the heading path lets each chunk say where in the document it
 * came from, which is what makes citations readable and retrieval more precise.
 */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  // Indexed by heading depth (1-6) rather than by position, so that a level-2
  // heading replaces the previous level-2 heading instead of nesting under it.
  const levels: Array<string | undefined> = new Array(7).fill(undefined);
  const currentPath = (): string[] => levels.slice(1).filter((title): title is string => Boolean(title));

  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const depth = heading[1]!.length;
      levels[depth] = heading[2]!.trim();
      // A heading at depth N invalidates every heading below it.
      for (let deeper = depth + 1; deeper < levels.length; deeper += 1) levels[deeper] = undefined;
      // Headings stay in the body too: they are strong retrieval signal.
      blocks.push({ text: trimmed, tokens: estimateTokens(trimmed), headingPath: currentPath() });
      continue;
    }

    blocks.push({ text: trimmed, tokens: estimateTokens(trimmed), headingPath: currentPath() });
  }

  return blocks;
}

/** Sentence-ish split used only when one paragraph is bigger than maxTokens. */
function splitLongBlock(block: Block, maxTokens: number): Block[] {
  if (block.tokens <= maxTokens) return [block];

  const sentences = block.text.split(/(?<=[.!?])\s+|\n/).filter((part) => part.trim().length > 0);
  const pieces: Block[] = [];
  let buffer = "";

  const flush = (): void => {
    const text = buffer.trim();
    if (text.length > 0) {
      pieces.push({ text, tokens: estimateTokens(text), headingPath: block.headingPath });
    }
    buffer = "";
  };

  for (const sentence of sentences) {
    if (estimateTokens(sentence) > maxTokens) {
      // A single "sentence" this long is a table, a log dump or minified data.
      // Hard-split on word boundaries rather than emit an oversized chunk.
      flush();
      const words = sentence.split(/\s+/);
      let window = "";
      for (const word of words) {
        if (estimateTokens(`${window} ${word}`) > maxTokens && window.length > 0) {
          pieces.push({ text: window, tokens: estimateTokens(window), headingPath: block.headingPath });
          window = word;
        } else {
          window = window.length > 0 ? `${window} ${word}` : word;
        }
      }
      if (window.length > 0) {
        pieces.push({ text: window, tokens: estimateTokens(window), headingPath: block.headingPath });
      }
      continue;
    }

    if (estimateTokens(`${buffer} ${sentence}`) > maxTokens && buffer.length > 0) flush();
    buffer = buffer.length > 0 ? `${buffer} ${sentence}` : sentence;
  }
  flush();

  return pieces;
}

/** Takes the last ~`overlapTokens` worth of whole sentences from a chunk. */
function tailOverlap(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let tokens = 0;

  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index]!;
    const sentenceTokens = estimateTokens(sentence);
    if (tokens + sentenceTokens > overlapTokens && kept.length > 0) break;
    kept.unshift(sentence);
    tokens += sentenceTokens;
  }

  return kept.join(" ").trim();
}

/**
 * Structure-aware chunking: pack whole paragraphs up to a target size, split
 * only what is genuinely too long, and carry a sentence-aligned overlap so a
 * fact spanning a boundary is still retrievable from either side.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const { targetTokens, maxTokens, overlapTokens, minTokens } = { ...DEFAULTS, ...options };

  const blocks = toBlocks(text).flatMap((block) => splitLongBlock(block, maxTokens));
  if (blocks.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferHeadings: string[] = blocks[0]!.headingPath;

  const flush = (): void => {
    const content = buffer.join("\n\n").trim();
    if (content.length === 0) return;

    const previous = chunks[chunks.length - 1];
    // Too small to stand alone and it fits: merge backwards rather than keep a
    // fragment that would retrieve on its own with no context.
    if (
      previous &&
      estimateTokens(content) < minTokens &&
      previous.tokenEstimate + estimateTokens(content) <= maxTokens
    ) {
      const merged = `${previous.content}\n\n${content}`;
      chunks[chunks.length - 1] = {
        ...previous,
        content: merged,
        contentHash: hashContent(merged),
        tokenEstimate: estimateTokens(merged),
      };
      buffer = [];
      bufferTokens = 0;
      return;
    }

    chunks.push({
      ordinal: chunks.length,
      content,
      contentHash: hashContent(content),
      tokenEstimate: estimateTokens(content),
      headingPath: bufferHeadings,
    });
    buffer = [];
    bufferTokens = 0;
  };

  for (const block of blocks) {
    // A heading is a natural section boundary. Breaking here (rather than
    // mid-section on a token count) keeps each chunk under one heading trail,
    // which is what makes the trail meaningful for citations and filtering.
    if (bufferTokens >= minTokens && HEADING.test(block.text)) {
      flush();
      bufferHeadings = block.headingPath;
    }

    if (bufferTokens > 0 && bufferTokens + block.tokens > targetTokens) {
      const carried = tailOverlap(buffer.join("\n\n"), overlapTokens);
      flush();
      // Start the next chunk from the overlap, not from empty.
      if (carried.length > 0 && estimateTokens(carried) < targetTokens / 2) {
        buffer = [carried];
        bufferTokens = estimateTokens(carried);
      }
      bufferHeadings = block.headingPath;
    }

    if (bufferTokens === 0) bufferHeadings = block.headingPath;
    buffer.push(block.text);
    bufferTokens += block.tokens;
  }
  flush();

  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }));
}

/**
 * What actually gets embedded. Prefixing the title and heading trail means an
 * orphaned paragraph ("It renews annually.") still carries the subject it
 * belongs to, which measurably improves retrieval on short chunks.
 */
export function formatChunkForEmbedding(documentTitle: string, chunk: Chunk): string {
  const trail = chunk.headingPath.length > 0 ? ` > ${chunk.headingPath.join(" > ")}` : "";
  return `${documentTitle}${trail}\n\n${chunk.content}`;
}
