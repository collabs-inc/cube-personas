import { describe, expect, test } from "vitest";
import { decode, encode, type WireMessage } from "../../src/shared/wire";

describe("wire", () => {
  const samples: WireMessage[] = [
    { t: "req", id: 1, verb: "persona:open", args: { id: "p", sinceSeq: 4 } },
    { t: "res", id: 1, ok: true, result: { seq: 4 } },
    { t: "res", id: 2, ok: false, error: "No such persona." },
    { t: "evt", name: "worker:output", payload: { id: "w", data: "hi" } },
  ];

  test.each(samples)("round-trips %j", (msg) => {
    expect(decode(encode(msg))).toEqual(msg);
  });

  test("accepts a result of null", () => {
    expect(decode('{"t":"res","id":3,"ok":true,"result":null}')).toEqual({ t: "res", id: 3, ok: true, result: null });
  });

  test.each([
    ["non-JSON", "nope{"],
    ["a JSON scalar", "7"],
    ["a missing t", '{"id":1,"verb":"personas:list"}'],
    ["an unknown t", '{"t":"x"}'],
    ["a req without numeric id", '{"t":"req","id":"1","verb":"personas:list"}'],
    ["a req with an unknown verb", '{"t":"req","id":1,"verb":"nope"}'],
    ["a res with neither result nor error", '{"t":"res","id":1}'],
    ["a res with ok:false and no error text", '{"t":"res","id":1,"ok":false}'],
    ["an evt with an unknown name", '{"t":"evt","name":"nope","payload":{}}'],
  ])("rejects %s", (_label, text) => {
    expect(decode(text)).toBeNull();
  });
});
