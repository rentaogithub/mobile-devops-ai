export interface RecordingScreenSize {
  width: number;
  height: number;
}

export interface RecordingPoint {
  x: number;
  y: number;
}

export interface RecordingNormalizedPoint {
  x: number;
  y: number;
}

export interface RecordingElementRect extends RecordingPoint {
  width: number;
  height: number;
}

export interface RecordingLocatorCandidate {
  strategy: 'accessibilityId' | 'predicate' | 'classChain' | 'hierarchy' | 'coordinate';
  value: string;
  score: number;
}

export interface RecordingActionTarget {
  type: string;
  name?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  contextLabels?: string[];
  rect: RecordingElementRect;
  relativePoint: RecordingNormalizedPoint;
  depth: number;
  locators: RecordingLocatorCandidate[];
}

export interface RecordingAction {
  type: string;
  params: Record<string, unknown>;
  screenSize?: RecordingScreenSize;
  normalizedPoint?: RecordingNormalizedPoint;
  normalizedStart?: RecordingNormalizedPoint;
  normalizedEnd?: RecordingNormalizedPoint;
  target?: RecordingActionTarget;
  startTarget?: RecordingActionTarget;
  endTarget?: RecordingActionTarget;
}

export interface ResolvedReplayPoint {
  point: RecordingPoint;
  strategy: 'semantic' | 'coordinate';
  matchedTarget?: RecordingActionTarget;
  distance?: number;
}

export interface ReplayTargetQuery {
  accessibilityId?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  type?: string;
  contextLabels?: string[];
  coordinate?: RecordingNormalizedPoint;
  relativePoint?: RecordingNormalizedPoint;
}

export interface ReplayTargetInspection {
  point: RecordingPoint;
  strategy: 'semantic' | 'coordinate';
  type: string;
  identifier?: string;
  name?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  rect: RecordingElementRect;
  visible: boolean;
  enabled: boolean;
  semanticScore: number;
  distance: number;
}

export function screenSizeFromSource(source: string): RecordingScreenSize | undefined {
  const root = source.match(/<XCUIElementTypeApplication\b([^>]*)>/)
    || source.match(/<XCUIElementTypeWindow\b([^>]*)>/);
  if (!root) return undefined;
  const attributes = attributesOf(root[1]);
  const width = finiteNumber(attributes.width);
  const height = finiteNumber(attributes.height);
  return width && height ? { width, height } : undefined;
}

interface ParsedNode {
  type: string;
  name?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  identifier?: string;
  rect: RecordingElementRect;
  depth: number;
  path: string;
  visible: boolean;
  enabled: boolean;
  accessible: boolean;
  focused: boolean;
  hittable?: boolean;
}

const ACTIONABLE_TYPES = new Set([
  'XCUIElementTypeButton',
  'XCUIElementTypeCell',
  'XCUIElementTypeCollectionView',
  'XCUIElementTypeImage',
  'XCUIElementTypeLink',
  'XCUIElementTypeScrollView',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeSlider',
  'XCUIElementTypeStaticText',
  'XCUIElementTypeSwitch',
  'XCUIElementTypeTable',
  'XCUIElementTypeTextField',
  'XCUIElementTypeTextView',
]);

const INPUT_TYPES = new Set([
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeTextField',
  'XCUIElementTypeTextView',
]);

function xmlDecode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributesOf(raw: string) {
  const attributes: Record<string, string> = {};
  const regex = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw))) attributes[match[1]] = xmlDecode(match[2]);
  return attributes;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function booleanAttribute(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  return value !== 'false' && value !== '0';
}

function normalized(point: RecordingPoint, screen: RecordingScreenSize): RecordingNormalizedPoint {
  return {
    x: Number((point.x / Math.max(screen.width, 1)).toFixed(6)),
    y: Number((point.y / Math.max(screen.height, 1)).toFixed(6)),
  };
}

function contains(rect: RecordingElementRect, point: RecordingPoint) {
  return point.x >= rect.x
    && point.y >= rect.y
    && point.x <= rect.x + rect.width
    && point.y <= rect.y + rect.height;
}

