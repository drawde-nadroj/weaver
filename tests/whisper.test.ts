import { describe, expect, it } from "vitest";

import { parseEntries } from "../src/core/entries";
import {
  formatWhisperLine,
  parseWhisperLine,
  parseWhisperResponse,
  validateWhisper,
  whisperKey,
  whisperPrompt,
  type WhisperInput
} from "../src/core/whisper";
import headings from "./fixtures/whisper-headings.json";

const PROSE = "made a version of pi with durable execution in go";

const INPUT: WhisperInput = {
  address: "{ 5.1.8 }",
  prose: PROSE,
  ancestors: []
};

function reason(items: unknown[], input: WhisperInput = INPUT): string | null {
  const result = validateWhisper(items, input);
  return result.ok ? null : result.reason;
}

describe("parseWhisperLine", () => {
  it("round-trips all three types", () => {
    for (const item of [
      { type: "name", text: "durable pi in go" },
      { type: "learn", text: "durable execution" },
      { type: "next", text: "study pi durable" },
      { type: "ask", text: "which part ships first?" }
    ] as const) {
      expect(parseWhisperLine(formatWhisperLine(item))).toEqual(item);
    }
  });

  it("writes the glyph at column 0 and the type's word after it", () => {
    expect(formatWhisperLine({ type: "name", text: "x y" })).toBe("~ x y");
    expect(formatWhisperLine({ type: "learn", text: "x y" })).toBe("~ learn: x y");
    expect(formatWhisperLine({ type: "next", text: "x y" })).toBe("~ next: x y");
    expect(formatWhisperLine({ type: "ask", text: "x y?" })).toBe("~ ask: x y?");
  });

  it("tolerates leading air, because reading view trims before it asks", () => {
    expect(parseWhisperLine("   ~ a reading")).toEqual({ type: "name", text: "a reading" });
  });

  it("is not a whisper without the space after the glyph", () => {
    expect(parseWhisperLine("~a reading")).toBeNull();
    expect(parseWhisperLine("~~struck through~~")).toBeNull();
    expect(parseWhisperLine("the ~ in the middle")).toBeNull();
    expect(parseWhisperLine("~ ")).toBeNull();
  });

  it("is not a whisper when a type word has no space after it", () => {
    expect(parseWhisperLine("~ learn:nospace")).toBeNull();
    expect(parseWhisperLine("~ next:")).toBeNull();
  });
});

