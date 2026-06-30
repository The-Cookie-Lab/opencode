export * as ToolOutput from "./tool-output"
export { ToolContent as Content, ToolFileContent as FileContent, ToolTextContent as TextContent } from "@opencode-ai/llm"
import type { ToolFileContent, ToolTextContent } from "@opencode-ai/llm"
import { Schema } from "effect"

export const Structured = Schema.Record(Schema.String, Schema.Any)

export const text = (input: ToolTextContent): ToolTextContent => input

export const file = (input: ToolFileContent): ToolFileContent => input