function escapePredicate(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function parseNodes(source: string) {
  const nodes: ParsedNode[] = [];
  const stack: Array<{ type: string; ordinal: number }> = [];
  const siblingCounts: Array<Map<string, number>> = [new Map()];
  const tagRegex = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(source))) {
    const closing = Boolean(match[1]);
    const tagName = match[2];
    const rawAttributes = match[3];
    if (closing) {
      stack.pop();
      siblingCounts.pop();
      continue;
    }
    if (tagName.startsWith('?') || tagName.startsWith('!')) continue;
    const selfClosing = /\/\s*$/.test(rawAttributes);
    const attributes = attributesOf(rawAttributes);
    const depth = stack.length;
    const levelCounts = siblingCounts[depth] || new Map<string, number>();
    siblingCounts[depth] = levelCounts;
    const ordinal = (levelCounts.get(tagName) || 0) + 1;
    levelCounts.set(tagName, ordinal);
    const path = [...stack.map((item) => `${item.type}[${item.ordinal}]`), `${tagName}[${ordinal}]`].join('/');
    const x = finiteNumber(attributes.x);
    const y = finiteNumber(attributes.y);
    const width = finiteNumber(attributes.width);
    const height = finiteNumber(attributes.height);
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0) {
      nodes.push({
        type: attributes.type || tagName,
        name: attributes.name || undefined,
        label: attributes.label || undefined,
        value: attributes.value || undefined,
        placeholder: attributes.placeholderValue || undefined,
        identifier: attributes.identifier || undefined,
        rect: { x, y, width, height },
        depth,
        path,
        visible: booleanAttribute(attributes.visible, true),
        enabled: booleanAttribute(attributes.enabled, true),
        accessible: booleanAttribute(attributes.accessible, false),
        focused: booleanAttribute(attributes.focused, false),
        hittable: attributes.hittable === undefined ? undefined : booleanAttribute(attributes.hittable, false),
      });
    }
    if (!selfClosing) {
      stack.push({ type: tagName, ordinal });
      siblingCounts.push(new Map());
    }
  }
  return nodes;
}

function locatorCandidates(node: ParsedNode, point: RecordingPoint, screen: RecordingScreenSize) {
  const candidates: RecordingLocatorCandidate[] = [];
  const identifier = node.identifier || (node.name && node.name !== node.label ? node.name : undefined);
  if (identifier) {
    candidates.push({ strategy: 'accessibilityId', value: identifier, score: node.identifier ? 100 : 92 });
  }
  const predicateParts = [`type == '${escapePredicate(node.type)}'`];
  if (node.name) predicateParts.push(`name == '${escapePredicate(node.name)}'`);
  else if (node.label) predicateParts.push(`label == '${escapePredicate(node.label)}'`);
  else if (node.placeholder) predicateParts.push(`placeholderValue == '${escapePredicate(node.placeholder)}'`);
  candidates.push({ strategy: 'predicate', value: predicateParts.join(' AND '), score: node.name || node.label || node.placeholder ? 84 : 68 });
  if (node.name || node.label || node.placeholder) {
    const property = node.name ? 'name' : (node.label ? 'label' : 'placeholderValue');
    const value = node.name || node.label || node.placeholder || '';
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    candidates.push({
      strategy: 'classChain',
      value: `**/${node.type}[\`${property} == "${escapedValue}"\`]`,
      score: 74,
    });
  }
  candidates.push({ strategy: 'hierarchy', value: node.path, score: 52 });
  candidates.push({
    strategy: 'coordinate',
    value: JSON.stringify(normalized(point, screen)),
    score: 30,
  });
  return candidates;
}

function actionTarget(
  node: ParsedNode,
  point: RecordingPoint,
  screen: RecordingScreenSize,
  contextLabels?: string[],
): RecordingActionTarget {
  return {
    type: node.type,
    name: node.name,
    label: node.label,
    value: node.value,
    placeholder: node.placeholder,
    contextLabels: contextLabels?.length ? contextLabels : undefined,
    rect: node.rect,
    relativePoint: {
      x: Number(((point.x - node.rect.x) / node.rect.width).toFixed(6)),
      y: Number(((point.y - node.rect.y) / node.rect.height).toFixed(6)),
    },
    depth: node.depth,
    locators: locatorCandidates(node, point, screen),
  };
}