describe("validateWhisper", () => {
  it("accepts a reading: a name, an open edge and a question", () => {
    expect(
      validateWhisper(
        [
          { type: "name", text: "pi durable in go" },
          { type: "learn", text: "how the article fits, before writing it" },
          { type: "ask", text: "which part ships first?" }
        ],
        INPUT
      ).ok
    ).toBe(true);
  });

  it("accepts one to three rows, the name first", () => {
    expect(
      validateWhisper(
        [
          { type: "name", text: "durable pi in go" },
          { type: "next", text: "study durable execution" }
        ],
        INPUT
      )
    ).toEqual({
      ok: true,
      whisper: [
        { type: "name", text: "durable pi in go" },
        { type: "next", text: "study durable execution" }
      ]
    });
  });

  it("rejects each rule with its own reason", () => {
    expect(reason([])).toBe("no lines");
    expect(
      reason([
        { type: "name", text: "a" },
        { type: "name", text: "b" }
      ])
    ).toBe("duplicate type");
    expect(
      reason([
        { type: "learn", text: "a thing" },
        { type: "name", text: "a reading" }
      ])
    ).toBe("name not first");
    expect(
      reason([{ type: "name", text: "one two three four five six seven eight nine ten eleven" }])
    ).toBe("too long");
    // A name of ten words is allowed, and a question is not: only `ask:` asks.
    expect(reason([{ type: "name", text: "one two three four five six seven eight nine ten" }])).toBe(
      null
    );
    expect(reason([{ type: "name", text: "is this the reading?" }])).toBe("question");
    expect(reason([{ type: "ask", text: "is this the reading" }])).toBe("not a question");
    expect(reason([{ type: "ask", text: "which part ships first?" }])).toBe(null);
    expect(
      reason([{ type: "learn", text: "one two three four five six seven eight nine ten eleven twelve thirteen" }])
    ).toBe("too long");
    // The address is not a name.
    expect(reason([{ type: "name", text: "5.1.8" }])).toBe("names the address");
    expect(reason([{ type: "name", text: "{ 5.1.8 }" }])).toBe("names the address");
    expect(reason([{ type: "name", text: "durable work, not portable" }])).toBe("negation");
    expect(reason([{ type: "name", text: "durable rather than portable" }])).toBe("negation");
    expect(reason([{ type: "name", text: "durable — portable" }])).toBe("em dash");
    expect(reason([{ type: "name", text: "durable ~ portable" }])).toBe("second tilde");
    expect(reason([{ type: "summary", text: "x" }])).toBe("unknown type");
    expect(reason(["a string"])).toBe("malformed");
  });

  it("rejects more rows than a reading has", () => {
    expect(
      reason([
        { type: "name", text: "a" },
        { type: "learn", text: "b" },
        { type: "next", text: "c" }
      ])
    ).toBe(null);
    expect(
      reason([
        { type: "name", text: "a" },
        { type: "learn", text: "b" },
        { type: "next", text: "c" },
        { type: "ask", text: "d?" }
      ])
    ).toBe("too many lines");
  });

  it("rejects a copy of the entry's opening", () => {
    const input: WhisperInput = {
      address: "{ 1.1.1 }",
      prose: "the first sentence of it\nand then more",
      ancestors: []
    };
    expect(reason([{ type: "name", text: "The first sentence of it" }], input)).toBe(
      "restates the opening"
    );
  });

  it("rejects a line an ancestor already carries", () => {
    const input: WhisperInput = {
      ...INPUT,
      ancestors: [{ title: "a titled ancestor", whisper: "durable pi in go" }]
    };
    expect(reason([{ type: "name", text: "durable pi in go" }], input)).toBe("repeats an ancestor");
  });

  it("rejects two identical readings", () => {
    expect(
      reason([
        { type: "learn", text: "durable execution" },
        { type: "next", text: "durable execution" }
      ])
    ).toBe("duplicate text");
  });
});

describe("whisperKey", () => {
  // The key is asked one question: is the text I read still the text that is
  // there? So it is built from the parsed entry, never from a guess.
  const of = (source: string, ancestors: WhisperInput["ancestors"] = []): string => {
    const index = parseEntries(source);
    const entry = index.entries[0];
    return whisperKey({
      address: "{ 5.1.8 }",
      prose: (entry?.proseLines ?? []).map((line) => index.lines[line]).join("\n"),
      ancestors
    });
  };

  it("ignores the sigil changing from draft to settled", () => {
    expect(of(`{ 5.1.8 }\n${PROSE}\n- 00:00:30 09:14:22`)).toBe(
      of(`{ 5.1.8 }\n${PROSE}\n+ 00:00:30 09:14:22`)
    );
  });

  it("ignores a whisper added to the entry or to an ancestor", () => {
    const withWhisper = `{ 5.1.8 }\n~ durable pi in go\n${PROSE}\n+ 00:00:30 09:14:22`;
    const index = parseEntries(withWhisper);
    expect(index.entries[0]?.whisper[0]?.text).toBe("durable pi in go");

    expect(of(withWhisper, [{ title: "a parent", whisper: "a new name" }])).toBe(
      of(withWhisper, [{ title: "a parent", whisper: null }])
    );
  });

  it("changes with the prose, and with an ancestor's title", () => {
    expect(of(`{ 5.1.8 }\n${PROSE}, later\n+ 00:00:30 09:14:22`)).not.toBe(
      of(`{ 5.1.8 }\n${PROSE}\n+ 00:00:30 09:14:22`)
    );
    expect(of(`{ 5.1.8 }\n${PROSE}`, [{ title: "a parent", whisper: null }])).not.toBe(
      of(`{ 5.1.8 }\n${PROSE}`, [{ title: "another parent", whisper: null }])
    );
  });
});

