import { describe, it, expect } from "vitest";
import { announceScout, endScoutShift, PRODUCT_HAND } from "../src/presence.ts";
import { announcementFor, announceTtlSeconds, scoutDoing } from "../src/decide.ts";

const live = announcementFor({ JACK_FIELD_URL: "https://www.jack-field.com", PRESENCE_TOKEN: "t" });

const ok = () => Promise.resolve(new Response(null, { status: 200 }));

describe("announcementFor", () => {
  it("announces when both values are present", () => {
    expect(live).toEqual({ announce: true, url: "https://www.jack-field.com", token: "t" });
  });

  it("names whichever value is missing", () => {
    expect(announcementFor({ PRESENCE_TOKEN: "t" })).toEqual({
      announce: false,
      why: "JACK_FIELD_URL is unset",
    });
    expect(announcementFor({ JACK_FIELD_URL: "https://x" })).toEqual({
      announce: false,
      why: "PRESENCE_TOKEN is unset",
    });
    expect(announcementFor({}).announce).toBe(false);
  });

  /**
   * A trailing slash would otherwise produce //api/presence, which Vercel answers with a
   * redirect rather than the route, and fetch drops the Authorization header across it.
   */
  it("trims a trailing slash off the URL", () => {
    const a = announcementFor({ JACK_FIELD_URL: "https://www.jack-field.com/", PRESENCE_TOKEN: "t" });
    expect(a.announce && a.url).toBe("https://www.jack-field.com");
  });

  it("treats whitespace as unset", () => {
    expect(announcementFor({ JACK_FIELD_URL: "  ", PRESENCE_TOKEN: "t" }).announce).toBe(false);
  });
});

describe("announceTtlSeconds", () => {
  it("turns the Run timeout into seconds", () => {
    expect(announceTtlSeconds(45)).toBe(2700);
  });

  // The Kitchen's schema rejects anything outside 30..3600, and a rejected beat is a Hand
  // that never wakes, so the clamp belongs here rather than in a comment.
  it("clamps to what the Kitchen will accept", () => {
    expect(announceTtlSeconds(600)).toBe(3600);
    expect(announceTtlSeconds(0)).toBe(30);
  });
});

describe("scoutDoing", () => {
  it("names the repo without its owner", () => {
    expect(scoutDoing("fieldjw96/caddie")).toBe("Scouting caddie");
  });

  it("caps the line at what the Kitchen accepts", () => {
    expect(scoutDoing(`owner/${"r".repeat(200)}`).length).toBe(60);
  });
});

describe("announceScout", () => {
  it("posts the Product Hand with the Scout's line", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const problem = await announceScout(live, "Scouting caddie", "fieldjw96/caddie", 2700, (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return ok();
    });

    expect(problem).toBeNull();
    expect(seen!.url).toBe("https://www.jack-field.com/api/presence");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      hand: PRODUCT_HAND,
      doing: "Scouting caddie",
      repo: "caddie",
      ttlSeconds: 2700,
    });
  });

  it("says nothing on the wire when there are no credentials", async () => {
    let called = false;
    const silent = announcementFor({});
    const problem = await announceScout(silent, "Scouting caddie", "o/caddie", 2700, () => {
      called = true;
      return ok();
    });

    expect(called).toBe(false);
    expect(problem).toBe("JACK_FIELD_URL and PRESENCE_TOKEN are unset");
  });

  /**
   * The criterion this exists for. jack-field is a website on someone else's hardware and
   * foreman is the thing that builds everything; an announcement that can reject is an
   * announcement that can stop a tick. It must resolve, never throw, however it fails.
   */
  it("resolves rather than rejecting when the request fails", async () => {
    await expect(
      announceScout(live, "d", "o/r", 2700, () => Promise.reject(new Error("ECONNREFUSED"))),
    ).resolves.toBe("ECONNREFUSED");
  });

  it("resolves when the Kitchen refuses the token", async () => {
    await expect(
      announceScout(live, "d", "o/r", 2700, () => Promise.resolve(new Response(null, { status: 401 }))),
    ).resolves.toBe("the Kitchen answered 401");
  });
});

describe("endScoutShift", () => {
  it("sends the end form for the Product Hand", async () => {
    let body: unknown = null;
    const problem = await endScoutShift(live, (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body));
      return ok();
    });

    expect(problem).toBeNull();
    expect(body).toEqual({ hand: PRODUCT_HAND, end: true });
  });

  // settleScout awaits this inside a finally. A rejection there would skip the worktree
  // removal and leak a directory per Scout, so it has to be impossible, not unlikely.
  it("resolves rather than rejecting when the request fails", async () => {
    await expect(
      endScoutShift(live, () => Promise.reject(new Error("socket hang up"))),
    ).resolves.toBe("socket hang up");
  });
});