export function targetAtPoint(source: string, point: RecordingPoint, screen: RecordingScreenSize): RecordingActionTarget | undefined {
  const nodes = parseNodes(source);
  const containing = nodes.filter((node) => node.visible && node.enabled && contains(node.rect, point));
  if (!containing.length) return undefined;
  const hittable = containing.filter((node) => node.hittable === true);
  const actionable = (hittable.length ? hittable : containing).filter((node) => (
    ACTIONABLE_TYPES.has(node.type)
    || (node.accessible && Boolean(node.name || node.label))
  ));
  const pool = actionable.length ? actionable : (hittable.length ? hittable : containing);
  pool.sort((left, right) => {
    const leftArea = left.rect.width * left.rect.height;
    const rightArea = right.rect.width * right.rect.height;
    return leftArea - rightArea || right.depth - left.depth;
  });
  const node = pool[0];
  const containingCell = containing
    .filter((candidate) => candidate.type === 'XCUIElementTypeCell')
    .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height))[0];
  const contextLabels = containingCell
    ? nodes
      .filter((candidate) => {
        if (!candidate.visible || !candidate.accessible) return false;
        const center = {
          x: candidate.rect.x + (candidate.rect.width / 2),
          y: candidate.rect.y + (candidate.rect.height / 2),
        };
        return contains(containingCell.rect, center);
      })
      .flatMap((candidate) => [candidate.label, candidate.name, candidate.value])
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
      .slice(0, 4)
    : [];
  return actionTarget(node, point, screen, contextLabels);
}

function focusedInputTarget(source: string, screen: RecordingScreenSize) {
  const inputs = parseNodes(source).filter((node) => node.visible && node.enabled && INPUT_TYPES.has(node.type));
  const focused = inputs.filter((node) => node.focused);
  const pool = focused.length ? focused : (inputs.length === 1 ? inputs : []);
  if (!pool.length) return undefined;
  pool.sort((left, right) => Number(right.accessible) - Number(left.accessible) || right.depth - left.depth);
  const node = pool[0];
  const center = { x: node.rect.x + node.rect.width / 2, y: node.rect.y + node.rect.height / 2 };
  return actionTarget(node, center, screen);
}

