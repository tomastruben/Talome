import { describe, it, expect } from "vitest";
import { rateLimit } from "../middleware/rate-limit.js";
import type { Context } from "hono";

function makeContext(ip: string): Context {
  return {
    req: {
      header: (name: string) => {
        if (name === "x-forwarded-for") return ip;
        return undefined;
      },
    },
    header: vi.fn(),
    json: (body: unknown, status?: number) => ({ body, status }),
  } as unknown as Context;
}

import { vi } from "vitest";

describe("rateLimit middleware", () => {
  it("allows requests under the limit", async () => {
    const middleware = rateLimit(5, 60_000);
    let nextCalled = 0;
    const next = () => { nextCalled++; return Promise.resolve(); };

    for (let i = 0; i < 5; i++) {
      await middleware(makeContext("1.2.3.4"), next);
    }
    expect(nextCalled).toBe(5);
  });

  it("rejects the request that exceeds the limit", async () => {
    const middleware = rateLimit(3, 60_000);
    const responses: Array<{ status?: number }> = [];
    const next = () => Promise.resolve();

    // Use a unique IP so the test doesn't share state with others
    const ip = "10.0.0.1";
    const ctxFn = () => ({
      req: { header: (n: string) => n === "x-forwarded-for" ? ip : undefined },
      header: vi.fn(),
      json: (body: unknown, status?: number) => {
        responses.push({ status });
        return { body, status };
      },
    } as unknown as Context);

    for (let i = 0; i < 3; i++) {
      await middleware(ctxFn(), next);
    }
    // 4th request should be rejected
    await middleware(ctxFn(), next);

    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe(429);
  });

  it("uses x-real-ip as fallback when x-forwarded-for is absent", async () => {
    const middleware = rateLimit(2, 60_000);
    let nextCalled = 0;
    const next = () => { nextCalled++; return Promise.resolve(); };

    const ctx = {
      req: { header: (n: string) => n === "x-real-ip" ? "5.6.7.8" : undefined },
      header: vi.fn(),
      json: vi.fn(),
    } as unknown as Context;

    await middleware(ctx, next);
    expect(nextCalled).toBe(1);
  });
});
