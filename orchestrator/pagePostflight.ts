import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type PagePostflightErrorCode =
  | "INVALID_CONFIGURATION"
  | "GIT_SCOPE_VIOLATION"
  | "SOURCE_MEDIA_VIOLATION"
  | "SOURCE_INLINE_MEDIA_VIOLATION"
  | "SOURCE_SYMLINK_VIOLATION"
  | "SOURCE_EXECUTION_VIOLATION"
  | "SOURCE_SNAPSHOT_VIOLATION"
  | "RENDERED_IMAGE_VIOLATION";

export class PagePostflightError extends Error {
  readonly name = "PagePostflightError";

  constructor(
    readonly code: PagePostflightErrorCode,
    readonly violations: string[],
    message: string,
  ) {
    super(message);
  }
}

function portableRepoPath(value: string): string | null {
  if (!value || value.includes("\0")) return null;

  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) return null;

  const rawSegments = portable.split("/");
  if (rawSegments.includes("..")) return null;

  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

/**
 * Assert that Git only reports changes inside the generated page's source and
 * public asset folders. Prefix matching is segment-aware, so `page-copy/`
 * cannot masquerade as `page/`.
 */
export function assertOnlyAllowedGitPaths(
  gitPaths: readonly string[],
  allowedPrefixes: readonly string[],
): string[] {
  const prefixes = allowedPrefixes.map((prefix) => portableRepoPath(prefix));
  if (prefixes.length === 0 || prefixes.some((prefix) => prefix === null)) {
    throw new PagePostflightError(
      "INVALID_CONFIGURATION",
      [...allowedPrefixes],
      "Allowed Git prefixes must be non-empty relative repository paths.",
    );
  }

  const normalizedPrefixes = prefixes.map((prefix) => prefix!.replace(/\/$/, ""));
  const normalizedPaths: string[] = [];
  const violations: string[] = [];

  for (const gitPath of gitPaths) {
    const normalized = portableRepoPath(gitPath);
    if (
      !normalized ||
      !normalizedPrefixes.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
      )
    ) {
      violations.push(normalized ?? gitPath);
      continue;
    }
    normalizedPaths.push(normalized);
  }

  if (violations.length > 0) {
    throw new PagePostflightError(
      "GIT_SCOPE_VIOLATION",
      violations,
      `Generated page changed files outside its allowed scope: ${violations.join(", ")}`,
    );
  }

  return normalizedPaths;
}