function pointFrom(value: unknown): RecordingPoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const x = finiteNumber((value as { x?: unknown }).x);
  const y = finiteNumber((value as { y?: unknown }).y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function fallbackReplayPoint(action: RecordingAction, screen: RecordingScreenSize) {
  if (action.normalizedPoint) {
    return {
      x: Math.round(action.normalizedPoint.x * screen.width),
      y: Math.round(action.normalizedPoint.y * screen.height),
    };
  }
  const raw = pointFrom(action.params);
  if (!raw) return undefined;
  const recordedScreen = action.screenSize;
  if (!recordedScreen || (recordedScreen.width === screen.width && recordedScreen.height === screen.height)) return raw;
  return {
    x: Math.round((raw.x / Math.max(recordedScreen.width, 1)) * screen.width),
    y: Math.round((raw.y / Math.max(recordedScreen.height, 1)) * screen.height),
  };
}

function targetSemanticValues(target: RecordingActionTarget) {
  const values = new Set<string>();
  [target.name, target.label, target.value, target.placeholder, ...(target.contextLabels || [])].forEach((value) => {
    const normalizedValue = String(value || '').trim();
    if (normalizedValue) values.add(normalizedValue);
  });
  target.locators
    .filter((locator) => locator.strategy === 'accessibilityId')
    .forEach((locator) => values.add(locator.value));
  return values;
}

function replayQueryReference(target: ReplayTargetQuery, screen: RecordingScreenSize) {
  if (!target.coordinate) return undefined;
  return {
    x: target.coordinate.x * screen.width,
    y: target.coordinate.y * screen.height,
  };
}

function replayQueryScore(node: ParsedNode, target: ReplayTargetQuery) {
  let score = 0;
  const exact = (expected: string | undefined, values: Array<string | undefined>, weight: number) => {
    const value = String(expected || '').trim();
    if (value && values.some((candidate) => String(candidate || '').trim() === value)) score += weight;
  };
  exact(target.accessibilityId, [node.identifier, node.name], 220);
  exact(target.name, [node.name, node.identifier], 140);
  exact(target.label, [node.label, node.name], 140);
  exact(target.text, [node.value, node.label, node.name], 120);
  exact(target.placeholder, [node.placeholder], 140);
  if (target.type && node.type === target.type) score += 30;
  return score;
}

export function inspectReplayTarget(
  source: string,
  target: ReplayTargetQuery,
  screen: RecordingScreenSize,
  options: { visibleOnly?: boolean; enabledOnly?: boolean } = {},
): ReplayTargetInspection | undefined {
  const nodes = parseNodes(source);
  const reference = replayQueryReference(target, screen);
  const hasSemantic = Boolean(
    target.accessibilityId || target.name || target.label || target.text || target.placeholder
    || target.contextLabels?.some((value) => String(value || '').trim()),
  );
  const candidates = nodes
    .filter((node) => !options.visibleOnly || node.visible)
    .filter((node) => !options.enabledOnly || node.enabled)
    .map((node) => {
      let semanticScore = replayQueryScore(node, target);
      if (target.contextLabels?.length) {
        const center = { x: node.rect.x + node.rect.width / 2, y: node.rect.y + node.rect.height / 2 };
        const nearbyValues = nodes
          .filter((candidate) => {
            const candidateCenter = {
              x: candidate.rect.x + candidate.rect.width / 2,
              y: candidate.rect.y + candidate.rect.height / 2,
            };
            return Math.hypot(
              (candidateCenter.x - center.x) / Math.max(screen.width, 1),
              (candidateCenter.y - center.y) / Math.max(screen.height, 1),
            ) <= 0.25;
          })
          .flatMap((candidate) => [candidate.identifier, candidate.name, candidate.label, candidate.value, candidate.placeholder]);
        semanticScore += target.contextLabels.filter((label) => nearbyValues.includes(label)).length * 12;
      }
      const center = { x: node.rect.x + node.rect.width / 2, y: node.rect.y + node.rect.height / 2 };
      const distance = reference ? Math.hypot(
        (center.x - reference.x) / Math.max(screen.width, 1),
        (center.y - reference.y) / Math.max(screen.height, 1),
      ) : 0;
      const containsReference = reference ? contains(node.rect, reference) : false;
      return { node, semanticScore, distance, containsReference };
    })
    .filter((candidate) => hasSemantic ? candidate.semanticScore > 0 : candidate.containsReference)
    .sort((left, right) => (
      right.semanticScore - left.semanticScore
      || left.distance - right.distance
      || (left.node.rect.width * left.node.rect.height) - (right.node.rect.width * right.node.rect.height)
      || right.node.depth - left.node.depth
    ));
  const best = candidates[0];
  if (!best) return undefined;
  const relative = target.relativePoint || { x: 0.5, y: 0.5 };
  return {
    point: !hasSemantic && reference ? {
      x: Math.round(reference.x),
      y: Math.round(reference.y),
    } : {
      x: Math.round(best.node.rect.x + (Math.min(Math.max(relative.x, 0), 1) * best.node.rect.width)),
      y: Math.round(best.node.rect.y + (Math.min(Math.max(relative.y, 0), 1) * best.node.rect.height)),
    },
    strategy: hasSemantic ? 'semantic' : 'coordinate',
    type: best.node.type,
    identifier: best.node.identifier,
    name: best.node.name,
    label: best.node.label,
    value: best.node.value,
    placeholder: best.node.placeholder,
    rect: best.node.rect,
    visible: best.node.visible,
    enabled: best.node.enabled,
    semanticScore: best.semanticScore,
    distance: Number(best.distance.toFixed(6)),
  };
}

function nodeSemanticScore(node: ParsedNode, target: RecordingActionTarget, semanticValues: Set<string>) {
  const nodeValues = [node.identifier, node.name, node.label, node.value, node.placeholder]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const exactMatches = nodeValues.filter((value) => semanticValues.has(value));
  if (!exactMatches.length) return 0;
  let score = 100 + (exactMatches.length * 10);
  if (node.type === target.type) score += 25;
  if (node.identifier && semanticValues.has(node.identifier)) score += 25;
  if (node.name && (node.name === target.name || node.name === target.label)) score += 15;
  return score;
}

export function resolveReplayTapPoint(
  action: RecordingAction,
  currentSource: string,
  screen: RecordingScreenSize,
): ResolvedReplayPoint | undefined {
  const fallback = fallbackReplayPoint(action, screen);
  const target = action.target;
  if (!target) return fallback ? { point: fallback, strategy: 'coordinate' } : undefined;
  const semanticValues = targetSemanticValues(target);
  if (!semanticValues.size) return fallback ? { point: fallback, strategy: 'coordinate' } : undefined;
  const reference = fallback || {
    x: ((target.rect.x + (target.rect.width / 2)) / Math.max(action.screenSize?.width || screen.width, 1)) * screen.width,
    y: ((target.rect.y + (target.rect.height / 2)) / Math.max(action.screenSize?.height || screen.height, 1)) * screen.height,
  };
  const candidates = parseNodes(currentSource)
    .filter((node) => node.visible && node.enabled)
    .map((node) => {
      const semanticScore = nodeSemanticScore(node, target, semanticValues);
      const center = { x: node.rect.x + (node.rect.width / 2), y: node.rect.y + (node.rect.height / 2) };
      const distance = Math.hypot(
        (center.x - reference.x) / Math.max(screen.width, 1),
        (center.y - reference.y) / Math.max(screen.height, 1),
      );
      return { node, semanticScore, distance };
    })
    .filter((candidate) => candidate.semanticScore > 0)
    .sort((left, right) => (
      right.semanticScore - left.semanticScore
      || left.distance - right.distance
      || (left.node.rect.width * left.node.rect.height) - (right.node.rect.width * right.node.rect.height)
      || right.node.depth - left.node.depth
    ));
  const best = candidates[0];
  if (!best) return fallback ? { point: fallback, strategy: 'coordinate' } : undefined;
  const relative = target.relativePoint || { x: 0.5, y: 0.5 };
  const point = {
    x: Math.round(best.node.rect.x + (Math.min(Math.max(relative.x, 0), 1) * best.node.rect.width)),
    y: Math.round(best.node.rect.y + (Math.min(Math.max(relative.y, 0), 1) * best.node.rect.height)),
  };
  return {
    point,
    strategy: 'semantic',
    matchedTarget: targetAtPoint(currentSource, point, screen) || actionTarget(best.node, point, screen),
    distance: Number(best.distance.toFixed(6)),
  };
}

export function enrichRecordingAction(
  action: Pick<RecordingAction, 'type' | 'params'>,
  source: string,
  screen: RecordingScreenSize,
): RecordingAction {
  const enriched: RecordingAction = { ...action, params: { ...action.params }, screenSize: screen };
  if (action.type === 'tap') {
    const point = pointFrom(action.params);
    if (point) {
      enriched.normalizedPoint = normalized(point, screen);
      enriched.target = targetAtPoint(source, point, screen);
    }
  } else if (action.type === 'swipe') {
    const start = pointFrom(action.params.start);
    const end = pointFrom(action.params.end);
    if (start) {
      enriched.normalizedStart = normalized(start, screen);
      enriched.startTarget = targetAtPoint(source, start, screen);
    }
    if (end) {
      enriched.normalizedEnd = normalized(end, screen);
      enriched.endTarget = targetAtPoint(source, end, screen);
    }
  } else if (action.type === 'input') {
    enriched.target = focusedInputTarget(source, screen);
  }
  return enriched;
}
