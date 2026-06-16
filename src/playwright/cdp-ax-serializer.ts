/**
 * Convert Chromium CDP Accessibility.getFullAXTree output into the subset of
 * Playwright's ariaSnapshot YAML dialect that Tactual consumes.
 *
 * This intentionally serializes to YAML instead of Targets. The rest of the
 * capture pipeline has one accessibility-tree intake point, parseAriaSnapshot,
 * and keeping CDP recovery on that path prevents cross-frame behavior from
 * silently drifting away from normal Playwright snapshots.
 */

interface CDPAXValue {
  value?: string | number | boolean;
  sources?: CDPAXNameSource[];
}

interface CDPAXNameSource {
  nativeSource?: string;
  value?: CDPAXValue;
  nativeSourceValue?: {
    relatedNodes?: Array<{ text?: string }>;
  };
}

interface CDPAXProperty {
  name: string;
  value?: CDPAXValue;
}

export interface CDPAXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: CDPAXValue;
  name?: CDPAXValue;
  value?: CDPAXValue;
  properties?: CDPAXProperty[];
  childIds?: string[];
}

export interface CDPAXSerializeOptions {
  /** Approximate ariaSnapshot's depth cap after wrapper nodes are collapsed. */
  depth?: number;
}

export interface CDPAXNodeMetadata {
  nodeId: string;
  backendDOMNodeId?: number;
  role: string;
  name: string;
}

export interface CDPAXSnapshot {
  yaml: string;
  metadata: CDPAXNodeMetadata[];
}

const COLLAPSED_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "LabelText",
  "InlineTextBox",
  "MenuListPopup",
]);

const SKIPPED_SUBTREE_ROLES = new Set([
  "ListMarker",
  "LineBreak",
]);