const EMBEDDED_MEDIA_EXTENSIONS = new Set([
  // Raster images
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  // Vector images
  ".svg",
  // Video
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".webm",
  // Fonts
  ".eot",
  ".otf",
  ".ttc",
  ".ttf",
  ".woff",
  ".woff2",
]);
const TEXT_SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".json", ".scss", ".ts", ".tsx"]);
const INLINE_MEDIA_RE = /(?:data\s*:\s*(?:image|video|audio|font)\/|blob\s*:)/i;
const REMOTE_CSS_RESOURCE_RE = /(?:@import\s+(?:url\s*\()?\s*["']?https?:|url\s*\(\s*["']?(?:https?:)?\/\/)/i;
const ALLOWED_PAGE_SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".json", ".md", ".scss", ".ts", ".tsx"]);
const EXECUTABLE_ROUTE_RE = /^(?:route|middleware|proxy|instrumentation)\.(?:[cm]?[jt]sx?)$/i;
const UNSAFE_PAGE_SOURCE_PATTERNS = [
  /["']use server["']/i,
  /\b(?:child_process|worker_threads|cluster|node:|process\s*[.[]|server-only)\b/i,
  /\b(?:require|eval)\s*\(/i,
  /\bnew\s+Function\b/i,
  /\bimport\s*\(/i,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/i,
  /dangerouslySetInnerHTML/i,
  /<(?:script|iframe|object|embed)\b/i,
  /from\s+["']next\/server["']/i,
  /@import\s+(?:url\s*\()?\s*["']?https?:/i,
] as const;
const ALLOWED_BARE_IMPORTS = new Set([
  "framer-motion",
  "next/image",
  "next/link",
  "react",
]);
const MAX_PAGE_SOURCE_FILES = 256;
const MAX_PAGE_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_PAGE_SOURCE_TOTAL_BYTES = 5 * 1024 * 1024;
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const SHA256_RE = /^[a-f0-9]{64}$/;

const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const BANNED_IDENTIFIERS = new Set([
  "AsyncFunction",
  "Atomics",
  "BroadcastChannel",
  "Buffer",
  "Bun",
  "SharedArrayBuffer",
  "Deno",
  "EventSource",
  "FileReader",
  "Function",
  "GeneratorFunction",
  "MessageChannel",
  "MessagePort",
  "Notification",
  "Proxy",
  "Reflect",
  "RTCPeerConnection",
  "SharedWorker",
  "WebAssembly",
  "WebTransport",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "alert",
  "atob",
  "btoa",
  "cancelAnimationFrame",
  "cancelIdleCallback",
  "confirm",
  "document",
  "eval",
  "fetch",
  "global",
  "globalThis",
  "localStorage",
  "module",
  "navigator",
  "postMessage",
  "print",
  "process",
  "prompt",
  "queueMicrotask",
  "require",
  "requestAnimationFrame",
  "requestIdleCallback",
  "sessionStorage",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "window",
]);
const BANNED_UNBOUND_GLOBAL_IDENTIFIERS = new Set([
  "caches",
  "crypto",
  "frames",
  "history",
  "indexedDB",
  "location",
  "open",
  "opener",
  "parent",
  "self",
  "top",
]);
const BANNED_PROPERTY_NAMES = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "appendChild",
  "apply",
  "assign",
  "bind",
  "callee",
  "caller",
  "call",
  "click",
  "contentDocument",
  "contentWindow",
  "cookie",
  "constructor",
  "create",
  "createElement",
  "createElementNS",
  "createObjectURL",
  "dangerouslySetInnerHTML",
  "defaultView",
  "defineProperties",
  "defineProperty",
  "document",
  "documentElement",
  "eval",
  "fetch",
  "formAction",
  "frameElement",
  "globalThis",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "indexedDB",
  "innerHTML",
  "insertAdjacentHTML",
  "insertBefore",
  "localStorage",
  "mainModule",
  "navigator",
  "opener",
  "outerHTML",
  "ownerDocument",
  "postMessage",
  "prototype",
  "removeChild",
  "replaceChildren",
  "requestSubmit",
  "require",
  "sendBeacon",
  "serviceWorker",
  "sessionStorage",
  "setAttribute",
  "setPrototypeOf",
  "srcdoc",
  "submit",
  "view",
  "window",
]);
const BANNED_DECLARED_PROPERTY_NAMES = new Set([
  "$$typeof",
  "__proto__",
  "constructor",
  "dangerouslySetInnerHTML",
  "prototype",
]);

const ALLOWED_REACT_IMPORTS = new Set([
  "CSSProperties",
  "ChangeEvent",
  "ComponentProps",
  "Dispatch",
  "FormEvent",
  "Fragment",
  "KeyboardEvent",
  "MouseEvent",
  "MutableRefObject",
  "ReactElement",
  "ReactNode",
  "RefObject",
  "SetStateAction",
  "createContext",
  "forwardRef",
  "memo",
  "startTransition",
  "useCallback",
  "useContext",
  "useEffect",
  "useId",
  "useLayoutEffect",
  "useMemo",
  "useReducer",
  "useRef",
  "useState",
  "useTransition",
]);
const ALLOWED_FRAMER_MOTION_IMPORTS = new Set([
  "AnimatePresence",
  "LayoutGroup",
  "MotionConfig",
  "Reorder",
  "motion",
  "useAnimation",
  "useInView",
  "useMotionValue",
  "useScroll",
  "useSpring",
  "useTransform",
]);

/**
 * Calls through arbitrary object properties are capability lookups in
 * JavaScript. Generated pages therefore get only small, data-oriented method
 * families plus harmless UI event/ref operations.
 */
const ALLOWED_MEMBER_CALLS = new Set([
  "abs",
  "at",
  "ceil",
  "charAt",
  "concat",
  "endsWith",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "flat",
  "flatMap",
  "floor",
  "focus",
  "forEach",
  "from",
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTime",
  "includes",
  "isArray",
  "join",
  "keys",
  "localeCompare",
  "map",
  "match",
  "matchAll",
  "max",
  "min",
  "now",
  "padEnd",
  "padStart",
  "preventDefault",
  "reduce",
  "reduceRight",
  "replace",
  "replaceAll",
  "reverse",
  "round",
  "scrollIntoView",
  "setDate",
  "setHours",
  "slice",
  "some",
  "sort",
  "split",
  "startsWith",
  "stopPropagation",
  "substring",
  "test",
  "toFixed",
  "toISOString",
  "toLocaleDateString",
  "toLocaleString",
  "toLocaleTimeString",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  "values",
]);
const BANNED_INTRINSIC_JSX_TAGS = new Set([
  "applet",
  "audio",
  "base",
  "embed",
  "foreignobject",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "object",
  "portal",
  "script",
  "source",
  "track",
  "video",
]);
const BANNED_JSX_ATTRIBUTES = new Set([
  "action",
  "dangerouslysetinnerhtml",
  "formaction",
  "srcdoc",
]);
const STATIC_URL_JSX_ATTRIBUTES = new Set(["href", "xlinkhref"]);
const UNSAFE_BROWSER_URL_RE = /^\s*(?:blob|data|javascript|vbscript)\s*:/i;

function scriptKindFor(extension: string): ts.ScriptKind {
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".ts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isUseClientDirective(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression) &&
    statement.expression.text === "use client";
}

function isAllowedTopLevelStatement(statement: ts.Statement, index: number): boolean {
  if (index === 0 && isUseClientDirective(statement)) return true;
  if (
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  ) {
    return true;
  }
  if (ts.isExportAssignment(statement)) {
    return ts.isIdentifier(statement.expression) ||
      ts.isFunctionExpression(statement.expression) ||
      ts.isArrowFunction(statement.expression);
  }
  return false;
}

function staticStringValue(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringValue(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return staticStringValue(node.expression);
  }
  return null;
}

function staticDeclarationName(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isMemberWrite(node: ts.PropertyAccessExpression): boolean {
  let current: ts.Expression = node;
  let parent = current.parent;
  while (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent)) &&
    parent.expression === current
  ) {
    current = parent;
    parent = current.parent;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    isAssignmentOperator(parent.operatorToken.kind)
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === current
  ) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  return ts.isDeleteExpression(parent) && parent.expression === current;
}

function isSafeTopLevelInitializer(node: ts.Expression): boolean {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((span) => isSafeTopLevelInitializer(span.expression));
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => (
      ts.isOmittedExpression(element) ||
      (ts.isSpreadElement(element)
        ? isSafeTopLevelInitializer(element.expression)
        : isSafeTopLevelInitializer(element))
    ));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isPropertyAssignment(property)) {
        return !ts.isComputedPropertyName(property.name) &&
          isSafeTopLevelInitializer(property.initializer);
      }
      if (ts.isShorthandPropertyAssignment(property)) return true;
      if (ts.isSpreadAssignment(property)) {
        return isSafeTopLevelInitializer(property.expression);
      }
      return ts.isMethodDeclaration(property) && !ts.isComputedPropertyName(property.name);
    });
  }
  if (ts.isPropertyAccessExpression(node)) {
    return isSafeTopLevelInitializer(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return isSafeTopLevelInitializer(node.operand);
  }
  if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) {
    return isSafeTopLevelInitializer(node.expression);
  }
  if (ts.isBinaryExpression(node)) {
    return !isAssignmentOperator(node.operatorToken.kind) &&
      node.operatorToken.kind !== ts.SyntaxKind.CommaToken &&
      isSafeTopLevelInitializer(node.left) &&
      isSafeTopLevelInitializer(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    return isSafeTopLevelInitializer(node.condition) &&
      isSafeTopLevelInitializer(node.whenTrue) &&
      isSafeTopLevelInitializer(node.whenFalse);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return isSafeTopLevelInitializer(node.expression);
  }
  return false;
}

function bindingNameContains(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  return name.elements.some((element) => (
    ts.isBindingElement(element) && bindingNameContains(element.name, target)
  ));
}

function importClauseDeclares(clause: ts.ImportClause | undefined, name: string): boolean {
  if (!clause) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => element.name.text === name);
}

