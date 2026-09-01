"use node";

import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

/**
 * Rules Lawyer — the AI layer.
 *
 * The half that reads the passages back to you. It is worth saying
 * plainly what it is and is not, because the rest of this tool was
 * built on the opposite principle:
 *
 *   The passages are the answer. This is a reading of them.
 *
 * So every constraint here points the same way. The model is given the
 * retrieved sections and NOTHING else, told to answer only from them,
 * told to cite each claim by number, and told to say when the passages
 * do not cover the question rather than reaching for what it happens to
 * remember about D&D. The screen keeps the verbatim sections underneath
 * the answer, always, so a reader who distrusts a sentence is one click
 * from the rule it came from.
 *
 * A model that has read the rulebook is not the point. A model that has
 * read THESE TWELVE PARAGRAPHS and will show you which one it used is.
 *
 * ---------------------------------------------------------------------
 * Why this file is separate from convex/rules.ts
 *
 * `"use node"` is a per-file runtime choice and a file carrying it may
 * export only actions — queries and mutations have to stay in the
 * default runtime. rules.ts holds those; this holds the one action.
 *
 * ---------------------------------------------------------------------
 * What it costs
 *
 * This is the only thing in Game Mastery that spends money per use.
 * Three things hold that down, in order of how much they save:
 *
 *   the cache    the same question is answered once, ever
 *   the cap      at most MAX_PASSAGES sections are ever sent
 *   the brief    the system prompt asks for a ruling, not an essay
 *
 * The cache does nearly all of it. A table asks the same dozen
 * questions every session.
 */

/**
 * How many retrieved sections the model is allowed to read.
 *
 * Fewer than the twelve the search returns. Past the first handful the
 * hits are the ones that merely share a word with the question, and
 * paying to send them buys nothing but the chance of a citation
 * pointing somewhere irrelevant.
 */
const MAX_PASSAGES = 8;

/**
 * A ceiling on what one question can send, in characters.
 *
 * Enforced by DROPPING whole passages from the end, never by cutting
 * one short. A truncated rule is the exact failure this tool exists to
 * prevent — half a sentence of the grappling rules is worse than no
 * sentence, because it reads like the whole of it.
 */
const MAX_PASSAGE_CHARS = 24000;

/**
 * The model, and the reasoning it is allowed to do.
 *
 * A table ruling is short, but getting it right is not a small task —
 * the question is usually the one the passages answer only between
 * them. Adaptive thinking lets the model spend where it needs to and
 * skip it on "what does prone do", and both are billed on what is
 * actually generated, so the cheap questions stay cheap.
 */
const MODEL = "claude-opus-5";

/** Not a target — a ceiling, and the brief is what keeps answers short. */
const MAX_TOKENS = 16000;

const SYSTEM = `You are the Rules Lawyer in a D&D campaign manager. You answer a table's rules questions from the passages you are given, and from nothing else.

The passages are numbered sections of a rules document, quoted verbatim. They are the only source you have and the only source you may use.

How to answer:

- Answer ONLY from the numbered passages. You may reason across them — combining two sections to reach a conclusion is exactly the job — but every step must rest on something quoted.
- Cite with bracketed numbers: [1], [3]. Put the citation on the specific claim it supports, not in a pile at the end. Every substantive sentence gets one.
- If the passages do not settle the question, say so in your first sentence and then say what they DO establish. Do not fill the gap from memory of D&D. "The passages here don't cover X, but they do say Y [2]" is a good answer; a confident ruling that no passage supports is a bad one, however correct it might happen to be.
- If two passages pull in different directions, say that rather than picking one silently.
- Where the exact wording carries the ruling — "as an action", "within 5 feet", "must be able to see" — quote it rather than paraphrasing it away.
- Never cite a number you were not given.

Length and tone: this is read at a table mid-session. Lead with the ruling in one sentence, then at most a short paragraph or a few bullets of the qualifications that matter. No preamble, no restating the question, no closing summary. Aim for under 150 words and stop early when the answer is simple.

You are not the rules. You are a reading of the passages below, and the person asking can see them.`;

/** One passage, as the model sees it. */
type Passage = {
  source: string;
  breadcrumb: string;
  title: string;
  text: string;
  order: number;
};

/**
 * A passage the answer pointed at, carrying its bracketed number.
 *
 * `n` travels with the citation rather than being its position in this
 * array. Only cited passages are kept, so an answer citing [2] and [5]
 * yields two citations whose numbers are 2 and 5 — deriving either from
 * an index would link the reader to the wrong section. No `text`: the
 * screen already holds the passages, and a cached citation is a label
 * plus enough to find the section again.
 */
type Citation = {
  n: number;
  source: string;
  breadcrumb: string;
  title: string;
  order: number;
};

/**
 * The block of numbered passages placed in the user turn.
 *
 * Numbered from 1 because that is how the model is told to cite, and an
 * off-by-one here would silently attribute every claim to the wrong
 * section.
 */
