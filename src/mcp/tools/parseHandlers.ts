import fs from "fs"
import path from "path"
import ts from "typescript"

export type HandlerKind = "query" | "mutation" | "internalQuery" | "internalMutation"

export type HandlerEntry = {
  name: string
  kind: HandlerKind
  file: string
  line: number
  argsText?: string
}

export type ModelEntry = {
  name: string
  file: string
  line: number
  schemaText?: string
  indexesText?: string
}

const HANDLER_FNS = new Set<HandlerKind>(["query", "mutation", "internalQuery", "internalMutation"])

export function listHandlerFiles(cwd: string): string[] {
  const dir = path.join(cwd, "mogobase")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => path.join(dir, f))
}

function getLine(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1
}

function getText(source: ts.SourceFile, node: ts.Node): string {
  return source.getFullText().slice(node.getStart(source), node.getEnd()).trim()
}

function collectConstBindings(source: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const init = decl.initializer
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        bindings.set(decl.name.text, init.text)
      }
    }
  }
  return bindings
}

function resolveName(node: ts.Node, bindings: Map<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return bindings.get(node.text)
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text
    for (const span of node.templateSpans) {
      const expr = span.expression
      let piece: string | undefined
      if (ts.isIdentifier(expr)) piece = bindings.get(expr.text)
      else if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) piece = expr.text
      if (piece === undefined) return undefined
      out += piece + span.literal.text
    }
    return out
  }
  return undefined
}

function extractConfigFields(
  source: ts.SourceFile,
  arg: ts.Node
): { argsText?: string; schemaText?: string; indexesText?: string; handlerPresent?: boolean } {
  if (!ts.isObjectLiteralExpression(arg)) return {}
  const out: { argsText?: string; schemaText?: string; indexesText?: string; handlerPresent?: boolean } = {}
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : undefined
    if (!name) continue
    const valueText = getText(source, prop.initializer)
    if (name === "args") out.argsText = valueText
    if (name === "schema") out.schemaText = valueText
    if (name === "indexSpecs") out.indexesText = valueText
    if (name === "handler") out.handlerPresent = true
  }
  return out
}

export function parseHandlersInFile(filePath: string, cwd: string): { handlers: HandlerEntry[]; models: ModelEntry[] } {
  const text = fs.readFileSync(filePath, "utf8")
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const handlers: HandlerEntry[] = []
  const models: ModelEntry[] = []
  const relFile = path.relative(cwd, filePath)
  const bindings = collectConstBindings(source)

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text
      const [first, second] = node.arguments

      if (HANDLER_FNS.has(fn as HandlerKind) && first) {
        const name = resolveName(first, bindings) ?? getText(source, first)
        const config = second ? extractConfigFields(source, second) : {}
        handlers.push({
          name,
          kind: fn as HandlerKind,
          file: relFile,
          line: getLine(source, node.getStart(source)),
          argsText: config.argsText,
        })
      }

      if (fn === "defineModel" && first) {
        const name = resolveName(first, bindings) ?? getText(source, first)
        models.push({
          name,
          file: relFile,
          line: getLine(source, node.getStart(source)),
          schemaText: second ? getText(source, second) : undefined,
          indexesText: node.arguments[2] ? getText(source, node.arguments[2]) : undefined,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return { handlers, models }
}

export function parseAllHandlers(cwd: string): { handlers: HandlerEntry[]; models: ModelEntry[] } {
  const files = listHandlerFiles(cwd)
  const handlers: HandlerEntry[] = []
  const models: ModelEntry[] = []
  for (const f of files) {
    const { handlers: h, models: m } = parseHandlersInFile(f, cwd)
    handlers.push(...h)
    models.push(...m)
  }
  return { handlers, models }
}