function statementDeclares(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      bindingNameContains(declaration.name, name),
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return true;
  }
  return ts.isImportDeclaration(statement) && importClauseDeclares(statement.importClause, name);
}

function scopeDeclares(scope: ts.Node, name: string): boolean {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    return scope.statements.some((statement) => statementDeclares(statement, name));
  }
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some((parameter) => bindingNameContains(parameter.name, name))) {
      return true;
    }
    if (
      (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) &&
      scope.name?.text === name
    ) {
      return true;
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    return bindingNameContains(scope.variableDeclaration.name, name);
  }
  return false;
}

function isLexicallyBound(identifier: ts.Identifier): boolean {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    if (scopeDeclares(current, identifier.text)) return true;
    current = current.parent;
  }
  return false;
}

function isValueIdentifierReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) &&
      (parent.name === identifier || parent.propertyName === identifier)) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isFunctionExpression(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassExpression(parent) && parent.name === identifier) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isJsxAttribute(parent) ||
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxSelfClosingElement(parent) ||
    ts.isJsxClosingElement(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  ) {
    return false;
  }

  let current: ts.Node | undefined = parent;
  while (current && !ts.isExpression(current) && !ts.isStatement(current)) {
    if (ts.isTypeNode(current)) return false;
    current = current.parent;
  }
  return true;
}