function passageBlock(passages: Passage[]): string {
  return passages
    .map((p, i) => {
      const trail = [p.breadcrumb, p.title].filter(Boolean).join(" > ");
      return `[${i + 1}] ${trail} (${p.source})\n${p.text}`;
    })
    .join("\n\n");
}

/**
 * The passages that fit, in rank order.
 *
 * Takes from the front — the search already ranked them — and stops
 * rather than trimming, so every passage the model sees is whole.
 */
function passagesToSend(hits: Passage[]): Passage[] {
  const out: Passage[] = [];
  let chars = 0;
  for (const hit of hits.slice(0, MAX_PASSAGES)) {
    const size = hit.text.length;
    // The first passage goes in whatever its size: a question whose
    // single relevant section is enormous should still be answered.
    if (out.length > 0 && chars + size > MAX_PASSAGE_CHARS) break;
    out.push(hit);
    chars += size;
  }
  return out;
}

/**
 * Which passages the answer actually cited.
 *
 * Parsed out of the prose rather than asked for separately, because the
 * citation belongs inline where the claim is and a second list would be
 * a second thing that can disagree with the first.
 *
 * Out-of-range numbers are dropped, not clamped. A [9] against eight
 * passages is the model miscounting, and quietly turning it into [8]
 * would attribute a claim to a section that did not support it.
 */
function citedIndexes(answer: string, count: number): number[] {
  const found = new Set<number>();
  for (const [, digits] of String(answer ?? "").matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(digits);
    if (n >= 1 && n <= count) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Ask the Rules Lawyer.
 *
 * Returns the cached answer when there is one, and only reaches the API
 * on a miss. `cached` says which happened, because "this cost nothing"
 * is worth showing to the person who is paying.
 */
export const ask = action({
  args: { question: v.string(), source: v.optional(v.string()) },
  handler: async (
    ctx,
    args
  ): Promise<{
    answer: string;
    citations: Citation[];
    model: string;
    cached: boolean;
  }> => {
    const question = args.question.trim();
    if (!question) throw new Error("Ask a question first.");

    // First call, and it checks auth: cachedAnswer requires a signed-in
    // user. Nothing below this line runs for a caller who is not one,
    // and the free path is also the authenticated one.
    const hit = await ctx.runQuery(api.rules.cachedAnswer, {
      question,
      source: args.source,
    });
    if (hit) {
      return {
        answer: hit.answer,
        citations: hit.citations,
        model: hit.model,
        cached: true,
      };
    }

    const found = await ctx.runQuery(api.lookup.searchRules, {
      q: question,
      source: args.source,
    });
    const passages = passagesToSend(found.hits as Passage[]);

    if (passages.length === 0) {
      // No passages means no grounds, and an answer with no grounds is
      // the one thing this tool must never produce. Refusing here also
      // means an empty rules table cannot run up a bill.
      throw new Error(
        "Nothing in the rules text matches that — the AI answers only from " +
          "passages it can cite, so there is nothing for it to read."
      );
    }

    // Resolved from the environment: an unset key must fail here, with
    // a sentence that says what to do, rather than as a 401 from the
    // SDK that reaches the screen as "request failed".
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "The Rules Lawyer's AI layer needs an API key. Set it with: " +
          "npx convex env set ANTHROPIC_API_KEY sk-ant-..."
      );
    }

    const client = new Anthropic({ apiKey });

    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `Question: ${question}\n\nPassages:\n\n${passageBlock(
              passages
            )}`,
          },
        ],
      });
    } catch (error) {
      // Most specific first. The three that a DM can actually act on
      // are told apart, because "rate limited, try again" and "the key
      // is wrong" need opposite responses from the person reading them.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error(
          "The Rules Lawyer's API key was rejected. Re-set it with: " +
            "npx convex env set ANTHROPIC_API_KEY sk-ant-..."
        );
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new Error("Rate limited — give it a moment and ask again.");
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(
          `The AI layer failed (${error.status}). The passages below are ` +
            "unaffected — read them directly."
        );
      }
      throw error;
    }

    // A refusal comes back as a normal 200 with this stop_reason, so it
    // has to be checked before the content is read — not caught above.
    if (response.stop_reason === "refusal") {
      throw new Error(
        "The model declined to answer that one. The passages below are " +
          "unaffected — read them directly."
      );
    }

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!answer) {
      throw new Error("The AI layer returned nothing. Read the passages below.");
    }

    // Only the passages it actually cited are kept, each carrying the
    // bracketed number it was cited by — see the Citation type.
    const citations: Citation[] = citedIndexes(answer, passages.length).map(
      (n) => {
        const p = passages[n - 1];
        return {
          n,
          source: p.source,
          breadcrumb: p.breadcrumb,
          title: p.title,
          order: p.order,
        };
      }
    );

    // No cache key here: recordAnswer derives it, so this file never
    // has to agree with convex/rules.ts about how a question is named.
    await ctx.runMutation(internal.rules.recordAnswer, {
      question,
      source: args.source ?? null,
      answer,
      citations,
      model: MODEL,
    });

    return { answer, citations, model: MODEL, cached: false };
  },
});
