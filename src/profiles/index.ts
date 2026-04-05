import { genericMobileWebSrV0 } from "./generic-mobile.js";
import { voiceoverIosV0 } from "./voiceover-ios.js";
import { talkbackAndroidV0 } from "./talkback-android.js";
import { nvdaDesktopV0 } from "./nvda-desktop.js";
import { jawsDesktopV0 } from "./jaws-desktop.js";
import type { ATProfile } from "./types.js";

export type { ATProfile, CostModifier, CostCondition } from "./types.js";
export { genericMobileWebSrV0 } from "./generic-mobile.js";
export { voiceoverIosV0 } from "./voiceover-ios.js";
export { talkbackAndroidV0 } from "./talkback-android.js";
export { nvdaDesktopV0 } from "./nvda-desktop.js";
export { jawsDesktopV0 } from "./jaws-desktop.js";

const profileRegistry = new Map<string, ATProfile>();

/** Register a profile for use by the analyzer */
export function registerProfile(profile: ATProfile): void {
  profileRegistry.set(profile.id, profile);
}

/** Get a registered profile by ID */
export function getProfile(id: string): ATProfile | undefined {
  return profileRegistry.get(id);
}

/** List all registered profile IDs */
export function listProfiles(): string[] {
  return [...profileRegistry.keys()];
}

// Register built-in profiles
registerProfile(genericMobileWebSrV0);
registerProfile(voiceoverIosV0);
registerProfile(talkbackAndroidV0);
registerProfile(nvdaDesktopV0);
registerProfile(jawsDesktopV0);