function localModuleStaysInsidePage(specifier: string, filename: string): boolean {
  if (
    (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
    specifier.includes("\\") ||
    specifier.includes("\0") ||
    specifier.includes("?") ||
    specifier.includes("#")
  ) {
    return false;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(filename), specifier),
  );
  return resolved !== ".." && !resolved.startsWith("../") && !path.posix.isAbsolute(resolved);
}

function allowedBareImportShape(node: ts.ImportDeclaration, specifier: string): boolean {
  const clause = node.importClause;
  if (!clause) return false;

  if (specifier === "next/image" || specifier === "next/link") {
    return Boolean(clause.name) && !clause.namedBindings;
  }

  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }
  const allowed = specifier === "react"
    ? ALLOWED_REACT_IMPORTS
    : ALLOWED_FRAMER_MOTION_IMPORTS;
  return clause.namedBindings.elements.every((element) => {
    const importedName = element.propertyName?.text ?? element.name.text;
    return allowed.has(importedName);
  });
}

function importDeclarationViolation(
  node: ts.ImportDeclaration,
  filename: string,
): string | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return "non-literal-import";
  const specifier = node.moduleSpecifier.text;
  if (ALLOWED_BARE_IMPORTS.has(specifier)) {
    return allowedBareImportShape(node, specifier) ? undefined : "unsafe-import-binding";
  }
  return localModuleStaysInsidePage(specifier, filename)
    ? undefined
    : `unsafe-import:${specifier}`;
}

interface SafeJsxBindings {
  components: Set<string>;
  namespaces: Set<string>;
}

function collectSafeJsxBindings(sourceFile: ts.SourceFile): SafeJsxBindings {
  const components = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause;
      if (clause?.name) components.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          if (
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === "framer-motion" &&
            importedName === "motion"
          ) {
            namespaces.add(element.name.text);
          } else {
            components.add(element.name.text);
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      components.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          components.add(declaration.name.text);
        }
      }
    }
  }
  return { components, namespaces };
}

function jsxTagViolation(
  tagName: ts.JsxTagNameExpression,
  bindings: SafeJsxBindings,
): string | undefined {
  if (ts.isIdentifier(tagName)) {
    const name = tagName.text;
    if (/^[a-z]/.test(name) || name.includes("-")) {
      return BANNED_INTRINSIC_JSX_TAGS.has(name.toLowerCase())
        ? `jsx-tag:${name}`
        : undefined;
    }
    return bindings.components.has(name) ? undefined : `dynamic-jsx-tag:${name}`;
  }
  if (ts.isPropertyAccessExpression(tagName)) {
    if (BANNED_INTRINSIC_JSX_TAGS.has(tagName.name.text.toLowerCase())) {
      return `jsx-tag:${tagName.name.text}`;
    }
    let root: ts.Expression = tagName.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return ts.isIdentifier(root) && bindings.namespaces.has(root.text)
      ? undefined
      : "dynamic-jsx-namespace";
  }
  return "unsafe-jsx-tag";
}

function jsxAttributeName(node: ts.JsxAttribute): string {
  if (ts.isIdentifier(node.name)) return node.name.text.toLowerCase();
  return `${node.name.namespace.text}${node.name.name.text}`.toLowerCase();
}

function staticJsxAttributeValue(node: ts.JsxAttribute): string | null {
  if (!node.initializer) return null;
  if (ts.isStringLiteral(node.initializer)) return node.initializer.text;
  if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    return staticStringValue(node.initializer.expression);
  }
  return null;
}

function objectSpreadIsStyleOrStatic(node: ts.SpreadAssignment): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxAttribute(current)) {
      // Spreading a named constant into any JSX prop (`style={{ ...BODY }}`,
      // `transition={{ ...TRANS, delay: 0.2 }}`) is static reuse, the idiom the
      // design system is built on. Only a computed spread source stays banned.
      return jsxAttributeName(current) === "style" || ts.isIdentifier(node.expression);
    }
    if (ts.isFunctionLike(current)) return false;
    if (ts.isVariableDeclaration(current)) {
      const declarationList = current.parent;
      const statement = declarationList.parent;
      return ts.isVariableDeclarationList(declarationList) &&
        ts.isVariableStatement(statement) &&
        ts.isSourceFile(statement.parent);
    }
    if (ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}

function runtimeFunctionIsDynamic(node: ts.Node): boolean {
  if (!(
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )) {
    return false;
  }
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const isAsync = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  const isGenerator = "asteriskToken" in node && Boolean(node.asteriskToken);
  return Boolean(isAsync || isGenerator);
}