const ATOMIC_ROLES = new Set([
  "alert",
  "alertdialog",
  "button",
  "checkbox",
  "heading",
  "img",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const VALUE_ROLES = new Set(["progressbar", "slider", "spinbutton", "textbox"]);
const WRAPPED_LABEL_TEXT_ROLES = new Set(["checkbox", "radio", "switch"]);

export function cdpAxTreeToAriaYaml(
  nodes: readonly CDPAXNode[],
  options: CDPAXSerializeOptions = {},
): string {
  return cdpAxTreeToAriaSnapshot(nodes, options).yaml;
}

export function cdpAxTreeToAriaSnapshot(
  nodes: readonly CDPAXNode[],
  options: CDPAXSerializeOptions = {},
): CDPAXSnapshot {
  if (nodes.length === 0) return { yaml: "", metadata: [] };

  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root =
    nodes.find((node) => roleOf(node) === "RootWebArea" && !node.ignored) ??
    nodes.find((node) => !node.ignored) ??
    nodes[0];
  const rootUrl = propertyValue(root, "url");
  const metadata: CDPAXNodeMetadata[] = [];
  const lines = renderNode(root, byId, 0, 0, rootUrl, options.depth, new Set(), metadata);
  return { yaml: lines.join("\n"), metadata };
}

function renderNode(
  node: CDPAXNode,
  byId: ReadonlyMap<string, CDPAXNode>,
  indent: number,
  visibleDepth: number,
  rootUrl: string | undefined,
  maxDepth: number | undefined,
  path: Set<string>,
  metadata: CDPAXNodeMetadata[],
): string[] {
  if (path.has(node.nodeId)) return [];
  const rawRole = roleOf(node);
  if (!rawRole || SKIPPED_SUBTREE_ROLES.has(rawRole)) return [];

  const nextPath = new Set(path);
  nextPath.add(node.nodeId);

  // Chromium leaves many layout and ignored nodes in the returned AX tree.
  // Playwright's snapshot dialect hides those wrappers but keeps their
  // meaningful descendants, so CDP recovery must collapse them too or Tactual
  // would over-count anonymous containers in recovered frames.
  if (node.ignored || COLLAPSED_ROLES.has(rawRole)) {
    return renderChildren(node, byId, indent, visibleDepth, rootUrl, maxDepth, nextPath, metadata);
  }

  const role = normalizeRole(rawRole);
  if (role === "text") {
    const text = normalizeText(stringValue(node.name));
    return text ? [`${spaces(indent)}- text: ${formatYamlScalar(text)}`] : [];
  }

  const listItemText = role === "listitem" ? collectListItemText(node, byId, nextPath) : "";
  if (listItemText) {
    return [`${spaces(indent)}- listitem: ${formatYamlScalar(listItemText)}`];
  }

  const attrs = formatAttributes(node);
  const name = normalizeText(stringValue(node.name));
  const value = VALUE_ROLES.has(role) ? stringValue(node.value) : undefined;
  const renderedName = name ? ` "${escapeQuoted(name)}"` : "";
  const renderedAttrs = attrs ? ` [${attrs}]` : "";
  const renderedValue =
    value !== undefined && value !== ""
      ? `: ${formatYamlScalar(String(value))}`
      : "";
  metadata.push({
    nodeId: node.nodeId,
    backendDOMNodeId: node.backendDOMNodeId,
    role,
    name,
  });

  const childLines: string[] = [];
  const linkUrl = role === "link" ? propertyValue(node, "url") : undefined;
  if (linkUrl) {
    childLines.push(`${spaces(indent + 1)}- /url: ${formatYamlScalar(formatLinkUrl(linkUrl, rootUrl))}`);
  }

  if (
    childLines.length === 0 &&
    renderedValue === "" &&
    !ATOMIC_ROLES.has(role) &&
    (maxDepth === undefined || visibleDepth < maxDepth)
  ) {
    childLines.push(
      ...renderChildren(node, byId, indent + 1, visibleDepth + 1, rootUrl, maxDepth, nextPath, metadata),
    );
  }

  const hasChildren = childLines.length > 0;
  const line = `${spaces(indent)}- ${role}${renderedName}${renderedAttrs}${renderedValue}${hasChildren && renderedValue === "" ? ":" : ""}`;
  const wrappedLabelText =
    WRAPPED_LABEL_TEXT_ROLES.has(role) && renderedValue === ""
      ? labelWrappedText(node)
      : "";
  const wrappedLabelLine = wrappedLabelText
    ? [`${spaces(indent)}- text: ${formatYamlScalar(wrappedLabelText)}`]
    : [];
  return [line, ...childLines, ...wrappedLabelLine];
}

function renderChildren(
  node: CDPAXNode,
  byId: ReadonlyMap<string, CDPAXNode>,
  indent: number,
  visibleDepth: number,
  rootUrl: string | undefined,
  maxDepth: number | undefined,
  path: Set<string>,
  metadata: CDPAXNodeMetadata[],
): string[] {
  const lines: string[] = [];
  for (const childId of node.childIds ?? []) {
    const child = byId.get(childId);
    if (!child) continue;
    lines.push(...renderNode(child, byId, indent, visibleDepth, rootUrl, maxDepth, path, metadata));
  }
  return lines;
}

function collectListItemText(
  node: CDPAXNode,
  byId: ReadonlyMap<string, CDPAXNode>,
  path: Set<string>,
): string {
  const parts: string[] = [];
  for (const childId of node.childIds ?? []) {
    const child = byId.get(childId);
    if (!child || path.has(child.nodeId)) continue;
    const role = roleOf(child);
    if (!role || SKIPPED_SUBTREE_ROLES.has(role)) continue;
    if (role === "StaticText") {
      const text = normalizeText(stringValue(child.name));
      if (text) parts.push(text);
      continue;
    }
    const childPath = new Set(path);
    childPath.add(child.nodeId);
    const text = collectListItemText(child, byId, childPath);
    if (text) parts.push(text);
  }
  return normalizeText(parts.join(" "));
}

function normalizeRole(role: string): string {
  switch (role) {
    case "RootWebArea":
      return "document";
    case "StaticText":
      return "text";
    default:
      return role;
  }
}

function roleOf(node: CDPAXNode): string | undefined {
  return stringValue(node.role);
}

function propertyValue(node: CDPAXNode, name: string): string | undefined {
  const value = node.properties?.find((prop) => prop.name === name)?.value?.value;
  return value === undefined ? undefined : String(value);
}

function labelWrappedText(node: CDPAXNode): string {
  const source = node.name?.sources?.find((candidate) => candidate.nativeSource === "labelwrapped");
  if (!source) return "";
  const sourceValue = stringValue(source.value);
  if (sourceValue) return normalizeText(sourceValue);
  const relatedText = source.nativeSourceValue?.relatedNodes
    ?.map((related) => related.text ?? "")
    .join(" ");
  return normalizeText(relatedText ?? stringValue(node.name));
}

function formatAttributes(node: CDPAXNode): string {
  const attrs: string[] = [];
  const level = propertyValue(node, "level");
  if (level) attrs.push(`level=${level}`);

  const checked = propertyValue(node, "checked");
  if (checked === "mixed") attrs.push("checked=mixed");
  else if (checked === "true") attrs.push("checked");

  if (propertyValue(node, "expanded") === "true") attrs.push("expanded");
  if (propertyValue(node, "disabled") === "true") attrs.push("disabled");
  if (propertyValue(node, "selected") === "true") attrs.push("selected");

  const pressed = propertyValue(node, "pressed");
  if (pressed === "mixed") attrs.push("pressed=mixed");
  else if (pressed === "true") attrs.push("pressed");

  return attrs.join(" ");
}

function stringValue(value: CDPAXValue | undefined): string | undefined {
  return value?.value === undefined ? undefined : String(value.value);
}

function normalizeText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function formatYamlScalar(value: string): string {
  if (
    value === "" ||
    /^\s|\s$/.test(value) ||
    /[\n\r\t]/.test(value) ||
    /^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(value) ||
    /^(true|false|null|undefined)$/i.test(value) ||
    /[:#"'[\]{},&*?|<>=!%@`]/.test(value)
  ) {
    return `"${escapeQuoted(value)}"`;
  }
  return value;
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatLinkUrl(url: string, rootUrl: string | undefined): string {
  if (!rootUrl) return url;
  try {
    const parsedUrl = new URL(url);
    const parsedRoot = new URL(rootUrl);
    if (parsedUrl.origin !== parsedRoot.origin) return url;
    const sameDocument =
      parsedUrl.pathname === parsedRoot.pathname &&
      parsedUrl.search === parsedRoot.search &&
      parsedUrl.hash;
    if (sameDocument) return parsedUrl.hash;
    return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return url;
  }
}

function spaces(indent: number): string {
  return "  ".repeat(indent);
}