describe("whisperPrompt", () => {
  it("leaves the ancestors block out when there are none", () => {
    const { user } = whisperPrompt(INPUT);
    expect(user).toBe(`${INPUT.address}\nnote:\n${PROSE}`);
  });

  it("lists the branch as names already taken, nearest last", () => {
    const { user } = whisperPrompt({
      ...INPUT,
      ancestors: [
        { title: "the root's first line", whisper: null },
        { title: "the parent's first line", whisper: "a pricing decision" }
      ]
    });
    expect(user).toContain(
      [
        "names already in this branch, never reuse one:",
        "  the root's first line",
        "  a pricing decision"
      ].join("\n")
    );
  });
});

describe("parseWhisperResponse", () => {
  it("reads the first object and its whisper array", () => {
    expect(
      parseWhisperResponse('here you go: {"whisper":[{"type":"name","text":"x"}]} thanks')
    ).toEqual([{ type: "name", text: "x" }]);
  });

  it("is null when there is no object, no array, or no JSON", () => {
    expect(parseWhisperResponse("no object here")).toBeNull();
    expect(parseWhisperResponse('{"other":[]}')).toBeNull();
    expect(parseWhisperResponse('{"whisper":')).toBeNull();
    expect(parseWhisperResponse('{"whisper":[oops]}')).toBeNull();
  });
});

describe("the entry's partition", () => {
  it("keeps whisper rows out of the prose, the title and the offsets", () => {
    const source = [
      "{ 2.1.3 }",
      "~ durable pi in go",
      "~ learn: durable execution",
      "made a version of pi durable also",
      "and article",
      "+ 00:01:00 10:02:11"
    ].join("\n");
    const entry = parseEntries(source).entries[0];

    expect(entry?.whisperLines).toEqual([1, 2]);
    expect(entry?.whisper).toEqual([
      { type: "name", text: "durable pi in go" },
      { type: "learn", text: "durable execution" }
    ]);
    expect(entry?.proseLines).toEqual([3, 4]);
    expect(entry?.firstProseLine).toBe(3);
    expect(entry?.title).toBe("made a version of pi durable also");
    expect(source.slice(entry?.proseFrom, entry?.proseTo)).toBe(
      "made a version of pi durable also\nand article"
    );
    expect(entry?.clockLine).toBe(5);
    expect(entry?.state).toBe("settled");
  });

  it("leaves a tilde inside a fenced block as prose", () => {
    const source = ["{ 1.1.1 }", "```", "~ not a whisper", "```", "10:00:00"].join("\n");
    const entry = parseEntries(source).entries[0];

    expect(entry?.whisper).toEqual([]);
    expect(entry?.whisperLines).toEqual([]);
    expect(entry?.proseLines).toEqual([1, 2, 3]);
    expect(entry?.title).toBe("```");
  });

  it("has no whisper for an entry that has none", () => {
    const entry = parseEntries("{ 1.1.1 }\njust prose\n10:00:00").entries[0];
    expect(entry?.whisper).toEqual([]);
    expect(entry?.whisperLines).toEqual([]);
  });
});

describe("the writer's own register", () => {
  // 40 real headings from the October ingest, strings only: the claim these
  // tests guard is about length and register, and both are measurable from a
  // heading alone. The 85 % floor is the regression guard, not the ambition.
  it("accepts the style it is meant to match", () => {
    const accepted = headings.filter(
      (text) =>
        validateWhisper([{ type: "name", text }], {
          address: "{ 1.1.1 }",
          prose: "the writer's own line for this day",
          ancestors: []
        }).ok
    );

    expect(accepted.length).toBeGreaterThanOrEqual(34);
  });

  it("rejects the antithesis, and only the antithesis", () => {
    expect(reason([{ type: "learn", text: "durable, not portable" }])).toBe("negation");
    expect(reason([{ type: "learn", text: "not just durable but portable" }])).toBe("negation");
    expect(reason([{ type: "learn", text: "go rather than rust" }])).toBe("negation");
    expect(reason([{ type: "learn", text: "the code instead of the prose" }])).toBe("negation");

    // Dictation says "i need not fear" and "the data doesn't lie". A reading that
    // touches those words is describing the note, not styling it.
    expect(reason([{ type: "learn", text: "fear is not the thing holding it" }])).toBe(null);
    expect(reason([{ type: "learn", text: "no matter what, the data holds" }])).toBe(null);
    expect(reason([{ type: "name", text: "A Conversation That Never Happened" }])).toBe(null);
  });
});