/**
 * Parse generated JavaScript/TypeScript and apply a deliberately narrow client
 * component policy. This is defense in depth; the native process sandbox is
 * still the boundary that protects the host while Next compiles and renders it.
 */
function sourceAstViolations(source: string, filename: string, extension: string): string[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(extension),
  );
  const violations: string[] = [];
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) violations.push("parse-error");
  if (source.startsWith("#!")) violations.push("hashbang");
  if (
    sourceFile.referencedFiles.length > 0 ||
    sourceFile.typeReferenceDirectives.length > 0 ||
    sourceFile.libReferenceDirectives.length > 0 ||
    sourceFile.amdDependencies.length > 0
  ) {
    violations.push("source-reference");
  }
  if (!sourceFile.statements[0] || !isUseClientDirective(sourceFile.statements[0])) {
    violations.push("missing-use-client");
  }
  sourceFile.statements.forEach((statement, index) => {
    if (!isAllowedTopLevelStatement(statement, index)) violations.push("top-level-execution");
    if (ts.isImportDeclaration(statement)) {
      const issue = importDeclarationViolation(statement, filename);
      if (issue) violations.push(issue);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      violations.push("re-export");
    }
    if (ts.isVariableStatement(statement)) {
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        violations.push("top-level-mutable-state");
      }
      if (statement.declarationList.declarations.some((declaration) => (
        declaration.initializer && !isSafeTopLevelInitializer(declaration.initializer)
      ))) {
        violations.push("top-level-initializer");
      }
    }
  });

  const jsxBindings = collectSafeJsxBindings(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
      violations.push(`identifier:${node.text}`);
    }
    if (
      ts.isIdentifier(node) &&
      BANNED_UNBOUND_GLOBAL_IDENTIFIERS.has(node.text) &&
      isValueIdentifierReference(node) &&
      !isLexicallyBound(node)
    ) {
      violations.push(`global:${node.text}`);
    }
    if (ts.isElementAccessExpression(node)) {
      // A literal index (`row[0]`, `labels["he"]`) is as static as dot access;
      // only a computed key can reach a property the analyser cannot see.
      const argument = node.argumentExpression;
      if (ts.isNumericLiteral(argument)) {
        // static, nothing to check
      } else if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        if (BANNED_PROPERTY_NAMES.has(argument.text)) violations.push(`property:${argument.text}`);
      } else {
        violations.push("computed-member-access");
      }
    }
    if (ts.isComputedPropertyName(node)) {
      const expression = node.expression;
      if (ts.isNumericLiteral(expression)) {
        // static
      } else if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        if (BANNED_DECLARED_PROPERTY_NAMES.has(expression.text) || BANNED_PROPERTY_NAMES.has(expression.text)) {
          violations.push(`declared-property:${expression.text}`);
        }
      } else {
        violations.push("computed-member-access");
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (BANNED_PROPERTY_NAMES.has(node.name.text)) {
        violations.push(`property:${node.name.text}`);
      }
      if (isMemberWrite(node)) violations.push("member-mutation");
    }
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      BANNED_DECLARED_PROPERTY_NAMES.has(staticDeclarationName(node.name) ?? "")
    ) {
      violations.push(`declared-property:${staticDeclarationName(node.name)}`);
    }
    if (
      ts.isBindingElement(node) &&
      BANNED_PROPERTY_NAMES.has(
        staticDeclarationName(node.propertyName ?? node.name) ?? "",
      )
    ) {
      violations.push(
        `binding-property:${staticDeclarationName(node.propertyName ?? node.name)}`,
      );
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        violations.push("dynamic-import");
      } else if (ts.isIdentifier(node.expression)) {
        if (jsxBindings.namespaces.has(node.expression.text)) {
          violations.push(`namespace-call:${node.expression.text}`);
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        if (!ALLOWED_MEMBER_CALLS.has(node.expression.name.text)) {
          violations.push(`member-call:${node.expression.name.text}`);
        }
      } else {
        violations.push("dynamic-call-target");
      }
    }
    if (ts.isNewExpression(node)) {
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "Date") {
        violations.push("dynamic-construction");
      }
    }
    if (
      ts.isMetaProperty(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      ts.isExternalModuleReference(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isWithStatement(node) ||
      ts.isDebuggerStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isLabeledStatement(node) ||
      ts.isCommaListExpression(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isDecorator(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.SuperKeyword
    ) {
      violations.push("unsafe-syntax");
    }
    if (ts.isJsxSpreadAttribute(node) && !ts.isIdentifier(node.expression)) {
      // `{...FADE_UP}` with a named constant is the same static reuse allowed
      // for object spread inside a prop; only a computed source stays banned.
      violations.push("unsafe-syntax");
    }
    if (ts.isSpreadAssignment(node) && !objectSpreadIsStyleOrStatic(node)) {
      violations.push("dynamic-object-spread");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      violations.push("comma-operator");
    }
    if (runtimeFunctionIsDynamic(node)) violations.push("dynamic-function");
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    ) {
      const issue = jsxTagViolation(node.tagName, jsxBindings);
      if (issue) violations.push(issue);
    }
    if (ts.isJsxAttribute(node)) {
      const name = jsxAttributeName(node);
      if (BANNED_JSX_ATTRIBUTES.has(name)) {
        violations.push(`jsx-attribute:${name}`);
      }
      if (STATIC_URL_JSX_ATTRIBUTES.has(name)) {
        const value = staticJsxAttributeValue(node);
        if (value === null) violations.push(`dynamic-url:${name}`);
        else if (UNSAFE_BROWSER_URL_RE.test(value)) violations.push(`unsafe-url:${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(violations)];
}

function portableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

interface InspectedPageSourceTree {
  files: string[];
  hashes: Record<string, string>;
}

async function readOpenedSourceFile(
  absolutePath: string,
): Promise<{ bytes: Buffer; size: number }> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | NO_FOLLOW | (fsConstants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PAGE_SOURCE_FILE_BYTES) {
      throw new Error("not a bounded regular file");
    }

    // Read exactly the size that was bounded above, then probe once for a
    // concurrent append. Validation and hashing both consume this same Buffer.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) throw new Error("source changed while being read");
      offset += result.bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, null);
    const after = await handle.stat();
    if (
      extra.bytesRead !== 0
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      throw new Error("source changed while being read");
    }
    return { bytes, size: before.size };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Recursively inspect a generated `src/app/<slug>` directory. Media belongs
 * in `public/<slug>`, never beside executable source, and symlinks are refused
 * so the generated tree cannot escape its reviewed boundary.
 */
async function inspectPageSourceTree(
  pageSourceDir: string,
): Promise<InspectedPageSourceTree> {
  const rootStat = await fs.lstat(pageSourceDir);
  if (rootStat.isSymbolicLink()) {
    throw new PagePostflightError(
      "SOURCE_SYMLINK_VIOLATION",
      ["."],
      "The generated page source directory cannot be a symbolic link.",
    );
  }
  if (!rootStat.isDirectory()) {
    throw new PagePostflightError(
      "INVALID_CONFIGURATION",
      [pageSourceDir],
      "The generated page source path is not a directory.",
    );
  }

  const safeFiles: string[] = [];
  const hashes: Record<string, string> = {};
  const mediaFiles: string[] = [];
  const symlinks: string[] = [];
  const inlineMediaFiles: string[] = [];
  const executionViolations: string[] = [];
  const executionDetails: string[] = [];
  let totalSourceBytes = 0;

  const walk = async (currentDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = portableRelativePath(path.relative(pageSourceDir, absolutePath));
      const stat = await fs.lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        symlinks.push(relativePath);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        executionViolations.push(relativePath);
        continue;
      }

      if (safeFiles.length + mediaFiles.length >= MAX_PAGE_SOURCE_FILES) {
        executionViolations.push(relativePath);
        continue;
      }

      if (EMBEDDED_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        mediaFiles.push(relativePath);
      } else {
        safeFiles.push(relativePath);
        const extension = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_PAGE_SOURCE_EXTENSIONS.has(extension) || EXECUTABLE_ROUTE_RE.test(entry.name)) {
          executionViolations.push(relativePath);
          continue;
        }
        let snapshot: Awaited<ReturnType<typeof readOpenedSourceFile>>;
        try {
          snapshot = await readOpenedSourceFile(absolutePath);
        } catch {
          executionViolations.push(relativePath);
          continue;
        }
        totalSourceBytes += snapshot.size;
        if (totalSourceBytes > MAX_PAGE_SOURCE_TOTAL_BYTES) {
          executionViolations.push(relativePath);
          continue;
        }
        hashes[relativePath] = createHash("sha256").update(snapshot.bytes).digest("hex");
        if (TEXT_SOURCE_EXTENSIONS.has(extension)) {
          const source = snapshot.bytes.toString("utf8");
          if (INLINE_MEDIA_RE.test(source)) inlineMediaFiles.push(relativePath);
          if ((extension === ".css" || extension === ".scss") && REMOTE_CSS_RESOURCE_RE.test(source)) {
            executionViolations.push(relativePath);
          }
          if (UNSAFE_PAGE_SOURCE_PATTERNS.some((pattern) => pattern.test(source))) {
            executionViolations.push(relativePath);
          }
          if (SCRIPT_EXTENSIONS.has(extension)) {
            const kinds = [...new Set(sourceAstViolations(source, relativePath, extension))];
            if (kinds.length > 0) {
              executionViolations.push(relativePath);
              executionDetails.push(`${relativePath}: ${kinds.join(", ")}`);
            }
          }
        }
      }
    }
  };

  await walk(pageSourceDir);
  symlinks.sort();
  mediaFiles.sort();
  inlineMediaFiles.sort();
  safeFiles.sort();
  executionViolations.sort();

  if (symlinks.length > 0) {
    throw new PagePostflightError(
      "SOURCE_SYMLINK_VIOLATION",
      symlinks,
      `Generated page source contains symbolic links: ${symlinks.join(", ")}`,
    );
  }
  if (mediaFiles.length > 0) {
    throw new PagePostflightError(
      "SOURCE_MEDIA_VIOLATION",
      mediaFiles,
      `Generated page source contains embedded media: ${mediaFiles.join(", ")}`,
    );
  }
  if (inlineMediaFiles.length > 0) {
    throw new PagePostflightError(
      "SOURCE_INLINE_MEDIA_VIOLATION",
      inlineMediaFiles,
      `Generated page source embeds data/blob media: ${inlineMediaFiles.join(", ")}`,
    );
  }
  if (executionViolations.length > 0) {
    const violations = [...new Set(executionViolations)];
    const detail = executionDetails.length > 0 ? executionDetails.join("; ") : violations.join(", ");
    throw new PagePostflightError(
      "SOURCE_EXECUTION_VIOLATION",
      violations,
      `Generated page source contains server-side, network-capable, or executable content: ${detail}`,
    );
  }

  return { files: safeFiles, hashes };
}

export async function assertPageSourceHasNoEmbeddedMedia(
  pageSourceDir: string,
): Promise<string[]> {
  return (await inspectPageSourceTree(pageSourceDir)).files;
}

/**
 * Seal every reviewed source byte so the page approved in 5.3 cannot be
 * silently edited between preview, human approval and Git delivery.
 */
export async function sealPageSourceTree(
  pageSourceDir: string,
): Promise<Record<string, string>> {
  const snapshot = await inspectPageSourceTree(pageSourceDir);
  if (snapshot.files.length === 0) {
    throw new PagePostflightError(
      "SOURCE_SNAPSHOT_VIOLATION",
      ["."],
      "The generated page source tree is empty.",
    );
  }

  return snapshot.hashes;
}

export async function assertPageSourceMatchesSeal(
  pageSourceDir: string,
  expected: Readonly<Record<string, string>>,
): Promise<void> {
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  );
  if (
    expectedEntries.length === 0
    || expectedEntries.some(([file, hash]) => portableRepoPath(file) !== file || !SHA256_RE.test(hash))
  ) {
    throw new PagePostflightError(
      "INVALID_CONFIGURATION",
      expectedEntries.map(([file]) => file),
      "The approved page source seal is invalid.",
    );
  }

  const actual = await sealPageSourceTree(pageSourceDir);
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  );
  const expectedSerialized = JSON.stringify(expectedEntries);
  const actualSerialized = JSON.stringify(actualEntries);
  if (actualSerialized !== expectedSerialized) {
    const files = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    throw new PagePostflightError(
      "SOURCE_SNAPSHOT_VIOLATION",
      files,
      "Generated page source no longer matches the approved snapshot.",
    );
  }
}

export interface RenderedImageValidationOptions {
  /** The rendered page URL. Its origin is the only allowed origin. */
  pageUrl: string;
  slug: string;
  /** Portable filenames only, never absolute paths from the producing machine. */
  approvedBasenames: readonly string[];
}

const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isPortableBasename(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(value) &&
    !/[. ]$/.test(value) &&
    !WINDOWS_RESERVED_BASENAME.test(value)
  );
}

function decodeUrlPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new Error("URL path is not valid percent-encoding");
  }
}

function assertHttpSameOrigin(candidate: URL, page: URL): void {
  if (
    (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
    candidate.origin !== page.origin ||
    candidate.username !== "" ||
    candidate.password !== ""
  ) {
    throw new Error("Rendered image is not a same-origin HTTP URL");
  }
}

function canonicalApprovedAssetPath(
  rawImageUrl: string,
  page: URL,
  slug: string,
  approved: ReadonlySet<string>,
): string {
  if (!rawImageUrl || rawImageUrl !== rawImageUrl.trim()) {
    throw new Error("Rendered image URL is empty or padded with whitespace");
  }

  const outer = new URL(rawImageUrl, page);
  assertHttpSameOrigin(outer, page);
  if (outer.hash) throw new Error("Rendered image URL cannot contain a fragment");

  let asset = outer;
  if (decodeUrlPath(outer.pathname) === "/_next/image") {
    const optimizerTargets = outer.searchParams.getAll("url");
    if (optimizerTargets.length !== 1 || !optimizerTargets[0]) {
      throw new Error("Next image optimizer URL must contain exactly one image target");
    }
    asset = new URL(optimizerTargets[0], page);
    assertHttpSameOrigin(asset, page);
  } else if (outer.search) {
    throw new Error("Direct rendered image URL cannot contain a query string");
  }

  if (asset.search || asset.hash) {
    throw new Error("Approved asset target cannot contain a query string or fragment");
  }

  const decodedPath = decodeUrlPath(asset.pathname);
  const expectedPrefix = `/${slug}/`;
  if (!decodedPath.startsWith(expectedPrefix)) {
    throw new Error("Rendered image is outside the generated page public folder");
  }

  const basename = decodedPath.slice(expectedPrefix.length);
  if (!isPortableBasename(basename) || !approved.has(basename)) {
    throw new Error("Rendered image basename was not approved");
  }

  return `${expectedPrefix}${basename}`;
}

/**
 * The approved basename a rendered image URL points at, or null. Uses the exact
 * normalization the asset-source check uses (same origin, the page's own public
 * folder, Next's optimizer target, exact basename), so `other-hero.webp` can
 * never satisfy `hero.webp`.
 */
export function approvedAssetBasename(
  rawImageUrl: string,
  pageUrl: string,
  slug: string,
  approved: ReadonlySet<string>,
): string | null {
  try {
    const canonical = canonicalApprovedAssetPath(rawImageUrl, new URL(pageUrl), slug, approved);
    return canonical.slice(`/${slug}/`.length);
  } catch {
    return null;
  }
}

/** Order-independent digest of a sealed page source tree (path to sha256). */
export function hashPageSourceManifest(entries: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}

function isKnownTelemetryPixel(rawImageUrl: string): boolean {
  try {
    const url = new URL(rawImageUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.facebook.com" &&
      (url.pathname === "/tr" || url.pathname === "/tr/") &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      /^\d+$/.test(url.searchParams.get("id") ?? "") &&
      url.searchParams.has("ev")
    );
  } catch {
    return false;
  }
}

/**
 * Validate the image URLs observed in the rendered page. Direct URLs and the
 * target hidden inside Next's image optimizer must resolve to an approved
 * basename under this page's own public folder on the page's own origin.
 */
export function assertRenderedImageUrls(
  imageUrls: readonly string[],
  options: RenderedImageValidationOptions,
): string[] {
  let page: URL;
  try {
    page = new URL(options.pageUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:") throw new Error();
  } catch {
    throw new PagePostflightError(
      "INVALID_CONFIGURATION",
      [options.pageUrl],
      "pageUrl must be an absolute HTTP or HTTPS URL.",
    );
  }

  if (!isPortableBasename(options.slug)) {
    throw new PagePostflightError(
      "INVALID_CONFIGURATION",
      [options.slug],
      "The page slug must be one portable path segment.",
    );
  }

  const invalidBasenames = options.approvedBasenames.filter(
    (basename) => !isPortableBasename(basename),
  );
  if (invalidBasenames.length > 0) {
    throw new PagePostflightError(
      "INVALID_CONFIGURATION",
      invalidBasenames,
      "Approved image names must be portable basenames, not machine-specific paths.",
    );
  }

  const approved = new Set(options.approvedBasenames);
  const canonicalPaths: string[] = [];
  const violations: string[] = [];

  for (const imageUrl of imageUrls) {
    // Meta Pixel emits a 1x1 measurement request whose browser resource type is
    // "image". It is telemetry, not page artwork, so permit only its exact
    // HTTPS endpoint shape. Every other remote image remains forbidden.
    if (isKnownTelemetryPixel(imageUrl)) continue;
    try {
      canonicalPaths.push(
        canonicalApprovedAssetPath(imageUrl, page, options.slug, approved),
      );
    } catch {
      violations.push(imageUrl);
    }
  }

  if (violations.length > 0) {
    throw new PagePostflightError(
      "RENDERED_IMAGE_VIOLATION",
      violations,
      `Rendered page uses unapproved image URLs: ${violations.join(", ")}`,
    );
  }

  return canonicalPaths;
}
