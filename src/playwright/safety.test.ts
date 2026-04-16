import { describe, it, expect } from "vitest";
import { checkActionSafety, type ElementInfo } from "./safety.js";

describe("checkActionSafety", () => {
  describe("--allow-action override", () => {
    it("downgrades unsafe to caution when name matches pattern", () => {
      const result = checkActionSafety(
        { role: "button", name: "Submit form" },
        [/submit/i],
      );
      expect(result.safety).toBe("caution");
      expect(result.reason).toContain("allowed by --allow-action pattern");
    });

    it("matches against role:name format", () => {
      const result = checkActionSafety(
        { role: "button", name: "Place order" },
        [/button:place/i],
      );
      expect(result.safety).toBe("caution");
    });

    it("does not downgrade safe actions (no override needed)", () => {
      const result = checkActionSafety(
        { role: "tab", name: "Settings" },
        [/settings/i],
      );
      expect(result.safety).toBe("safe");
    });

    it("does not match unrelated patterns", () => {
      const result = checkActionSafety(
        { role: "button", name: "Delete account" },
        [/checkout/i],
      );
      expect(result.safety).toBe("unsafe");
    });

    it("matches any pattern in the array", () => {
      const result = checkActionSafety(
        { role: "button", name: "Send message" },
        [/checkout/i, /send/i, /buy/i],
      );
      expect(result.safety).toBe("caution");
    });

    it("empty pattern array does not affect classification", () => {
      const result = checkActionSafety(
        { role: "button", name: "Delete item" },
        [],
      );
      expect(result.safety).toBe("unsafe");
    });

    it("undefined patterns does not affect classification", () => {
      const result = checkActionSafety(
        { role: "button", name: "Delete item" },
      );
      expect(result.safety).toBe("unsafe");
    });
  });

  describe("unsafe actions", () => {
    const unsafeNames = [
      "Delete item",
      "Remove from cart",
      "Send message",
      "Submit form",
      "Purchase now",
      "Buy tickets",
      "Place order",
      "Sign out",
      "Log out",
      "Deploy to production",
      "Publish post",
    ];

    for (const name of unsafeNames) {
      it(`blocks "${name}"`, () => {
        const result = checkActionSafety({ role: "button", name });
        expect(result.safety).toBe("unsafe");
      });
    }
  });

  describe("safe navigational elements", () => {
    it("allows tabs", () => {
      const result = checkActionSafety({ role: "tab", name: "Settings" });
      expect(result.safety).toBe("safe");
    });

    it("allows menu items", () => {
      const result = checkActionSafety({ role: "menuitem", name: "File" });
      expect(result.safety).toBe("safe");
    });

    it("allows elements with aria-expanded", () => {
      const result = checkActionSafety({ role: "button", name: "Options", expanded: false });
      expect(result.safety).toBe("safe");
    });

    it("allows elements with aria-haspopup", () => {
      const result = checkActionSafety({ role: "button", name: "Account", hasPopup: true });
      expect(result.safety).toBe("safe");
    });

    it("allows same-page anchor links", () => {
      const result = checkActionSafety({ role: "link", name: "Details", href: "#details" });
      expect(result.safety).toBe("safe");
    });

    it("allows disclosure toggles", () => {
      const result = checkActionSafety({ role: "button", name: "Show details" });
      expect(result.safety).toBe("safe");
    });

    it("allows menu toggle buttons", () => {
      const result = checkActionSafety({ role: "button", name: "Toggle menu" });
      expect(result.safety).toBe("safe");
    });
  });

  describe("caution actions", () => {
    it("flags external links", () => {
      const result = checkActionSafety({ role: "link", name: "Visit site", href: "https://example.com" });
      expect(result.safety).toBe("caution");
    });

    it("flags non-search submit buttons as unsafe", () => {
      const result = checkActionSafety({ role: "button", name: "Apply", type: "submit" });
      expect(result.safety).toBe("unsafe");
    });

    it("allows search submit buttons", () => {
      const result = checkActionSafety({ role: "button", name: "Search", type: "submit" });
      expect(result.safety).not.toBe("caution");
    });
  });

  describe("form fields", () => {
    it("marks form fields as safe", () => {
      const fields: ElementInfo[] = [
        { role: "textbox", name: "Name" },
        { role: "searchbox", name: "Search" },
        { role: "combobox", name: "Country" },
        { role: "checkbox", name: "Accept terms" },
        { role: "radio", name: "Option A" },
        { role: "slider", name: "Volume" },
      ];

      for (const field of fields) {
        expect(checkActionSafety(field).safety).toBe("safe");
      }
    });
  });

  describe("unlabeled elements", () => {
    it("marks unlabeled buttons as unsafe", () => {
      const result = checkActionSafety({ role: "button", name: "" });
      expect(result.safety).toBe("unsafe");
    });
  });
});
