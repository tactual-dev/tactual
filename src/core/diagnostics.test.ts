import { describe, it, expect } from "vitest";
import { diagnoseCapture, hasBlockingDiagnostic } from "./diagnostics.js";
import type { PageState } from "./types.js";

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "abc",
    interactiveHash: "def",
    openOverlays: [],
    targets: [],
    timestamp: Date.now(),
    provenance: "scripted",
    ...overrides,
  };
}

describe("diagnoseCapture", () => {
  it("returns ok (plus info diagnostics) for a well-populated page", () => {
    const state = makeState({
      targets: [
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `h${i}`, kind: "heading" as const, role: "heading", name: `Heading ${i}`, requiresBranchOpen: false,
        })),
        { id: "lm1", kind: "landmark" as const, role: "main", name: "Main", requiresBranchOpen: false },
        { id: "lm2", kind: "landmark" as const, role: "banner", name: "Header", requiresBranchOpen: false },
        { id: "lm3", kind: "landmark" as const, role: "contentinfo", name: "Footer", requiresBranchOpen: false },
        { id: "lm4", kind: "landmark" as const, role: "navigation", name: "Nav", requiresBranchOpen: false },
        { id: "skip", kind: "link" as const, role: "link", name: "Skip to content", requiresBranchOpen: false },
        ...Array.from({ length: 25 }, (_, i) => ({
          id: `l${i}`, kind: "link" as const, role: "link", name: `Link ${i}`, requiresBranchOpen: false,
        })),
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    // No warnings or errors
    expect(diags.some((d) => d.level === "warning" || d.level === "error")).toBe(false);
    expect(hasBlockingDiagnostic(diags)).toBe(false);
    // structural-summary is always emitted as info
    expect(diags.some((d) => d.code === "structural-summary")).toBe(true);
    const summary = diags.find((d) => d.code === "structural-summary")!;
    expect(summary.message).toContain("skip link: yes");
  });

  it("detects empty page", () => {
    const state = makeState({ targets: [] });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "empty-page")).toBe(true);
    expect(hasBlockingDiagnostic(diags)).toBe(true);
  });

  it("detects bot protection from snapshot text", () => {
    const state = makeState({
      targets: [
        { id: "l1", kind: "link", role: "link", name: "File a ticket", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(
      state,
      "https://reddit.com",
      "You've been blocked by network security",
    );
    expect(diags.some((d) => d.code === "blocked-by-bot-protection")).toBe(true);
    expect(hasBlockingDiagnostic(diags)).toBe(true);
    // Should include the matched trigger text
    const blockDiag = diags.find((d) => d.code === "blocked-by-bot-protection")!;
    expect(blockDiag.message).toMatch(/matched:/);
    expect(blockDiag.message).toMatch(/you've been blocked/i);
  });

  it("detects bot protection from target names", () => {
    const state = makeState({
      targets: [
        { id: "t1", kind: "statusMessage", role: "status", name: "Checking your browser", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "blocked-by-bot-protection")).toBe(true);
  });

  it("detects Cloudflare challenge", () => {
    const state = makeState({
      targets: [
        { id: "t1", kind: "heading", role: "heading", name: "Just a moment", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "cloudflare ray id abc123");
    expect(diags.some((d) => d.code === "blocked-by-bot-protection")).toBe(true);
  });

  it("detects sparse content", () => {
    const state = makeState({
      targets: [
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "Login", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "sparse-content")).toBe(true);
  });

  it("detects possible login wall", () => {
    const state = makeState({
      targets: [
        { id: "f1", kind: "formField", role: "textbox", name: "Email", requiresBranchOpen: false },
        { id: "f2", kind: "formField", role: "textbox", name: "Password", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Sign in", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://app.example.com", "");
    expect(diags.some((d) => d.code === "possible-login-wall")).toBe(true);
    // Should include the matched trigger text
    const loginDiag = diags.find((d) => d.code === "possible-login-wall")!;
    expect(loginDiag.message).toMatch(/matched:/);
    expect(loginDiag.message).toMatch(/sign in/i);
  });

  it("detects cookie consent", () => {
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "l1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Accept all cookies", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "possible-cookie-wall")).toBe(true);
    expect(diags.some((d) => d.level === "error")).toBe(false); // info, not error
    // Should include the matched trigger text
    const cookieDiag = diags.find((d) => d.code === "possible-cookie-wall")!;
    expect(cookieDiag.message).toMatch(/matched:/);
    expect(cookieDiag.message).toMatch(/accept all cookies/i);
  });

  it("detects redirect to different domain", () => {
    const state = makeState({
      url: "https://login.example.com/sso",
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Login", requiresBranchOpen: false },
        { id: "l1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Submit", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "Help", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "Privacy", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://app.example.com", "");
    expect(diags.some((d) => d.code === "redirect-detected")).toBe(true);
  });

  it("detects missing headings on content page", () => {
    const state = makeState({
      targets: [
        { id: "l1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Click", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "One", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "Two", requiresBranchOpen: false },
        { id: "l4", kind: "link", role: "link", name: "Three", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "no-headings")).toBe(true);
  });

  it("detects missing landmarks on content page", () => {
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Click", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "One", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "Two", requiresBranchOpen: false },
        { id: "l4", kind: "link", role: "link", name: "Three", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "no-landmarks")).toBe(true);
  });

  it("detects possibly-degraded content on http page with few targets", () => {
    // 10 targets, only 1 heading, 1 landmark — should trigger degraded warning
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "m1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `l${i}`, kind: "link" as const, role: "link", name: `Link ${i}`, requiresBranchOpen: false,
        })),
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "possibly-degraded-content")).toBe(true);
    const degraded = diags.find((d) => d.code === "possibly-degraded-content")!;
    expect(degraded.level).toBe("warning");
    expect(degraded.message).toContain("10 targets");
  });

  it("does NOT flag degraded content for file:// URLs", () => {
    const state = makeState({
      url: "file:///test.html",
      targets: Array.from({ length: 6 }, (_, i) => ({
        id: `l${i}`, kind: "link" as const, role: "link", name: `Link ${i}`, requiresBranchOpen: false,
      })),
    });
    const diags = diagnoseCapture(state, "file:///test.html", "");
    expect(diags.some((d) => d.code === "possibly-degraded-content")).toBe(false);
  });

  it("does NOT flag degraded content when bot protection is already detected", () => {
    const state = makeState({
      targets: [
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "You've been blocked");
    // Should have bot-protection but NOT degraded-content
    expect(diags.some((d) => d.code === "blocked-by-bot-protection")).toBe(true);
    expect(diags.some((d) => d.code === "possibly-degraded-content")).toBe(false);
  });

  it("does NOT flag degraded for well-structured small pages", () => {
    // 15 targets with 2+ headings and 3 landmarks — should be fine
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "h2", kind: "heading", role: "heading", name: "Subtitle", requiresBranchOpen: false },
        { id: "m1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "n1", kind: "landmark", role: "navigation", name: "Nav", requiresBranchOpen: false },
        { id: "f1", kind: "landmark", role: "contentinfo", name: "Footer", requiresBranchOpen: false },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `l${i}`, kind: "link" as const, role: "link", name: `Link ${i}`, requiresBranchOpen: false,
        })),
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "possibly-degraded-content")).toBe(false);
  });

  // --- Skip link detection ---

  it("detects missing skip link", () => {
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "m1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Click", requiresBranchOpen: false },
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "no-skip-link")).toBe(true);
  });

  it("does NOT flag skip link when one exists", () => {
    const state = makeState({
      targets: [
        { id: "s1", kind: "link", role: "link", name: "Skip to main content", requiresBranchOpen: false },
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "m1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "no-skip-link")).toBe(false);
  });

  it("recognizes 'Jump to content' as a skip link", () => {
    const state = makeState({
      targets: [
        { id: "s1", kind: "link", role: "link", name: "Jump to content", requiresBranchOpen: false },
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "m1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "no-skip-link")).toBe(false);
  });

  // --- Landmark completeness ---

  it("detects missing main landmark when other landmarks exist", () => {
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "n1", kind: "landmark", role: "navigation", name: "Nav", requiresBranchOpen: false },
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "Contact", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    expect(diags.some((d) => d.code === "no-main-landmark")).toBe(true);
    expect(diags.find((d) => d.code === "no-main-landmark")!.level).toBe("warning");
  });

  it("does NOT fire individual landmark checks when NO landmarks exist", () => {
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "b1", kind: "button", role: "button", name: "Click", requiresBranchOpen: false },
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "Contact", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    // Should get the generic "no-landmarks" warning, NOT individual landmark checks
    expect(diags.some((d) => d.code === "no-landmarks")).toBe(true);
    expect(diags.some((d) => d.code === "no-main-landmark")).toBe(false);
    expect(diags.some((d) => d.code === "no-banner-landmark")).toBe(false);
  });

  // --- Structural summary ---

  it("emits structural summary for pages with enough targets", () => {
    const state = makeState({
      targets: [
        { id: "h1", kind: "heading", role: "heading", name: "Title", requiresBranchOpen: false },
        { id: "n1", kind: "landmark", role: "navigation", name: "Nav", requiresBranchOpen: false },
        { id: "l1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
        { id: "l2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
        { id: "l3", kind: "link", role: "link", name: "Contact", requiresBranchOpen: false },
      ],
    });
    const diags = diagnoseCapture(state, "https://example.com", "");
    const summary = diags.find((d) => d.code === "structural-summary");
    expect(summary).toBeDefined();
    expect(summary!.level).toBe("info");
    expect(summary!.message).toContain("1 heading");
    expect(summary!.message).toContain("navigation");
    expect(summary!.message).toContain("missing:");
    expect(summary!.message).toContain("main");
    expect(summary!.message).toContain("skip link: no");
  });
});
