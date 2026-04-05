import { describe, it, expect } from "vitest";
import { validateUrl } from "./url-validation.js";

describe("validateUrl", () => {
  describe("valid URLs", () => {
    it("accepts https URLs", () => {
      const result = validateUrl("https://example.com");
      expect(result.valid).toBe(true);
      expect(result.url).toBe("https://example.com/");
    });

    it("accepts http URLs", () => {
      const result = validateUrl("http://localhost:3000/page");
      expect(result.valid).toBe(true);
    });

    it("accepts file URLs", () => {
      const result = validateUrl("file:///tmp/test.html");
      expect(result.valid).toBe(true);
    });

    it("trims whitespace", () => {
      const result = validateUrl("  https://example.com  ");
      expect(result.valid).toBe(true);
    });

    it("accepts URLs with paths and queries", () => {
      const result = validateUrl("https://example.com/path?q=1&r=2#hash");
      expect(result.valid).toBe(true);
    });
  });

  describe("blocked protocols", () => {
    it("blocks javascript: URLs", () => {
      const result = validateUrl("javascript:alert(1)");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Blocked protocol");
    });

    it("blocks data: URLs", () => {
      const result = validateUrl("data:text/html,<h1>test</h1>");
      expect(result.valid).toBe(false);
    });

    it("blocks vbscript: URLs", () => {
      const result = validateUrl("vbscript:msgbox");
      expect(result.valid).toBe(false);
    });

    it("blocks blob: URLs", () => {
      const result = validateUrl("blob:https://example.com/abc");
      expect(result.valid).toBe(false);
    });

    it("blocks case-insensitive protocol tricks", () => {
      const result = validateUrl("JAVASCRIPT:alert(1)");
      expect(result.valid).toBe(false);
    });
  });

  describe("invalid URLs", () => {
    it("rejects empty strings", () => {
      const result = validateUrl("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("rejects whitespace-only strings", () => {
      const result = validateUrl("   ");
      expect(result.valid).toBe(false);
    });

    it("rejects malformed URLs", () => {
      const result = validateUrl("not a url at all");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });

    it("rejects unsupported protocols", () => {
      const result = validateUrl("ftp://files.example.com");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported protocol");
    });

    it("rejects URLs with embedded credentials", () => {
      const result = validateUrl("https://user:pass@example.com");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("credentials");
    });
  });
});
