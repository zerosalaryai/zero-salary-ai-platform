import { vi } from "vitest";

// Esta bancada não pode usar fetch real nem um pool PostgreSQL real.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    throw new Error("demo test: network forbidden");
  }),
);
vi.mock("pg", () => {
  class Pool {
    constructor() {
      throw new Error("demo test: real database forbidden");
    }
  }
  return { Pool, default: { Pool } };
});
