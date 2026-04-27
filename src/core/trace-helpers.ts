import { globToRegex } from "./glob.js";
import type { Target } from "./types.js";

export { globToRegex } from "./glob.js";

export interface TargetMatch {
  stateId: string;
  target: Target;
}

export function findMatchingTargets(
  states: Array<{ id: string; targets: Target[] }>,
  pattern: string,
): TargetMatch[] {
  const matches: TargetMatch[] = [];
  const lowerPattern = pattern.toLowerCase();
  const isGlob = pattern.includes("*") || pattern.includes("?");

  for (const state of states) {
    for (const target of state.targets) {
      if (target.id === pattern || target.id.toLowerCase() === lowerPattern) {
        matches.push({ stateId: state.id, target });
        continue;
      }

      if (isGlob) {
        const regex = globToRegex(lowerPattern);
        if (
          regex.test(target.id.toLowerCase()) ||
          regex.test(target.name.toLowerCase()) ||
          regex.test(target.role.toLowerCase())
        ) {
          matches.push({ stateId: state.id, target });
        }
      }
    }
  }

  return matches;
}

export function modelAnnouncement(
  action: string,
  role: string,
  name: string,
  headingLevel?: number,
): string {
  const roleAnnouncement = SR_ROLE_MAP[role] ?? role;
  const cleanName = name === "(unnamed)" ? "" : name;

  switch (action) {
    case "nextHeading": {
      const level = headingLevel ? ` level ${headingLevel}` : "";
      return cleanName ? `${cleanName}, heading${level}` : `heading${level}`;
    }
    case "nextItem":
    case "previousItem":
      return cleanName ? `${cleanName}, ${roleAnnouncement}` : roleAnnouncement;
    case "activate":
      return cleanName ? `Activated: ${cleanName}` : `Activated ${roleAnnouncement}`;
    case "dismiss":
      return `Dismissed ${roleAnnouncement}`;
    case "nextLink":
      return cleanName ? `${cleanName}, link` : "link";
    case "nextControl":
      return cleanName ? `${cleanName}, ${roleAnnouncement}` : roleAnnouncement;
    case "find":
      return cleanName ? `Found: ${cleanName}, ${roleAnnouncement}` : `Found: ${roleAnnouncement}`;
    case "groupEntry":
      return cleanName ? `Entered ${cleanName}` : `Entered ${roleAnnouncement}`;
    case "groupExit":
      return cleanName ? `Exited ${cleanName}` : `Exited ${roleAnnouncement}`;
    default:
      return cleanName ? `${cleanName}, ${roleAnnouncement}` : roleAnnouncement;
  }
}

export const SR_ROLE_MAP: Record<string, string> = {
  button: "button",
  link: "link",
  textbox: "edit text",
  searchbox: "search edit",
  checkbox: "checkbox",
  radio: "radio button",
  combobox: "combo box",
  listbox: "list box",
  option: "option",
  menuitem: "menu item",
  menuitemcheckbox: "menu item checkbox",
  menuitemradio: "menu item radio button",
  tab: "tab",
  tabpanel: "tab panel",
  dialog: "dialog",
  alertdialog: "alert dialog",
  alert: "alert",
  navigation: "navigation",
  main: "main",
  banner: "banner",
  contentinfo: "content information",
  complementary: "complementary",
  region: "region",
  form: "form",
  search: "search",
  heading: "heading",
  img: "image",
  figure: "figure",
  list: "list",
  listitem: "list item",
  tree: "tree",
  treeitem: "tree item",
  grid: "grid",
  row: "row",
  gridcell: "cell",
  slider: "slider",
  spinbutton: "spin button",
  progressbar: "progress bar",
  status: "status",
  switch: "switch",
  tooltip: "tooltip",
  document: "document",
};
